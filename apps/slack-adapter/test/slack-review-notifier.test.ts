import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LifecycleNotification } from "../src/lifecycle-notification-service.ts";
import { NotificationThreadService } from "../src/notification-thread-service.ts";
import { SlackReviewNotifier } from "../src/slack-review-notifier.ts";
import { LocalStateStore } from "../src/state-store.ts";

describe("SlackReviewNotifier", () => {
  test("PR作成時のreviewerとIssue担当者を関連Issue threadでmentionする", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-review-thread-")));
    const sent: Array<{ notification: LifecycleNotification; threadTs: string | null }> = [];
    const notifier = new SlackReviewNotifier(
      {
        notify: async (notification, threadTs) => {
          sent.push({ notification, threadTs });
          return { messageTs: threadTs ?? "970.1" };
        },
      },
      new NotificationThreadService(store),
      async (login) =>
        ({ author: "UAUTHOR", owner: "UOWNER", requester: "UREQUESTER" })[login] ?? null,
      { loadIssueContext: async () => workIssue() },
    );

    await notifier.notify({
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
    });

    expect(sent).toHaveLength(2);
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
        kind: "review-requested",
        slackUserIds: ["UREVIEWER", "UOWNER"],
        actorSlackUserId: null,
        resource: { kind: "issue", number: 44 },
      },
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
});

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
