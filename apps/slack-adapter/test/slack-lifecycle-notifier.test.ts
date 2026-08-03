import { describe, expect, test } from "bun:test";
import { SlackLifecycleNotifier } from "../src/slack-lifecycle-notifier.ts";

describe("SlackLifecycleNotifier", () => {
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
          slackUserIds: ["UAUTHOR"],
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
        slackUserIds: [],
        summary: "このIssueはセルフマージ予定です。",
        detail: "第三者承認を待たず、本人がCI後にマージします。",
        nextAction: "問題なら停止してください",
        actionUrl: "https://github.example/issues/44",
        selfMergeControl: { repository: "example/repo", issueNumber: 44 },
      },
      null,
    );

    const encoded = JSON.stringify(calls[0]?.blocks);
    expect(encoded).toContain("⚠️ セルフマージ予定");
    expect(encoded).toContain("セルフマージを停止");
    expect(encoded).toContain("ar.self-merge.stop");
  });
});
