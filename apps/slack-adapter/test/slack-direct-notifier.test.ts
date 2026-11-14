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

  test("lifecycle DMはHeaderを使わず、1行目に依頼と依頼元、2行目にPRとIssueのリンクを置く", async () => {
    const posted: Array<Record<string, unknown>> = [];
    await new SlackDirectLifecycleNotifier(directClient(posted), "UOWNER").notify(
      notification(),
      null,
      {
        intentId: "notification-direct-ci",
        requiredAction: {
          kind: "ci-failed",
          recipientSlackUserIds: ["UOWNER"],
          actorSlackUserId: "UACTOR",
        },
      },
    );

    const message = posted[0] as { text: string; blocks: Array<Record<string, unknown>> };
    expect(message.text).toBe("🚨 CIが失敗しました、修正してください（GitHub Checks から）");
    expect(message.blocks.map((block) => block.type)).toEqual(["section", "actions"]);
    expect(sectionLines(message)).toEqual([
      "*🚨 CIが失敗しました、修正してください*（GitHub Checks から）",
      "<https://github.com/art-tra2021/arttra-git-workflow/pull/162|PR #162 DM通知を追加>（Issue <https://github.com/art-tra2021/arttra-git-workflow/issues/161|#161>）",
      "次の操作: 失敗内容を確認する",
    ]);
    expect(message.blocks[1]).toMatchObject({
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "GitHubで開く" },
          url: "https://github.com/art-tra2021/arttra-git-workflow/pull/162",
        },
      ],
    });
    expect(JSON.stringify(message)).not.toContain("<@");
  });

  test.each([
    ["review-requested", "review-requested", "👀 レビューをお願いします"],
    ["approval-wait", "ci-failed", "⚠️ PRのreviewerを指定してください"],
    [
      "changes-requested",
      "review-changes-requested",
      "⚠️ PRが差し戻されました、指摘を反映してください",
    ],
    [
      "revision-pushed",
      "revision-pushed",
      "🛠️ 差し戻したPRが修正されました、再レビューをお願いします",
    ],
    ["approved", "review-approved", "✅ PRが承認されました、マージを進めてください"],
    ["mentioned", "comment-created", "💬 コメントでメンションされました、確認してください"],
    ["assigned", "issue-assignment-changed", "🧩 Issueの担当になりました、内容を確認してください"],
  ] as const)("%sのDMは専用の依頼文を1行目に置く", async (kind, notificationKind, request) => {
    const posted: Array<Record<string, unknown>> = [];
    await new SlackDirectLifecycleNotifier(directClient(posted), "UOWNER").notify(
      { ...notification(), kind: notificationKind },
      null,
      {
        intentId: `notification-direct-${kind}`,
        requiredAction: { kind, recipientSlackUserIds: ["UOWNER"], actorSlackUserId: null },
      },
    );

    const from = kind === "approval-wait" ? "GitHub Checks" : "@actor";
    expect((posted[0] as { text: string }).text).toBe(`${request}（${from} から）`);
  });

  test("種別を持たない旧DM payloadも通知種別から依頼文を復元する", async () => {
    const posted: Array<Record<string, unknown>> = [];
    await new SlackDirectLifecycleNotifier(directClient(posted), "UOWNER").notify(
      { ...notification(), kind: "review-requested", pullRequest: null },
      null,
      { intentId: "notification-direct-legacy" },
    );

    const message = posted[0] as { text: string; blocks: Array<Record<string, unknown>> };
    expect(message.text).toBe("👀 レビューをお願いします（@actor から）");
    expect(sectionLines(message)[1]).toBe(
      "<https://github.com/art-tra2021/arttra-git-workflow/issues/161|#161 対応必須通知をDMする>",
    );
  });

  test.each([
    [
      "OVERDUE",
      "deadline",
      "⏰ 目標日を過ぎています、完了するか期限を見直してください（GitHub Projectsの目標日から）",
    ],
    [
      "DUE_TODAY",
      "deadline",
      "⏰ 目標日は今日です、完了するか期限を見直してください（GitHub Projectsの目標日から）",
    ],
    [
      "BLOCKED",
      "state",
      "⚠️ 作業が止まっています、blockerの解消条件を確認してください（GitHub Projectsの状態から）",
    ],
    [
      "CONFLICTING",
      "state",
      "⚠️ PRがconflictしています、解消してください（GitHub Projectsの状態から）",
    ],
  ] as const)("work DMの%sは専用の依頼文とIssueリンクを置く", async (reasonCode, kind, text) => {
    const posted: Array<Record<string, unknown>> = [];
    await new SlackDirectWorkNotifier(directClient(posted), "UOWNER").notify(
      { ...item(), reasonCode },
      { kind, threadTs: null, slackUserId: "UOWNER" },
      { intentId: `notification-direct-${reasonCode}` },
    );

    const message = posted[0] as { text: string; blocks: Array<Record<string, unknown>> };
    expect(message.text).toBe(text);
    expect(message.blocks.map((block) => block.type)).toEqual(["section", "actions"]);
    expect(sectionLines(message).slice(1)).toEqual([
      "<https://github.com/art-tra2021/arttra-git-workflow/issues/161|#161 対応必須通知をDMする>",
      "次の操作: 期限を見直す",
    ]);
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

function directClient(posted: Array<Record<string, unknown>>) {
  return {
    conversations: { open: async () => ({ channel: { id: "DDIRECT" } }) },
    chat: {
      postMessage: async (arguments_: Record<string, unknown>) => {
        posted.push(arguments_);
        return { ok: true, ts: "620.1" };
      },
    },
  } as unknown as ConstructorParameters<typeof SlackDirectLifecycleNotifier>[0];
}

function sectionLines(message: { blocks: Array<Record<string, unknown>> }): string[] {
  const section = message.blocks[0] as { text?: { text?: string } };
  return (section.text?.text ?? "").split("\n");
}
