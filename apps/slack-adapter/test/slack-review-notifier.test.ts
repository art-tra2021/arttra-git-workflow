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
      async (login) => (login === "owner" ? "UOWNER" : null),
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
      linkedIssues: [
        {
          number: 44,
          title: "ライフサイクル通知",
          url: "https://github.example/issues/44",
          body: "",
          state: "open",
          authorLogin: "requester",
          assigneeLogins: ["owner"],
        },
      ],
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

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      threadTs: null,
      notification: {
        kind: "review-requested",
        slackUserIds: ["UREVIEWER", "UOWNER"],
        resource: { kind: "issue", number: 44 },
      },
    });
  });
});
