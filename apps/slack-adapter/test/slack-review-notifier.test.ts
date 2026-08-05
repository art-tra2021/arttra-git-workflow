import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  issueOpenedEventFingerprint,
  issueRootNotification,
  type LifecycleNotification,
  LifecycleNotificationService,
} from "../src/lifecycle-notification-service.ts";
import {
  type NotificationIntentMetadata,
  NotificationOutboxService,
  type NotificationPayload,
  notificationIntentId,
  OutboxLifecycleNotifier,
} from "../src/notification-outbox.ts";
import { NotificationThreadService } from "../src/notification-thread-service.ts";
import { SlackReviewNotifier } from "../src/slack-review-notifier.ts";
import { LocalStateStore } from "../src/state-store.ts";

describe("SlackReviewNotifier", () => {
  test("PR作成時のreviewerとIssue担当者を関連Issue threadでmentionする", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-review-thread-")));
    const sent: Array<{
      notification: LifecycleNotification;
      threadTs: string | null;
      metadata?: NotificationIntentMetadata;
    }> = [];
    const notifier = new SlackReviewNotifier(
      {
        notify: async (notification, threadTs, metadata) => {
          sent.push({
            notification,
            threadTs,
            ...(metadata ? { metadata } : {}),
          });
          return { messageTs: threadTs ?? "970.1" };
        },
      },
      new NotificationThreadService(store),
      async (login) =>
        ({
          author: "UAUTHOR",
          owner: "UOWNER",
          requester: "UREQUESTER",
          initiator: "UINITIATOR",
        })[login] ?? null,
      { loadIssueContext: async () => workIssue() },
    );

    await notifier.notify(
      {
        schemaVersion: 1,
        kind: "review.request",
        repository: "example/repo",
        pullRequest: {
          number: 45,
          title: "通知を追加",
          url: "https://github.example/pull/45",
          headSha: "head-1",
        },
        authorLogin: "author",
        primaryIssue: issue(),
        closingIssueCount: 1,
        linkedIssues: [issue()],
        requiredApprovals: 1,
        reviewers: [
          {
            githubUserId: 101,
            githubLogin: "reviewer",
            slackUserId: "UREVIEWER",
            reasons: ["CODEOWNERS: src/app.ts"],
            notified: false,
          },
        ],
        teams: [],
        dueDate: "2026-08-10",
        nextAction: "GitHubで確認する",
        updatedAt: "2026-08-02T00:00:00Z",
      },
      { sourceDeliveryId: "delivery-review", actorLogin: "initiator" },
    );

    expect(sent).toHaveLength(3);
    expect(sent[0]).toMatchObject({
      threadTs: null,
      notification: {
        kind: "issue-opened",
        slackUserIds: ["UAUTHOR", "UOWNER"],
        resource: { kind: "issue", number: 86 },
      },
    });
    expect(sent[1]).toMatchObject({
      threadTs: "970.1",
      notification: {
        kind: "issue-opened",
        slackUserIds: ["UAUTHOR", "UOWNER"],
        issueType: "task",
        resource: { kind: "issue", number: 44 },
      },
    });
    expect(sent[2]).toMatchObject({
      threadTs: "970.1",
      notification: {
        kind: "review-requested",
        slackUserIds: ["UREVIEWER", "UAUTHOR", "UOWNER"],
        actorSlackUserId: "UINITIATOR",
        actorLogin: "initiator",
        issueType: "task",
        resource: { kind: "issue", number: 44 },
      },
    });
    expect(sent[2]?.metadata?.requiredAction).toEqual({
      kind: "review-requested",
      recipientSlackUserIds: ["UREVIEWER"],
      actorSlackUserId: "UINITIATOR",
    });
  });

  test("primary Issueが一意でないPRは通知しない", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-review-thread-")));
    const sent: LifecycleNotification[] = [];
    const notifier = new SlackReviewNotifier(
      {
        notify: async (notification) => {
          sent.push(notification);
          return { messageTs: "970.2" };
        },
      },
      new NotificationThreadService(store),
      async () => null,
      { loadIssueContext: async () => workIssue() },
    );

    await notifier.notify({
      schemaVersion: 1,
      kind: "review.request",
      repository: "example/repo",
      pullRequest: {
        number: 46,
        title: "親なし",
        url: "https://github.example/pull/46",
        headSha: "head-2",
      },
      authorLogin: "author",
      primaryIssue: null,
      closingIssueCount: 0,
      linkedIssues: [],
      requiredApprovals: 1,
      reviewers: [],
      teams: [],
      dueDate: null,
      nextAction: "GitHubで確認する",
      updatedAt: "2026-08-02T00:00:00Z",
    });

    expect(sent).toHaveLength(0);
  });

  test("GitHub teamだけのreview依頼はIssue担当者をchannelで知らせてもDM対象にしない", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-team-review-")));
    const sent: Array<{
      notification: LifecycleNotification;
      metadata?: NotificationIntentMetadata;
    }> = [];
    const notifier = new SlackReviewNotifier(
      {
        notify: async (notification, _threadTs, metadata) => {
          sent.push({ notification, ...(metadata ? { metadata } : {}) });
          return { messageTs: "970.3" };
        },
      },
      new NotificationThreadService(store),
      async (login) =>
        ({ author: "UAUTHOR", owner: "UOWNER", initiator: "UINITIATOR" })[login] ?? null,
      { loadIssueContext: async () => workIssue() },
    );
    const model = {
      ...reviewModel(),
      reviewers: [],
      teams: [{ slug: "platform", reasons: ["CODEOWNERS: src/**"] }],
    };

    await notifier.notify(model, { actorLogin: "initiator" });

    expect(sent.at(-1)?.notification.slackUserIds).toEqual(["UAUTHOR", "UOWNER"]);
    expect(sent.at(-1)?.metadata?.requiredAction).toEqual({
      kind: "review-requested",
      recipientSlackUserIds: [],
      actorSlackUserId: "UINITIATOR",
    });
  });

  test("PR eventが先でもOutboxでTask概要を一度だけ先行させる", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-review-outbox-")));
    const delivered: NotificationPayload[] = [];
    const lifecycleNotifier = new OutboxLifecycleNotifier(
      new NotificationOutboxService(
        store,
        {
          send: async (payload) => {
            delivered.push(payload);
            return {
              messageTs:
                payload.kind === "lifecycle" && payload.threadTs === null ? "971.1" : "971.2",
            };
          },
        },
        { channelId: "CWORK" },
      ),
    );
    const threads = new NotificationThreadService(store);
    const resolveSlackUserId = async (login: string) =>
      ({ author: "UAUTHOR", owner: "UOWNER", requester: "UREQUESTER" })[login] ?? null;
    const github = {
      loadIssueContext: async (_repository: string, number: number) =>
        number === 86 ? workIssue() : issue(),
    };
    const reviewNotifier = new SlackReviewNotifier(
      lifecycleNotifier,
      threads,
      resolveSlackUserId,
      github,
    );

    await reviewNotifier.notify(reviewModel(), { sourceDeliveryId: "delivery-pr-open" });
    expect(delivered.map(notificationKind)).toEqual([
      "issue-opened",
      "issue-opened",
      "review-requested",
    ]);

    const lifecycle = new LifecycleNotificationService(
      github as unknown as ConstructorParameters<typeof LifecycleNotificationService>[0],
      store,
      threads,
      lifecycleNotifier,
      resolveSlackUserId,
      () => Date.parse("2026-08-02T00:00:00Z"),
      ["example/repo"],
    );
    expect(
      await lifecycle.process({
        schemaVersion: 1,
        deliveryId: "delivery-issue-open",
        event: "issues",
        payload: {
          action: "opened",
          repository: { full_name: "example/repo" },
          sender: { login: "requester" },
          issue: { number: 44 },
        },
      }),
    ).toBe(1);
    expect(delivered.map(notificationKind)).toEqual([
      "issue-opened",
      "issue-opened",
      "review-requested",
    ]);
  });

  test("#119相当の旧Task平投稿後もready_for_reviewとreview_requestedをWork threadへ一度だけ通知する", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-review-migration-")));
    const delivered: NotificationPayload[] = [];
    const outbox = new NotificationOutboxService(
      store,
      {
        send: async (payload) => {
          delivered.push(payload);
          return {
            messageTs:
              payload.kind === "lifecycle" && payload.threadTs === null ? "119.1" : "119.2",
          };
        },
      },
      { channelId: "CWORK" },
    );
    const lifecycleNotifier = new OutboxLifecycleNotifier(outbox);
    const taskOpened = issueRootNotification(issue(), ["UAUTHOR", "UOWNER"], null);
    const taskIntentId = notificationIntentId({
      kind: "lifecycle",
      resourceUrl: issue().url,
      notificationKind: "issue-opened",
      eventFingerprint: issueOpenedEventFingerprint(issue()),
    });
    await lifecycleNotifier.notify(taskOpened, null, {
      intentId: taskIntentId,
      sourceDeliveryId: "delivery-legacy-task-opened",
    });

    const threads = new NotificationThreadService(store);
    await threads.ensureRoot(workIssue().url, async () => ({ messageTs: "95.1" }));
    const resolveSlackUserId = async (login: string) =>
      ({ author: "UAUTHOR", owner: "UOWNER", requester: "UREQUESTER" })[login] ?? null;
    const reviewNotifier = new SlackReviewNotifier(lifecycleNotifier, threads, resolveSlackUserId, {
      loadIssueContext: async (_repository, number) => (number === 86 ? workIssue() : issue()),
    });

    await expect(
      lifecycleNotifier.notify(taskOpened, "95.1", {
        intentId: taskIntentId,
        sourceDeliveryId: "delivery-outbox-rerun",
      }),
    ).resolves.toEqual({ messageTs: "119.1" });
    await reviewNotifier.notify(reviewModel(), { sourceDeliveryId: "delivery-ready-for-review" });
    await reviewNotifier.notify(reviewModel(), { sourceDeliveryId: "delivery-ready-for-review" });
    await reviewNotifier.notify(reviewModel(), { sourceDeliveryId: "delivery-review-requested" });

    expect(delivered.map(notificationKind)).toEqual(["issue-opened", "review-requested"]);
    expect(delivered[0]).toMatchObject({ kind: "lifecycle", threadTs: null });
    expect(delivered[1]).toMatchObject({ kind: "lifecycle", threadTs: "95.1" });
    expect(await outbox.get(taskIntentId)).toMatchObject({
      status: "sent",
      revision: 3,
      sourceDeliveryId: "delivery-legacy-task-opened",
      messageTs: "119.1",
      payload: { kind: "lifecycle", threadTs: null },
    });
    expect(await store.list("notification-outbox")).toHaveLength(2);
  });
});

function reviewModel() {
  return {
    schemaVersion: 1 as const,
    kind: "review.request" as const,
    repository: "example/repo",
    pullRequest: {
      number: 45,
      title: "通知を追加",
      url: "https://github.example/pull/45",
      headSha: "head-1",
    },
    authorLogin: "author",
    primaryIssue: issue(),
    closingIssueCount: 1,
    linkedIssues: [issue()],
    requiredApprovals: 1,
    reviewers: [
      {
        githubUserId: 101,
        githubLogin: "reviewer",
        slackUserId: "UREVIEWER",
        reasons: ["CODEOWNERS: src/app.ts"],
        notified: false,
      },
    ],
    teams: [],
    dueDate: "2026-08-10",
    nextAction: "GitHubで確認する",
    updatedAt: "2026-08-02T00:00:00Z",
  };
}

function notificationKind(payload: NotificationPayload): string {
  return payload.kind === "lifecycle" ? payload.notification.kind : payload.kind;
}

function issue() {
  return {
    number: 44,
    title: "ライフサイクル通知",
    url: "https://github.example/issues/44",
    body: "",
    state: "open" as const,
    authorLogin: "requester",
    assigneeLogins: ["author", "owner"],
    labels: ["type/task", "merge/review"],
    parentIssueUrl: "https://github.example/example/repo/issues/86",
  };
}

function workIssue() {
  return {
    number: 86,
    title: "通知をまとめるWork",
    url: "https://github.example/example/repo/issues/86",
    body: "",
    state: "open" as const,
    authorLogin: "requester",
    assigneeLogins: ["author", "owner"],
    labels: ["type/work"],
    parentIssueUrl: "https://github.example/example/repo/issues/7",
  };
}
