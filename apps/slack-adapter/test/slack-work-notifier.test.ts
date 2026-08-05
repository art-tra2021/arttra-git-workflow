import { describe, expect, test } from "bun:test";
import { SlackWorkNotifier } from "../src/slack-work-notifier.ts";
import type { HumanWorkItem } from "../src/types.ts";

describe("SlackWorkNotifier", () => {
  test("親投稿で担当者をnative mentionし、message tsを返す", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const notifier = new SlackWorkNotifier(slackClient(calls, ["700.1"]), "CWORK");

    const result = await notifier.notify(
      item(),
      {
        kind: "deadline",
        threadTs: null,
        slackUserId: "UALICE",
      },
      { intentId: "notification-test" },
    );

    expect(result).toEqual({ messageTs: "700.1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("<@UALICE>");
    expect(calls[0]?.text).toContain("⏰");
    const message = calls[0];
    if (!message) throw new Error("Slack通知が記録されていません");
    expect((message.blocks as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "header",
      text: { text: "⏰ 期限のお知らせ" },
    });
    expect(calls[0]).not.toHaveProperty("thread_ts");
    expect(calls[0]?.metadata).toEqual({
      event_type: "arttra_notification",
      event_payload: { intent_id: "notification-test" },
    });
  });

  test("同じIssueの続報は親投稿のスレッドへ返信する", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const notifier = new SlackWorkNotifier(slackClient(calls, ["700.2"]), "CWORK");

    await notifier.notify(item(), {
      kind: "state",
      threadTs: "700.1",
      slackUserId: "UALICE",
    });

    expect(calls[0]?.thread_ts).toBe("700.1");
    expect(calls[0]?.reply_broadcast).toBe(false);
  });

  test("DMはowner本人へ送り、channel threadと自己mentionを付けない", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const notifier = new SlackWorkNotifier(slackClient(calls, ["750.1"]), "UOWNER", {
      direct: true,
    });

    await notifier.notify(
      item(),
      {
        kind: "deadline",
        threadTs: "700.1",
        slackUserId: "UOWNER",
      },
      { intentId: "notification-direct-work" },
    );

    expect(calls[0]).toMatchObject({
      channel: "UOWNER",
      metadata: {
        event_type: "arttra_notification",
        event_payload: { intent_id: "notification-direct-work" },
      },
    });
    expect(calls[0]).not.toHaveProperty("thread_ts");
    expect(JSON.stringify(calls[0])).not.toContain("<@UOWNER>");
  });

  test("digestはIssueスレッドへ入れない", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const notifier = new SlackWorkNotifier(slackClient(calls, ["800.1"]), "CWORK");

    await notifier.digest([item()]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("📋");
    const message = calls[0];
    if (!message) throw new Error("Slack通知が記録されていません");
    expect((message.blocks as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "header",
      text: { text: "📋 ART-TRA 作業ダイジェスト（1件）" },
    });
    expect(calls[0]).not.toHaveProperty("thread_ts");
  });
});

function slackClient(calls: Array<Record<string, unknown>>, timestamps: string[]) {
  return {
    chat: {
      postMessage: async (arguments_: Record<string, unknown>) => {
        calls.push(arguments_);
        return { ok: true, ts: timestamps[calls.length - 1] };
      },
    },
  } as unknown as ConstructorParameters<typeof SlackWorkNotifier>[0];
}

function item(): HumanWorkItem {
  return {
    schemaVersion: 1,
    issueNumber: 41,
    title: "期限通知を確認する",
    url: "https://github.com/art-tra2021/arttra-git-workflow/issues/41",
    status: "in-progress",
    priority: "P1",
    owner: "alice",
    targetDate: "2026-08-04",
    delivery: "immediate",
    reasonCode: "DUE_SOON",
    nextActor: "alice",
    nextAction: "期限までに完了できるか確認する",
    reason: "目標日が近づいています。",
    actions: ["open-github"],
  };
}
