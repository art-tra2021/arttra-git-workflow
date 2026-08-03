import type { WebClient } from "@slack/web-api";
import type {
  LifecycleNotification,
  LifecycleNotificationKind,
  LifecycleNotifier,
} from "./lifecycle-notification-service.ts";
import type { NotificationIntentMetadata } from "./notification-outbox.ts";
import type { ThreadMessageResult } from "./notification-thread-service.ts";
import { lifecycleTone, slackDivider, slackHeader, slackPlain } from "./slack-message-style.ts";

export class SlackLifecycleNotifier implements LifecycleNotifier {
  private readonly client: Pick<WebClient, "chat">;
  private readonly channelId: string;

  constructor(client: Pick<WebClient, "chat">, channelId: string) {
    this.client = client;
    this.channelId = channelId;
  }

  async notify(
    notification: LifecycleNotification,
    threadTs: string | null,
    metadata?: NotificationIntentMetadata,
  ): Promise<ThreadMessageResult> {
    if (!threadTs && notification.kind !== "issue-opened") {
      throw new Error(
        `Issue threadが見つからないため、${notification.kind}通知のchannel直下への送信を停止しました。`,
      );
    }
    const mentions = notification.slackUserIds.map((userId) => `<@${userId}>`).join(" ");
    const target = notification.pullRequest ?? notification.resource;
    const tone = lifecycleTone(notification.kind);
    const label = kindLabel(notification);
    const replyBroadcast = isSelfMergeNotice(notification.kind);
    const response = await this.client.chat.postMessage({
      channel: this.channelId,
      text: `${mentions ? `${mentions} ` : ""}${slackPlain(tone, notification.summary)} ${target.url}`,
      blocks: [
        slackHeader(tone, label),
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: [
              mentions,
              `*<${notification.resource.url}|#${notification.resource.number} ${escapeMrkdwn(notification.resource.title)}>*`,
              notification.pullRequest
                ? `*PR:* <${notification.pullRequest.url}|#${notification.pullRequest.number} ${escapeMrkdwn(notification.pullRequest.title)}>`
                : null,
              `*実行者:* ${actorLabel(notification)}`,
              `*内容:* ${escapeMrkdwn(notification.detail)}`,
            ]
              .filter((value): value is string => Boolean(value))
              .join("\n"),
          },
        },
        slackDivider(),
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*次の操作*\n${escapeMrkdwn(notification.nextAction)}`,
          },
        },
        {
          type: "actions",
          elements: [
            ...(notification.selfMergeControl
              ? [
                  {
                    type: "button" as const,
                    text: { type: "plain_text" as const, text: "セルフマージを停止" },
                    style: "danger" as const,
                    action_id: "ar.self-merge.stop",
                    value: JSON.stringify(notification.selfMergeControl),
                  },
                ]
              : []),
            {
              type: "button",
              text: { type: "plain_text", text: "GitHubで確認" },
              url: notification.actionUrl,
              action_id: "ar.lifecycle.open",
            },
          ],
        },
      ],
      ...(threadTs
        ? replyBroadcast
          ? { thread_ts: threadTs, reply_broadcast: true as const }
          : { thread_ts: threadTs, reply_broadcast: false as const }
        : {}),
      ...(metadata
        ? {
            metadata: {
              event_type: "arttra_notification",
              event_payload: { intent_id: metadata.intentId },
            },
          }
        : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!response.ts) {
      throw new Error("Slackライフサイクル通知のmessage tsを取得できませんでした。");
    }
    return { messageTs: response.ts };
  }
}

function isSelfMergeNotice(kind: LifecycleNotificationKind): boolean {
  return kind === "self-merge-scheduled";
}

function actorLabel(notification: LifecycleNotification): string {
  return notification.actorSlackUserId &&
    /^[A-Z][A-Z0-9]{1,31}$/.test(notification.actorSlackUserId)
    ? `<@${notification.actorSlackUserId}>`
    : `@${escapeMrkdwn(notification.actorLogin)}`;
}

function kindLabel(notification: LifecycleNotification): string {
  if (notification.kind === "issue-opened") {
    const labels = {
      intake: "新しいIntake",
      work: "新しいWork",
      task: "新しいTask",
      business: "新しいBusiness",
    } as const;
    return notification.issueType ? labels[notification.issueType] : "新しいIssue";
  }
  const labels: Record<LifecycleNotificationKind, string> = {
    "issue-opened": "新しいIssue",
    "issue-reopened": "Issueが再開されました",
    "issue-assignment-changed": "Issueの担当者変更",
    "comment-created": "コメントが追加されました",
    "issue-completed": "Issueが完了しました",
    "pr-merged": "PRがマージされました",
    "review-requested": "PR作成・レビュー依頼",
    "review-approved": "PRが承認されました",
    "review-changes-requested": "PRが差し戻されました",
    "review-commented": "レビューコメントが追加されました",
    "review-dismissed": "レビュー結果が取り消されました",
    "revision-pushed": "差し戻し後の修正がpushされました",
    "ci-failed": "🚨 CIに対応が必要です",
    "self-merge-scheduled": "⚠️ セルフマージ予定",
    "self-merge-ready": "⚠️ セルフマージ予定・CI通過",
  };
  return labels[notification.kind];
}

function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
