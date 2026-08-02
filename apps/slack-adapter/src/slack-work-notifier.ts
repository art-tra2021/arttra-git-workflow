import type { WebClient } from "@slack/web-api";
import { workItemBlocks } from "./presentation.ts";
import { slackHeading, slackPlain } from "./slack-message-style.ts";
import type { HumanWorkItem } from "./types.ts";
import type {
  WorkNotificationContext,
  WorkNotificationResult,
  WorkNotifier,
} from "./work-notification-service.ts";

export class SlackWorkNotifier implements WorkNotifier {
  private readonly client: Pick<WebClient, "chat">;
  private readonly channelId: string;

  constructor(client: Pick<WebClient, "chat">, channelId: string) {
    this.client = client;
    this.channelId = channelId;
  }

  async notify(
    item: HumanWorkItem,
    context: WorkNotificationContext,
  ): Promise<WorkNotificationResult> {
    const mention = context.slackUserId ? `<@${context.slackUserId}> ` : "";
    const tone = context.kind === "deadline" ? "deadline" : "work";
    const label = context.kind === "deadline" ? "期限のお知らせ" : "作業状況の更新";
    const response = await this.client.chat.postMessage({
      channel: this.channelId,
      text: `${mention}${slackPlain(tone, `#${item.issueNumber} ${item.title}: ${item.nextAction}`)}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${mention}${slackHeading(tone, label)}`,
          },
        },
        ...workItemBlocks(item),
      ],
      ...(context.threadTs ? { thread_ts: context.threadTs, reply_broadcast: false } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!response.ts) {
      throw new Error("Slack作業通知のmessage tsを取得できませんでした。");
    }
    return { messageTs: response.ts };
  }

  async digest(items: HumanWorkItem[]): Promise<void> {
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
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${slackHeading("digest", `ART-TRA 作業ダイジェスト（${items.length}件）`)}\n${lines.join("\n")}`,
          },
        },
      ],
      unfurl_links: false,
      unfurl_media: false,
    });
  }
}
