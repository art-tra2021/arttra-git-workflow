import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LifecycleNotification,
  LifecycleNotificationService,
} from "../src/lifecycle-notification-service.ts";
import { NotificationThreadService } from "../src/notification-thread-service.ts";
import type {
  GitHubIssueContext,
  GitHubLifecycleClient,
  PullRequestReviewContext,
} from "../src/review-types.ts";
import { LocalStateStore } from "../src/state-store.ts";

describe("LifecycleNotificationService", () => {
  test("通常Issue作成をchannel rootへ即時通知し、セルフマージ予定を同じthreadで強調する", async () => {
    const harness = await createHarness();
    harness.github.issue = {
      ...harness.github.issue,
      labels: ["type/task", "merge/self"],
      parentIssueUrl: "https://github.example/example/repo/issues/86",
      body: "## 完了条件\n\n- [ ] Slackへ通知する\n\n## 目標日\n\n2026-08-04",
    };
    harness.github.pullRequest = {
      ...harness.github.pullRequest,
      linkedIssues: [harness.github.issue],
    };

    expect(await harness.service.process(issueOpenedJob())).toBe(2);
    expect(await harness.service.process(selfMergeLabeledJob())).toBe(0);
    expect(harness.sent.map((value) => value.notification.kind)).toEqual([
      "issue-opened",
      "self-merge-scheduled",
    ]);
    expect(harness.sent.map((value) => value.threadTs)).toEqual([null, "900.1"]);
    expect(harness.sent[0]?.notification.detail).toContain("親Issue: example/repo#86");
    expect(harness.sent[0]?.notification.detail).toContain("完了条件: Slackへ通知する");
    expect(harness.sent[0]?.notification.detail).toContain("目標日: 2026-08-04");
    expect(harness.sent[0]?.notification).toMatchObject({
      issueType: "task",
      slackUserIds: ["UREQUESTER", "UOWNER"],
    });
    expect(harness.sent[1]?.notification).toMatchObject({
      selfMergeControl: { repository: "example/repo", issueNumber: 44 },
      detail: "第三者承認を待たず、PR作成者本人が必須CI通過後にマージします。",
    });
  });

  test("GitHub App作成Issueでも検証済み依頼者markerから重複なくmentionする", async () => {
    const harness = await createHarness();
    harness.github.issue = {
      ...harness.github.issue,
      authorLogin: "arttra-app[bot]",
      assigneeLogins: ["requester", "owner"],
      body: '<!-- ar:requester:v1 {"id":101,"login":"requester"} -->',
    };

    expect(await harness.service.process(issueOpenedJob())).toBe(1);
    expect(harness.sent[0]?.notification.slackUserIds).toEqual(["UREQUESTER", "UOWNER"]);
    expect(harness.sent[0]?.notification).toMatchObject({
      actorLogin: "requester",
      actorSlackUserId: "UREQUESTER",
    });
  });

  test("セルフマージPRのCI成功をIssue threadへ通知する", async () => {
    const harness = await createHarness();
    harness.github.issue = {
      ...harness.github.issue,
      labels: ["type/task", "merge/self"],
    };
    harness.github.pullRequest = {
      ...harness.github.pullRequest,
      linkedIssues: [harness.github.issue],
    };
    await harness.service.process(issueOpenedJob());

    expect(await harness.service.process(checkSuiteCompletedJob())).toBe(1);
    expect(harness.sent.at(-1)).toMatchObject({
      threadTs: "900.1",
      notification: {
        kind: "self-merge-ready",
        selfMergeControl: { repository: "example/repo", issueNumber: 44 },
      },
    });
  });

  test("Issueコメントの担当者と明示mentionを同じthreadへ通知し、closeも同居させる", async () => {
    const harness = await createHarness();
    const comment = issueCommentJob("delivery-comment");

    expect(await harness.service.process(comment)).toBe(1);
    expect(
      await harness.service.process({ ...comment, deliveryId: "delivery-comment-redelivery" }),
    ).toBe(0);
    expect(harness.sent[0]).toMatchObject({
      threadTs: null,
      notification: {
        kind: "issue-opened",
        slackUserIds: ["UREQUESTER", "UOWNER"],
      },
    });
    expect(harness.sent[1]).toMatchObject({
      threadTs: "900.1",
      notification: {
        kind: "comment-created",
        actorLogin: "commenter",
        slackUserIds: ["UOWNER", "UMENTIONED"],
      },
    });

    expect(await harness.service.process(issueClosedJob())).toBe(1);
    expect(harness.sent[2]).toMatchObject({
      threadTs: "900.1",
      notification: { kind: "issue-completed", slackUserIds: ["UOWNER", "UREQUESTER"] },
    });
  });

  test("WorkはTaskと別の親投稿を持ち、merge方針を表示しない", async () => {
    const harness = await createHarness();
    harness.github.issue = {
      ...harness.github.issue,
      number: 86,
      url: "https://github.example/example/repo/issues/86",
      labels: ["type/work"],
      parentIssueUrl: "https://github.example/example/intake/issues/7",
    };

    expect(await harness.service.process(issueOpenedJob(86, "delivery-work-open"))).toBe(1);
    expect(harness.sent[0]).toMatchObject({
      threadTs: null,
      notification: { kind: "issue-opened", issueType: "work" },
    });
    expect(harness.sent[0]?.notification.detail).not.toContain("マージ方針");
  });

  test("差し戻し、修正push、マージを関連Issueのthreadへ集約する", async () => {
    const harness = await createHarness();

    expect(await harness.service.process(changesRequestedJob())).toBe(1);
    expect(await harness.service.process(synchronizeJob("head-2"))).toBe(1);
    expect(
      await harness.service.process(synchronizeJob("head-2", "delivery-sync-redelivery")),
    ).toBe(0);
    harness.github.pullRequest = {
      ...harness.github.pullRequest,
      state: "closed",
      headSha: "head-2",
    };
    expect(await harness.service.process(mergedJob())).toBe(1);

    expect(harness.sent.map((value) => value.notification.kind)).toEqual([
      "issue-opened",
      "review-changes-requested",
      "revision-pushed",
      "pr-merged",
    ]);
    expect(harness.sent.map((value) => value.threadTs)).toEqual([null, "900.1", "900.1", "900.1"]);
    expect(harness.sent[1]?.notification.slackUserIds).toEqual(["UAUTHOR"]);
    expect(harness.sent[2]?.notification.slackUserIds).toEqual(["UREVIEWER"]);
    expect(harness.sent[3]?.notification.slackUserIds).toEqual(["UAUTHOR", "UOWNER"]);
  });

  test("PR会話とコードコメントではPR作成者をmentionする", async () => {
    const harness = await createHarness();

    expect(await harness.service.process(pullRequestCommentJob())).toBe(1);
    expect(await harness.service.process(reviewCommentJob())).toBe(1);

    expect(harness.sent.map((value) => value.notification.kind)).toEqual([
      "issue-opened",
      "comment-created",
      "review-commented",
    ]);
    expect(harness.sent[1]?.notification.slackUserIds).toEqual(["UAUTHOR", "UMENTIONED"]);
    expect(harness.sent[2]?.notification.slackUserIds).toEqual(["UAUTHOR"]);
    expect(harness.sent[2]?.threadTs).toBe("900.1");
  });

  test("primary Issueが一意でないPRはchannel直下にもIssue threadにも通知しない", async () => {
    const harness = await createHarness();
    harness.github.pullRequest = {
      ...harness.github.pullRequest,
      primaryIssue: null,
      closingIssueCount: 0,
      linkedIssues: [],
    };

    expect(await harness.service.process(changesRequestedJob())).toBe(0);
    expect(harness.sent).toHaveLength(0);
  });

  test("closing IssueがWorkなら一意でもPR通知先にしない", async () => {
    const harness = await createHarness();
    harness.github.pullRequest = {
      ...harness.github.pullRequest,
      primaryIssue: { ...harness.github.issue, labels: ["type/work"] },
      linkedIssues: [{ ...harness.github.issue, labels: ["type/work"] }],
    };

    expect(await harness.service.process(changesRequestedJob())).toBe(0);
    expect(harness.sent).toHaveLength(0);
  });

  test("CI失敗をprimary Issue threadへ通知し、PR作成者と担当者を呼び出す", async () => {
    const harness = await createHarness();

    expect(await harness.service.process(checkRunFailedJob())).toBe(1);
    expect(await harness.service.process(checkSuiteFailedJob())).toBe(0);

    expect(harness.sent.map((value) => value.notification.kind)).toEqual([
      "issue-opened",
      "ci-failed",
    ]);
    expect(harness.sent[1]).toMatchObject({
      threadTs: "900.1",
      notification: {
        slackUserIds: ["UAUTHOR", "UOWNER"],
        actionUrl: "https://github.example/checks/501",
      },
    });
  });
});

async function createHarness() {
  const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-lifecycle-")));
  const github = new FakeLifecycleClient();
  const sent: Array<{ notification: LifecycleNotification; threadTs: string | null }> = [];
  const ids: Record<string, string> = {
    author: "UAUTHOR",
    mentioned: "UMENTIONED",
    owner: "UOWNER",
    requester: "UREQUESTER",
    reviewer: "UREVIEWER",
  };
  const service = new LifecycleNotificationService(
    github,
    store,
    new NotificationThreadService(store, () => Date.parse("2026-08-02T00:00:00Z")),
    {
      notify: async (notification, threadTs) => {
        sent.push({ notification, threadTs });
        return { messageTs: threadTs ?? "900.1" };
      },
    },
    async (login) => ids[login] ?? null,
    () => Date.parse("2026-08-02T00:00:00Z"),
  );
  return { service, github, sent };
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

  async loadIssueContext(): Promise<GitHubIssueContext> {
    return this.issue;
  }

  async loadPullRequestReviewContext(): Promise<PullRequestReviewContext> {
    return {
      ...this.pullRequest,
      primaryIssue:
        this.pullRequest.closingIssueCount === 1
          ? (this.pullRequest.linkedIssues[0] ?? null)
          : null,
    };
  }
}

function basePayload() {
  return {
    repository: { full_name: "example/repo" },
    sender: { login: "merger" },
  };
}

function issueCommentJob(deliveryId: string) {
  return {
    schemaVersion: 1 as const,
    deliveryId,
    event: "issue_comment",
    payload: {
      ...basePayload(),
      action: "created",
      issue: { number: 44 },
      comment: {
        id: 101,
        body: "確認をお願いします @mentioned",
        html_url: "https://github.example/example/repo/issues/44#issuecomment-101",
        user: { login: "commenter" },
      },
    },
  };
}

function issueClosedJob() {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-close",
    event: "issues",
    payload: { ...basePayload(), action: "closed", issue: { number: 44 } },
  };
}

function issueOpenedJob(issueNumber = 44, deliveryId = "delivery-open") {
  return {
    schemaVersion: 1 as const,
    deliveryId,
    event: "issues",
    payload: { ...basePayload(), action: "opened", issue: { number: issueNumber } },
  };
}

function selfMergeLabeledJob() {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-self-merge-label",
    event: "issues",
    payload: {
      ...basePayload(),
      action: "labeled",
      issue: { number: 44 },
      label: { name: "merge/self" },
    },
  };
}

function checkSuiteCompletedJob() {
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

function checkRunFailedJob() {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-check-failure",
    event: "check_run",
    payload: {
      ...basePayload(),
      action: "completed",
      check_run: {
        name: "verify",
        conclusion: "failure",
        html_url: "https://github.example/checks/501",
        pull_requests: [{ number: 45 }],
      },
    },
  };
}

function checkSuiteFailedJob() {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-check-suite-failure",
    event: "check_suite",
    payload: {
      ...basePayload(),
      action: "completed",
      check_suite: { conclusion: "failure", pull_requests: [{ number: 45 }] },
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
      pull_request: {
        number: 45,
        html_url: "https://github.example/example/repo/pull/45",
      },
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

function synchronizeJob(headSha: string, deliveryId = "delivery-sync") {
  return {
    schemaVersion: 1 as const,
    deliveryId,
    event: "pull_request",
    payload: {
      ...basePayload(),
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
      action: "closed",
      pull_request: { number: 45, merged: true, merge_commit_sha: "merge-sha" },
    },
  };
}

function pullRequestCommentJob() {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-pr-comment",
    event: "issue_comment",
    payload: {
      ...basePayload(),
      action: "created",
      issue: { number: 45, pull_request: { url: "https://api.example/pulls/45" } },
      comment: {
        id: 301,
        body: "確認してください @mentioned",
        html_url: "https://github.example/example/repo/pull/45#issuecomment-301",
        user: { login: "commenter" },
      },
    },
  };
}

function reviewCommentJob() {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-code-comment",
    event: "pull_request_review_comment",
    payload: {
      ...basePayload(),
      action: "created",
      pull_request: { number: 45 },
      comment: {
        id: 302,
        body: "この条件を確認してください",
        html_url: "https://github.example/example/repo/pull/45#discussion_r302",
        user: { login: "reviewer" },
      },
    },
  };
}
