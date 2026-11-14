import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfMergeStoppedDestination, selfMergeStopTarget } from "../src/app.ts";
import { GitHubCapabilityGrants } from "../src/github-capabilities.ts";
import { LifecycleNotificationService } from "../src/lifecycle-notification-service.ts";
import { type NotificationMode, parseNotificationMode } from "../src/notification-mode.ts";
import {
  DelegatingNotificationPayloadSender,
  NotificationOutboxService,
  OutboxLifecycleNotifier,
  OutboxWorkNotifier,
} from "../src/notification-outbox.ts";
import { NotificationThreadService } from "../src/notification-thread-service.ts";
import {
  LifecycleNotifierWithRequiredActionDm,
  RequiredActionDmService,
  WorkNotifierWithRequiredActionDm,
} from "../src/required-action-dm-service.ts";
import type {
  GitHubIssueContext,
  GitHubLifecycleClient,
  PullRequestReviewContext,
  ReviewRequestReadModel,
} from "../src/review-types.ts";
import {
  SlackDirectLifecycleNotifier,
  SlackDirectWorkNotifier,
} from "../src/slack-direct-notifier.ts";
import { SlackLifecycleNotifier } from "../src/slack-lifecycle-notifier.ts";
import { SlackReviewNotifier } from "../src/slack-review-notifier.ts";
import { SlackWorkNotifier } from "../src/slack-work-notifier.ts";
import { LocalStateStore } from "../src/state-store.ts";
import type { HumanWorkItem } from "../src/types.ts";
import { WorkNotificationService } from "../src/work-notification-service.ts";

const CHANNEL = "CWORK";
const NOW = Date.parse("2026-08-02T00:00:00Z");

describe("AR_SLACK_NOTIFICATION_MODE", () => {
  test("未設定はthread、threadとdirectを受け付け、それ以外は拒否する", () => {
    expect(parseNotificationMode(undefined)).toBe("thread");
    expect(parseNotificationMode("")).toBe("thread");
    expect(parseNotificationMode("thread")).toBe("thread");
    expect(parseNotificationMode(" direct ")).toBe("direct");
    expect(() => parseNotificationMode("dm")).toThrow(
      "AR_SLACK_NOTIFICATION_MODEにはthreadまたはdirectを指定してください。",
    );
  });

  test("不正なモード値ではadapterの起動が失敗する", async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/start.ts")], {
      cwd: await mkdtemp(join(tmpdir(), "arttra-mode-")),
      env: { PATH: process.env.PATH ?? "", AR_SLACK_NOTIFICATION_MODE: "broadcast" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(
      "AR_SLACK_NOTIFICATION_MODEにはthreadまたはdirectを指定してください。",
    );
  });
});

describe("directモードのlifecycle通知", () => {
  test.each(["intake", "work", "task", "business"] as const)(
    "%sの作成はchannelへ投稿せず、作成時の担当者へDMを一件だけ送る",
    async (issueType) => {
      const harness = await createHarness();
      harness.github.issue = { ...harness.github.issue, labels: [`type/${issueType}`] };

      await harness.lifecycle.process(issueOpenedJob());
      await harness.lifecycle.process(issueOpenedJob("delivery-open-redelivered"));
      await harness.lifecycle.process(issueAssignedJob("requester", "owner"));

      expect(harness.channelPosts()).toHaveLength(0);
      expect(harness.dmRecipients()).toEqual(["DOWNER"]);
    },
  );

  test.each([
    {
      name: "CI失敗",
      job: () => checkRunFailedJob("author"),
      recipients: ["DAUTHOR", "DOWNER"],
    },
    { name: "差し戻し", job: () => changesRequestedJob(), recipients: ["DAUTHOR"] },
    {
      name: "差し戻し後の修正push",
      job: () => synchronizeJob("head-3"),
      recipients: ["DREVIEWER"],
    },
    { name: "Approve", job: () => approvedJob(), recipients: ["DAUTHOR"] },
    {
      name: "コメントのmention",
      job: () => issueCommentJob("確認してください @mentioned"),
      recipients: ["DMENTIONED"],
    },
    { name: "マージ", job: () => mergedJob(), recipients: [] },
    { name: "Issue close", job: () => issueClosedJob(), recipients: [] },
  ])("$nameはchannel/threadへ投稿せず、宛先へDMを一件ずつ送る", async ({ job, recipients }) => {
    const harness = await createHarness();

    await harness.lifecycle.process(job());
    await harness.lifecycle.process({ ...job(), deliveryId: "delivery-redelivered" });

    expect(harness.channelPosts()).toHaveLength(0);
    expect(harness.dmRecipients().sort()).toEqual([...recipients]);
  });

  test("同じ配線のthreadモードでは、従来どおり親投稿とthread返信を出す", async () => {
    const harness = await createHarness(GitHubCapabilityGrants.empty(), "thread");

    await harness.lifecycle.process(checkRunFailedJob("author"));

    const posts = harness.channelPosts();
    const rootTs = posts[0]?.ts ?? "";
    expect(posts.map((post) => post.thread_ts ?? null)).toEqual([null, rootTs, rootTs]);
    expect(harness.dmRecipients().sort()).toEqual(["DAUTHOR", "DOWNER"]);
  });

  test("処理済みstateが失われて再処理しても、同じDM intentへまとまり増えない", async () => {
    const harness = await createHarness();

    await harness.lifecycle.process(checkRunFailedJob("author"));
    for (const key of (await harness.store.listEntries("lifecycle-notification")).map(
      ({ key }) => key,
    )) {
      await harness.store.remove("lifecycle-notification", key);
    }
    await harness.lifecycle.process({ ...checkRunFailedJob("author"), deliveryId: "delivery-2" });

    expect(harness.dmRecipients().sort()).toEqual(["DAUTHOR", "DOWNER"]);
  });

  test("セルフマージ予定は停止ボタン付きのchannel単独投稿にし、CI通過通知は出さない", async () => {
    // directモードではthreadがないため、展開抑止の権限があっても停止の機会を残す。
    const harness = await createHarness(
      GitHubCapabilityGrants.fromJson(
        JSON.stringify({ suppress_self_merge_channel_broadcast: ["requester"] }),
      ),
    );
    harness.github.issue = { ...harness.github.issue, labels: ["type/task", "merge/self"] };
    harness.github.pullRequest = {
      ...harness.github.pullRequest,
      linkedIssues: [harness.github.issue],
    };

    await harness.lifecycle.process(issueOpenedJob());
    await harness.lifecycle.process(selfMergeLabeledJob("requester"));
    await harness.lifecycle.process(checkSuiteSucceededJob());

    const posts = harness.channelPosts();
    expect(posts).toHaveLength(1);
    const warning = posts[0];
    if (!warning) throw new Error("セルフマージ警告が必要です");
    expect(warning.thread_ts).toBeUndefined();
    expect(warning.reply_broadcast).toBeUndefined();
    expect(JSON.stringify(warning.blocks)).toContain("セルフマージ予定");
    const button = findButton(warning, "ar.self-merge.stop");
    expect(JSON.parse(button.value)).toEqual({ repository: "example/repo", issueNumber: 44 });
    expect(harness.dmRecipients()).toEqual(["DOWNER"]);

    // 単独投稿の停止ボタンでは、押された投稿自身へ停止結果を返信する。
    const target = selfMergeStopTarget(button.value, { ts: warning.ts }, { id: CHANNEL });
    expect(target).toEqual({
      repository: "example/repo",
      issueNumber: 44,
      channelId: CHANNEL,
      rootTs: warning.ts,
    });
    if (!target) throw new Error("停止対象が必要です");
    expect(selfMergeStoppedDestination(target)).toEqual({
      channel: CHANNEL,
      thread_ts: warning.ts,
      reply_broadcast: false,
    });
  });

  test("DMを送れない宛先がいるときだけ、GitHub loginと連携案内を書いた単独投稿を一件出す", async () => {
    const harness = await createHarness();
    harness.github.pullRequest = { ...harness.github.pullRequest, authorLogin: "stranger" };

    await harness.lifecycle.process(checkRunFailedJob("stranger"));
    await harness.lifecycle.process({
      ...checkRunFailedJob("stranger"),
      deliveryId: "delivery-check-failure-redelivered",
    });

    expect(harness.dmRecipients()).toEqual(["DOWNER"]);
    const posts = harness.channelPosts();
    expect(posts).toHaveLength(1);
    const notice = JSON.stringify(posts[0]);
    expect(posts[0]?.thread_ts).toBeUndefined();
    expect(notice).toContain("@stranger（Slack未連携）");
    expect(notice).toContain("/ar connect github");
    expect(notice).not.toContain("<@");
  });

  test("未連携の新しい担当者はchannelで知らせ、連携済みの担当者はDMだけにする", async () => {
    const harness = await createHarness();
    harness.github.issue = { ...harness.github.issue, assigneeLogins: ["owner", "newcomer"] };

    await harness.lifecycle.process(issueAssignedJob("requester", "owner"));
    await harness.lifecycle.process(issueAssignedJob("requester", "newcomer", "delivery-new"));
    await harness.lifecycle.process(issueAssignedJob("requester", "newcomer", "delivery-new-2"));

    expect(harness.dmRecipients()).toEqual(["DOWNER"]);
    const posts = harness.channelPosts();
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(posts[0])).toContain("@newcomer（Slack未連携）");
  });

  test("コード中の@、team指定、@hereはGitHub利用者として扱わずchannelへ出さない", async () => {
    const harness = await createHarness();

    await harness.lifecycle.process(
      issueCommentJob(
        "`@Override` を外し、@here @example/core にも共有。@mentioned と @ghost に確認してください",
      ),
    );

    expect(harness.dmRecipients()).toEqual(["DMENTIONED"]);
    const posts = harness.channelPosts();
    expect(posts).toHaveLength(1);
    const notice = JSON.stringify(posts[0]);
    expect(notice).toContain("*DMを送れない宛先:* @ghost（Slack未連携）");
    expect(notice).not.toContain("Override（");
    expect(notice).not.toContain("@here（");
    expect(notice).not.toContain("@example（");

    const quiet = await createHarness();
    await quiet.lifecycle.process(issueCommentJob("@mentioned 確認してください `@Override`"));
    expect(quiet.dmRecipients()).toEqual(["DMENTIONED"]);
    expect(quiet.channelPosts()).toHaveLength(0);
  });
});

describe("directモードのレビュー依頼", () => {
  test("PR作成とレビュー依頼は親投稿もthread返信も出さず、個人reviewerへDMだけを送る", async () => {
    const harness = await createHarness();
    const review = harness.reviewNotifier();

    await review.notify(reviewModel(harness.github.issue), { sourceDeliveryId: "delivery-pr" });
    await review.notify(reviewModel(harness.github.issue), {
      sourceDeliveryId: "delivery-pr-redelivered",
    });

    expect(harness.channelPosts()).toHaveLength(0);
    expect(harness.dmRecipients()).toEqual(["DREVIEWER"]);
  });

  test("GitHub teamと未連携のreviewerがいるときだけchannelへ一件出す", async () => {
    const harness = await createHarness();
    const review = harness.reviewNotifier();
    const model: ReviewRequestReadModel = {
      ...reviewModel(harness.github.issue),
      reviewers: [
        ...reviewModel(harness.github.issue).reviewers,
        {
          githubUserId: 9,
          githubLogin: "outsider",
          slackUserId: null,
          reasons: ["CODEOWNERS: docs/a.md"],
          notified: false,
        },
      ],
      teams: [{ slug: "core", reasons: ["CODEOWNERS: src/app.ts"] }],
    };

    await review.notify(model, { sourceDeliveryId: "delivery-pr" });
    await review.notify(model, { sourceDeliveryId: "delivery-pr-redelivered" });

    expect(harness.dmRecipients()).toEqual(["DREVIEWER"]);
    const posts = harness.channelPosts();
    expect(posts).toHaveLength(1);
    const notice = JSON.stringify(posts[0]);
    expect(notice).toContain("@outsider（Slack未連携）");
    expect(notice).toContain("@core（GitHub team）");
    expect(notice).not.toContain("<@");
  });
});

describe("directモードの作業通知", () => {
  test("急ぎの未割当はTaskでもchannel単独投稿にし、再取得で増やさない", async () => {
    const harness = await createHarness();
    const work = harness.workService([workItem("URGENT_UNASSIGNED", { owner: null })]);

    expect(await work.notifyImmediate("delivery-1")).toBe(1);
    expect(await work.notifyImmediate("delivery-2")).toBe(0);

    const posts = harness.channelPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.thread_ts).toBeUndefined();
    expect(String(posts[0]?.text)).not.toContain("<@");
    expect(harness.dmRecipients()).toEqual([]);
  });

  test("blockerは全担当者へDMだけを送り、未連携の担当者がいるときだけchannelへ出す", async () => {
    const linked = await createHarness();
    await linked
      .workService([workItem("BLOCKED", { assignees: ["owner", "reviewer"] })])
      .notifyImmediate("delivery-1");
    expect(linked.channelPosts()).toHaveLength(0);
    expect(linked.dmRecipients().sort()).toEqual(["DOWNER", "DREVIEWER"]);

    const partial = await createHarness();
    const work = partial.workService([workItem("BLOCKED", { assignees: ["owner", "newcomer"] })]);
    await work.notifyImmediate("delivery-1");
    await work.notifyImmediate("delivery-2");
    expect(partial.dmRecipients()).toEqual(["DOWNER"]);
    expect(partial.channelPosts()).toHaveLength(1);
    expect(JSON.stringify(partial.channelPosts()[0])).toContain("@newcomer（Slack未連携）");
  });

  test("期限当日は担当者へDMし、期限接近はSlackへ出さない", async () => {
    const harness = await createHarness();
    await harness
      .workService([
        workItem("ACTIVE_WORK", { targetDate: "2026-08-02" }),
        workItem("ACTIVE_WORK", {
          issueNumber: 45,
          url: "https://github.example/example/repo/issues/45",
          targetDate: "2026-08-04",
        }),
      ])
      .notifyDeadlines();

    expect(harness.channelPosts()).toHaveLength(0);
    expect(harness.dmRecipients()).toEqual(["DOWNER"]);
  });

  test("日次digestは従来どおりchannelへ独立投稿する", async () => {
    const harness = await createHarness();
    await harness.workService([workItem("ACTIVE_WORK", { delivery: "digest" })]).sendDigest();

    const posts = harness.channelPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.thread_ts).toBeUndefined();
    expect(String(posts[0]?.text)).toContain("未完了作業は1件");
  });
});

interface SlackPost extends Record<string, unknown> {
  channel: string;
  ts: string;
  thread_ts?: string;
  reply_broadcast?: boolean;
}

async function createHarness(
  githubCapabilities = GitHubCapabilityGrants.empty(),
  mode: NotificationMode = "direct",
) {
  const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-direct-mode-")));
  const posts: SlackPost[] = [];
  const client = {
    chat: {
      postMessage: async (arguments_: Record<string, unknown>) => {
        const ts = `${1_000 + posts.length}.000100`;
        posts.push({ ...arguments_, ts } as SlackPost);
        return { ok: true, ts };
      },
    },
    conversations: {
      open: async ({ users }: { users: string }) => ({ channel: { id: `D${users.slice(1)}` } }),
    },
  };
  const slackClient = client as unknown as ConstructorParameters<
    typeof SlackDirectLifecycleNotifier
  >[0];
  // start.tsと同じ配線で、channel outboxとDM outboxを分ける。
  const sender = new DelegatingNotificationPayloadSender(
    new SlackLifecycleNotifier(slackClient, CHANNEL),
    new SlackWorkNotifier(slackClient, CHANNEL),
    (slackUserId) => ({
      lifecycle: new SlackDirectLifecycleNotifier(slackClient, slackUserId),
      work: new SlackDirectWorkNotifier(slackClient, slackUserId),
    }),
  );
  const outbox = new NotificationOutboxService(store, sender, { channelId: CHANNEL });
  const requiredActionDm = new RequiredActionDmService((slackUserId) => {
    const directOutbox = new NotificationOutboxService(store, sender, { channelId: slackUserId });
    const delivery = { kind: "direct" as const, slackUserId };
    return {
      lifecycle: new OutboxLifecycleNotifier(directOutbox, delivery),
      work: new OutboxWorkNotifier(directOutbox, delivery),
    };
  });
  const lifecycleNotifier = new LifecycleNotifierWithRequiredActionDm(
    new OutboxLifecycleNotifier(outbox),
    requiredActionDm,
  );
  const workNotifier = new WorkNotifierWithRequiredActionDm(
    new OutboxWorkNotifier(outbox),
    requiredActionDm,
  );
  const ids: Record<string, string> = {
    author: "UAUTHOR",
    mentioned: "UMENTIONED",
    owner: "UOWNER",
    requester: "UREQUESTER",
    reviewer: "UREVIEWER",
  };
  const resolveSlackUserId = async (login: string) => ids[login] ?? null;
  const threads = new NotificationThreadService(store, () => NOW);
  const github = new FakeLifecycleClient();
  const lifecycle = new LifecycleNotificationService(
    github,
    store,
    threads,
    lifecycleNotifier,
    resolveSlackUserId,
    () => NOW,
    null,
    githubCapabilities,
    { mode },
  );
  return {
    store,
    github,
    lifecycle,
    reviewNotifier: () =>
      new SlackReviewNotifier(lifecycleNotifier, threads, resolveSlackUserId, github, { mode }),
    workService: (items: HumanWorkItem[]) =>
      new WorkNotificationService(
        { loadProjectItems: async () => items },
        store,
        workNotifier,
        () => NOW,
        resolveSlackUserId,
        3,
        threads,
        github,
        { mode },
      ),
    channelPosts: () => posts.filter((post) => post.channel === CHANNEL),
    dmRecipients: () =>
      posts.filter((post) => post.channel.startsWith("D")).map((post) => post.channel),
  };
}

function findButton(post: SlackPost, actionId: string): { value: string } {
  const blocks = post.blocks as Array<{ elements?: Array<{ action_id?: string; value?: string }> }>;
  const button = blocks
    .flatMap((block) => block.elements ?? [])
    .find((element) => element.action_id === actionId);
  if (!button?.value) throw new Error(`${actionId}ボタンが必要です`);
  return { value: button.value };
}

class FakeLifecycleClient implements GitHubLifecycleClient {
  issue: GitHubIssueContext = {
    number: 44,
    title: "ライフサイクル通知",
    url: "https://github.example/example/repo/issues/44",
    body: "",
    state: "open",
    authorLogin: "requester",
    assigneeLogins: ["owner"],
    labels: ["type/task", "merge/review"],
    parentIssueUrl: "https://github.example/example/repo/issues/86",
  };

  parentIssue: GitHubIssueContext = {
    number: 86,
    title: "通知をまとめるWork",
    url: "https://github.example/example/repo/issues/86",
    body: "",
    state: "open",
    authorLogin: "requester",
    assigneeLogins: ["owner"],
    labels: ["type/work"],
  };

  pullRequest: PullRequestReviewContext = {
    schemaVersion: 1,
    repository: "example/repo",
    number: 45,
    title: "ライフサイクル通知",
    url: "https://github.example/example/repo/pull/45",
    authorLogin: "author",
    headSha: "head-2",
    draft: false,
    state: "open",
    mergeableState: "clean",
    body: "Closes #44",
    files: ["src/app.ts"],
    primaryIssue: this.issue,
    closingIssueCount: 1,
    linkedIssues: [this.issue],
    codeowners: "* @reviewer",
    requiredApprovals: 1,
    requestedReviewerLogins: ["reviewer"],
    requestedTeamSlugs: [],
    approvedReviewerLogins: [],
    changesRequestedReviewerLogins: ["reviewer"],
  };

  async loadIssueContext(_repository: string, issueNumber: number): Promise<GitHubIssueContext> {
    if (issueNumber === this.issue.number) return this.issue;
    if (issueNumber === this.parentIssue.number) return this.parentIssue;
    throw new Error(`Issue #${issueNumber}がfixtureにありません。`);
  }

  async loadPullRequestReviewContext(): Promise<PullRequestReviewContext> {
    return { ...this.pullRequest, primaryIssue: this.pullRequest.linkedIssues[0] ?? null };
  }

  async loadCheckFailureDiagnostics() {
    return { policyCodes: [] as string[], complete: false };
  }
}

function reviewModel(issue: GitHubIssueContext): ReviewRequestReadModel {
  return {
    schemaVersion: 1,
    kind: "review.request",
    repository: "example/repo",
    pullRequest: {
      number: 45,
      title: "ライフサイクル通知",
      url: "https://github.example/example/repo/pull/45",
      headSha: "head-2",
    },
    authorLogin: "author",
    primaryIssue: issue,
    closingIssueCount: 1,
    linkedIssues: [issue],
    requiredApprovals: 1,
    reviewers: [
      {
        githubUserId: 3,
        githubLogin: "reviewer",
        slackUserId: "UREVIEWER",
        reasons: ["CODEOWNERS: src/app.ts"],
        notified: false,
      },
    ],
    teams: [],
    dueDate: null,
    nextAction: "GitHubで変更内容を確認し、Approveまたは修正依頼を行う",
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
}

function workItem(
  reasonCode: HumanWorkItem["reasonCode"],
  overrides: Partial<HumanWorkItem> = {},
): HumanWorkItem {
  return {
    schemaVersion: 1,
    repository: "example/repo",
    issueNumber: 44,
    title: "ライフサイクル通知",
    url: "https://github.example/example/repo/issues/44",
    status: reasonCode === "URGENT_UNASSIGNED" ? "urgent-unstarted" : "in-progress",
    priority: "P1",
    owner: "owner",
    assignees: ["owner"],
    targetDate: null,
    delivery: "immediate",
    reasonCode,
    nextActor: "owner",
    nextAction: "次の操作",
    reason: "理由",
    actions: ["open-github"],
    ...overrides,
  };
}

function basePayload() {
  return { repository: { full_name: "example/repo" }, sender: { login: "merger" } };
}

function issueOpenedJob(deliveryId = "delivery-open") {
  return {
    schemaVersion: 1 as const,
    deliveryId,
    event: "issues",
    payload: { ...basePayload(), action: "opened", issue: { number: 44 } },
  };
}

function issueAssignedJob(actor: string, assignee: string, deliveryId = "delivery-assigned") {
  return {
    schemaVersion: 1 as const,
    deliveryId,
    event: "issues",
    payload: {
      ...basePayload(),
      sender: { login: actor },
      action: "assigned",
      issue: { number: 44 },
      assignee: { login: assignee },
    },
  };
}

function issueClosedJob() {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-close",
    event: "issues",
    payload: {
      ...basePayload(),
      action: "closed",
      issue: { number: 44, updated_at: "2026-08-02T00:00:00Z" },
    },
  };
}

function selfMergeLabeledJob(actor: string) {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-self-merge-label",
    event: "issues",
    payload: {
      ...basePayload(),
      sender: { login: actor },
      action: "labeled",
      issue: { number: 44 },
      label: { name: "merge/self" },
    },
  };
}

function issueCommentJob(body: string) {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-comment",
    event: "issue_comment",
    payload: {
      ...basePayload(),
      action: "created",
      issue: { number: 44 },
      comment: {
        id: 301,
        body,
        html_url: "https://github.example/example/repo/issues/44#issuecomment-301",
        user: { login: "commenter" },
      },
    },
  };
}

function checkRunFailedJob(actor: string) {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-check-failure",
    event: "check_run",
    payload: {
      ...basePayload(),
      sender: { login: actor },
      action: "completed",
      check_run: {
        id: 501,
        name: "verify",
        conclusion: "failure",
        html_url: "https://github.example/checks/501",
        pull_requests: [{ number: 45 }],
      },
    },
  };
}

function checkSuiteSucceededJob() {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-check-success",
    event: "check_suite",
    payload: {
      ...basePayload(),
      action: "completed",
      check_suite: { conclusion: "success", pull_requests: [{ number: 45 }] },
    },
  };
}

function changesRequestedJob() {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-review",
    event: "pull_request_review",
    payload: {
      ...basePayload(),
      action: "submitted",
      pull_request: { number: 45, html_url: "https://github.example/example/repo/pull/45" },
      review: {
        id: 201,
        state: "changes_requested",
        body: "ここを修正してください",
        html_url: "https://github.example/example/repo/pull/45#pullrequestreview-201",
        user: { login: "reviewer" },
      },
    },
  };
}

function approvedJob() {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-approve",
    event: "pull_request_review",
    payload: {
      ...basePayload(),
      action: "submitted",
      pull_request: { number: 45, html_url: "https://github.example/example/repo/pull/45" },
      review: {
        id: 202,
        state: "approved",
        body: "",
        html_url: "https://github.example/example/repo/pull/45#pullrequestreview-202",
        user: { login: "reviewer" },
      },
    },
  };
}

function synchronizeJob(headSha: string) {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-sync",
    event: "pull_request",
    payload: {
      ...basePayload(),
      sender: { login: "author" },
      action: "synchronize",
      pull_request: { number: 45, head: { sha: headSha } },
    },
  };
}

function mergedJob() {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-merge",
    event: "pull_request",
    payload: {
      ...basePayload(),
      sender: { login: "author" },
      action: "closed",
      pull_request: { number: 45, merged: true, merge_commit_sha: "merge-sha" },
    },
  };
}
