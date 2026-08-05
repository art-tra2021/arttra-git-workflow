import type { WebClient } from "@slack/web-api";
import type { NotificationIntentMetadata } from "./notification-outbox.ts";
import { workItemBlocks } from "./presentation.ts";
import { slackDivider, slackHeader, slackPlain } from "./slack-message-style.ts";
import type { HumanWorkItem } from "./types.ts";
import type {
  WorkNotificationContext,
  WorkNotificationResult,
  WorkNotifier,
} from "./work-notification-service.ts";

export class SlackWorkNotifier implements WorkNotifier {
  private readonly client: Pick<WebClient, "chat">;
  private readonly channelId: string;
  private readonly direct: boolean;

  constructor(
    client: Pick<WebClient, "chat">,
    channelId: string,
    options: { direct?: boolean } = {},
  ) {
    this.client = client;
    this.channelId = channelId;
    this.direct = options.direct ?? false;
  }

  async notify(
    item: HumanWorkItem,
    context: WorkNotificationContext,
    metadata?: NotificationIntentMetadata,
  ): Promise<WorkNotificationResult> {
    const mention = !this.direct && context.slackUserId ? `<@${context.slackUserId}> ` : "";
    const tone = context.kind === "deadline" ? "deadline" : "work";
    const label = context.kind === "deadline" ? "期限のお知らせ" : "作業状況の更新";
    const response = await this.client.chat.postMessage({
      channel: this.channelId,
      text: `${mention}${slackPlain(tone, `#${item.issueNumber} ${item.title}: ${item.nextAction}`)}`,
      blocks: [
        slackHeader(tone, label),
        ...(mention
          ? [
              {
                type: "section" as const,
                text: { type: "mrkdwn" as const, text: mention.trim() },
              },
            ]
          : []),
        slackDivider(),
        ...workItemBlocks(item),
      ],
      ...(!this.direct && context.threadTs
        ? { thread_ts: context.threadTs, reply_broadcast: false }
        : {}),
      ...(metadata ? { metadata: slackMetadata(metadata.intentId) } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!response.ts) {
      throw new Error("Slack作業通知のmessage tsを取得できませんでした。");
    }
    return { messageTs: response.ts };
  }

  async digest(items: HumanWorkItem[], metadata?: NotificationIntentMetadata): Promise<void> {
    const visible = items.slice(0, 20);
    const lines = visible.map(
      (item) =>
        `• <${item.url}|#${item.issueNumber} ${item.title}> — ${item.priority} / ${item.nextActor} / ${item.nextAction}${item.targetDate ? ` / ${item.targetDate}` : ""}`,
    );
    if (items.length > visible.length) {
      lines.push(`• ほか${items.length - visible.length}件はGitHub Projectsで確認してください。`);
    }
    await this.client.chat.postMessage({
      channel: this.channelId,
      text: slackPlain("digest", `ART-TRAの未完了作業は${items.length}件です。`),
      blocks: [
        slackHeader("digest", `ART-TRA 作業ダイジェスト（${items.length}件）`),
        slackDivider(),
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: lines.join("\n"),
          },
        },
      ],
      ...(metadata ? { metadata: slackMetadata(metadata.intentId) } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
  }
}

function slackMetadata(intentId: string) {
  return {
    event_type: "arttra_notification",
    event_payload: { intent_id: intentId },
  };
}
