import { describe, expect, test } from "bun:test";
import type { LifecycleNotification } from "../src/lifecycle-notification-service.ts";
import {
  resolveSlackDirectChannel,
  SlackDirectLifecycleNotifier,
  SlackDirectWorkNotifier,
} from "../src/slack-direct-notifier.ts";
import type { HumanWorkItem } from "../src/types.ts";

describe("Slack direct notifier", () => {
  test("recipient user IDをDM conversationへ解決してlifecycle通知を送る", async () => {
    const opened: string[] = [];
    const posted: Array<Record<string, unknown>> = [];
    const client = {
      conversations: {
        open: async ({ users }: { users: string }) => {
          opened.push(users);
          return { channel: { id: "DDIRECT" } };
        },
      },
      chat: {
        postMessage: async (arguments_: Record<string, unknown>) => {
          posted.push(arguments_);
          return { ok: true, ts: "600.1" };
        },
      },
    };

    await new SlackDirectLifecycleNotifier(
      client as unknown as ConstructorParameters<typeof SlackDirectLifecycleNotifier>[0],
      "UOWNER",
    ).notify(notification(), "ignored-thread", { intentId: "notification-direct" });

    expect(opened).toEqual(["UOWNER"]);
    expect(posted[0]).toMatchObject({
      channel: "DDIRECT",
      metadata: {
        event_type: "arttra_notification",
        event_payload: { intent_id: "notification-direct" },
      },
    });
    expect(posted[0]).not.toHaveProperty("thread_ts");
    expect(JSON.stringify(posted[0])).not.toContain("<@UOWNER>");
  });

  test("work通知も同じDM conversationへ送り、threadを持ち込まない", async () => {
    const posted: Array<Record<string, unknown>> = [];
    const client = {
      conversations: {
        open: async () => ({ channel: { id: "DDIRECT" } }),
      },
      chat: {
        postMessage: async (arguments_: Record<string, unknown>) => {
          posted.push(arguments_);
          return { ok: true, ts: "610.1" };
        },
      },
    };

    await new SlackDirectWorkNotifier(
      client as unknown as ConstructorParameters<typeof SlackDirectWorkNotifier>[0],
      "UOWNER",
    ).notify(
      item(),
      { kind: "deadline", threadTs: "channel-thread", slackUserId: "UOWNER" },
      { intentId: "notification-direct-work" },
    );

    expect(posted[0]).toMatchObject({ channel: "DDIRECT" });
    expect(posted[0]).not.toHaveProperty("thread_ts");
  });

  test("SlackがDM conversation IDを返さなければ送信前に停止する", async () => {
    await expect(
      resolveSlackDirectChannel(
        {
          conversations: {
            open: async () => ({ channel: { id: "CCHANNEL" } }),
          },
        },
        "UOWNER",
      ),
    ).rejects.toThrow("Slack DM conversation IDを取得できませんでした。");
  });
});

function notification(): LifecycleNotification {
  return {
    schemaVersion: 1,
    kind: "ci-failed",
    resource: {
      kind: "issue",
      number: 161,
      title: "対応必須通知をDMする",
      url: "https://github.com/art-tra2021/arttra-git-workflow/issues/161",
    },
    pullRequest: {
      number: 162,
      title: "DM通知を追加",
      url: "https://github.com/art-tra2021/arttra-git-workflow/pull/162",
    },
    actorLogin: "actor",
    actorSlackUserId: "UACTOR",
    slackUserIds: ["UOWNER"],
    issueType: "task",
    summary: "CIに対応が必要です。",
    detail: "verify: failure",
    nextAction: "失敗内容を確認する",
    actionUrl: "https://github.com/art-tra2021/arttra-git-workflow/pull/162",
  };
}

function item(): HumanWorkItem {
  return {
    schemaVersion: 1,
    repository: "art-tra2021/arttra-git-workflow",
    issueNumber: 161,
    title: "対応必須通知をDMする",
    url: "https://github.com/art-tra2021/arttra-git-workflow/issues/161",
    status: "blocked",
    priority: "P1",
    owner: "owner",
    targetDate: "2026-08-05",
    delivery: "immediate",
    reasonCode: "OVERDUE",
    nextActor: "owner",
    nextAction: "期限を見直す",
    reason: "期限超過",
    actions: ["open-github"],
  };
}
