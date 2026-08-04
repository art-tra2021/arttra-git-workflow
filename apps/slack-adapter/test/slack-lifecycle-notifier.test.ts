import { describe, expect, test } from "bun:test";
import type { LifecycleNotificationKind } from "../src/lifecycle-notification-service.ts";
import { SlackLifecycleNotifier } from "../src/slack-lifecycle-notifier.ts";

describe("SlackLifecycleNotifier", () => {
  test("Issue作成通知だけはchannel rootへ送信できる", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const notifier = notifierWithCalls(calls, "970.1");

    expect(await notifier.notify(notification("issue-opened"), null)).toEqual({
      messageTs: "970.1",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("thread_ts");
  });

  test.each([
    ["intake", "🚧 新しいIntake"],
    ["work", "🚧 新しいWork"],
    ["task", "🚧 新しいTask"],
    ["business", "🚧 新しいBusiness"],
  ] as const)("%sのIssue rootは種別固有の見出しにする", async (issueType, header) => {
    const calls: Array<Record<string, unknown>> = [];
    const notifier = notifierWithCalls(calls, "970.1");

    await notifier.notify({ ...notification("issue-opened"), issueType }, null);

    expect(JSON.stringify(calls[0]?.blocks)).toContain(header);
  });

  test.each([
    "issue-reopened",
    "issue-assignment-changed",
    "comment-created",
    "issue-completed",
    "pr-merged",
    "review-requested",
    "review-approved",
    "review-changes-requested",
    "review-commented",
    "review-dismissed",
    "revision-pushed",
    "ci-failed",
    "self-merge-scheduled",
    "self-merge-ready",
  ] as const)("%sはIssue threadなしでchannel直下へfallbackしない", async (kind) => {
    const calls: Array<Record<string, unknown>> = [];
    const notifier = notifierWithCalls(calls, "970.2");

    expect(notifier.notify(notification(kind), null)).rejects.toThrow(
      `Issue threadが見つからないため、${kind}通知のchannel直下への送信を停止しました。`,
    );
    expect(calls).toHaveLength(0);
  });

  test("セルフマージ予定の初回だけIssue threadからchannelにも展開する", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const notifier = notifierWithCalls(calls, "970.3");

    await notifier.notify(notification("self-merge-scheduled"), "970.1");
    await notifier.notify(notification("self-merge-ready"), "970.1");

    expect(calls[0]).toMatchObject({ thread_ts: "970.1", reply_broadcast: true });
    expect(calls[1]).toMatchObject({ thread_ts: "970.1", reply_broadcast: false });
  });

  test("broadcast免除が明示されたセルフマージ予定はthread内だけにする", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const notifier = notifierWithCalls(calls, "970.31");

    await notifier.notify(
      { ...notification("self-merge-scheduled"), replyBroadcast: false },
      "970.1",
    );

    expect(calls[0]).toMatchObject({ thread_ts: "970.1", reply_broadcast: false });
  });

  test("actionable通知も実行者欄はplain表示し、責任者recipientだけnative mentionする", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const notifier = notifierWithCalls(calls, "970.4");
    const withActorSlackUserId = {
      ...notification("review-changes-requested"),
      actorSlackUserId: "UACTOR",
      slackUserIds: ["UACTOR"],
    };

    await notifier.notify(withActorSlackUserId, "970.1");

    const serialized = JSON.stringify(calls[0]);
    expect(serialized).toContain("<@UACTOR>");
    expect(serialized).toContain("*実行者:* @owner");
    expect(serialized).not.toContain("*実行者:* <@UACTOR>");
  });

  test("informational自己操作はrecipientと実行者のどちらにもnative mentionを残さない", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const notifier = notifierWithCalls(calls, "970.5");

    await notifier.notify(
      {
        ...notification("comment-created"),
        actorLogin: "actor",
        actorSlackUserId: "UACTOR",
        slackUserIds: ["UACTOR", "UOTHER"],
      },
      "970.1",
    );

    const serialized = JSON.stringify(calls[0]);
    expect(serialized).not.toContain("<@UACTOR>");
    expect(serialized).toContain("<@UOTHER>");
    expect(serialized).toContain("*実行者:* @actor");
  });

  test("native mention付きでIssue threadへ日本語通知する", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const notifier = new SlackLifecycleNotifier(
      {
        chat: {
          postMessage: async (arguments_: Record<string, unknown>) => {
            calls.push(arguments_);
            return { ok: true, ts: "950.2" };
          },
        },
      } as unknown as ConstructorParameters<typeof SlackLifecycleNotifier>[0],
      "CWORK",
    );

    expect(
      await notifier.notify(
        {
          schemaVersion: 1,
          kind: "review-changes-requested",
          resource: {
            kind: "issue",
            number: 44,
            title: "通知 <安全>",
            url: "https://github.example/issues/44",
          },
          pullRequest: {
            number: 45,
            title: "通知を追加",
            url: "https://github.example/pull/45",
          },
          actorLogin: "reviewer",
          actorSlackUserId: null,
          slackUserIds: ["UAUTHOR"],
          issueType: "work",
          summary: "PRが差し戻されました。",
          detail: "A < Bを直す",
          nextAction: "修正する",
          actionUrl: "https://github.example/pull/45#review",
        },
        "950.1",
        { intentId: "notification-test" },
      ),
    ).toEqual({ messageTs: "950.2" });

    expect(calls[0]).toMatchObject({
      channel: "CWORK",
      thread_ts: "950.1",
      reply_broadcast: false,
      metadata: {
        event_type: "arttra_notification",
        event_payload: { intent_id: "notification-test" },
      },
    });
    expect(calls[0]?.text).toContain("<@UAUTHOR>");
    expect(calls[0]?.text).toContain("⚠️");
    expect(JSON.stringify(calls[0]?.blocks)).toContain("A &lt; B");
    const message = calls[0];
    if (!message) throw new Error("Slack通知が記録されていません");
    expect((message.blocks as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "header",
      text: { text: "⚠️ PRが差し戻されました" },
    });
  });

  test("セルフマージ予定には停止buttonを大きく表示する", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const notifier = new SlackLifecycleNotifier(
      {
        chat: {
          postMessage: async (arguments_: Record<string, unknown>) => {
            calls.push(arguments_);
            return { ok: true, ts: "960.1" };
          },
        },
      } as unknown as ConstructorParameters<typeof SlackLifecycleNotifier>[0],
      "CWORK",
    );
    await notifier.notify(
      {
        schemaVersion: 1,
        kind: "self-merge-scheduled",
        resource: {
          kind: "issue",
          number: 44,
          title: "通知",
          url: "https://github.example/issues/44",
        },
        pullRequest: null,
        actorLogin: "owner",
        actorSlackUserId: null,
        slackUserIds: [],
        issueType: "work",
        summary: "このIssueはセルフマージ予定です。",
        detail: "第三者承認を待たず、本人がCI後にマージします。",
        nextAction: "問題なら停止してください",
        actionUrl: "https://github.example/issues/44",
        selfMergeControl: { repository: "example/repo", issueNumber: 44 },
      },
      "960.0",
    );

    const encoded = JSON.stringify(calls[0]?.blocks);
    expect(encoded).toContain("⚠️ セルフマージ予定");
    expect(encoded).toContain("セルフマージを停止");
    expect(encoded).toContain("ar.self-merge.stop");
  });
});

function notifierWithCalls(calls: Array<Record<string, unknown>>, ts: string) {
  return new SlackLifecycleNotifier(
    {
      chat: {
        postMessage: async (arguments_: Record<string, unknown>) => {
          calls.push(arguments_);
          return { ok: true, ts };
        },
      },
    } as unknown as ConstructorParameters<typeof SlackLifecycleNotifier>[0],
    "CWORK",
  );
}

function notification(kind: LifecycleNotificationKind) {
  return {
    schemaVersion: 1 as const,
    kind,
    resource: {
      kind: "issue" as const,
      number: 44,
      title: "通知",
      url: "https://github.example/issues/44",
    },
    pullRequest:
      kind === "issue-opened"
        ? null
        : {
            number: 45,
            title: "通知を追加",
            url: "https://github.example/pull/45",
          },
    actorLogin: "owner",
    actorSlackUserId: null,
    slackUserIds: [],
    issueType: "work" as const,
    summary: "ライフサイクル通知です。",
    detail: "通知内容",
    nextAction: "GitHubで確認する",
    actionUrl: "https://github.example/issues/44",
  };
}
