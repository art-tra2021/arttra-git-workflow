import type { WebClient } from "@slack/web-api";
import { workItemBlocks } from "./presentation.ts";
import type { HumanWorkItem } from "./types.ts";
import type { WorkNotifier } from "./work-notification-service.ts";

export class SlackWorkNotifier implements WorkNotifier {
  private readonly client: Pick<WebClient, "chat">;
  private readonly channelId: string;

  constructor(client: Pick<WebClient, "chat">, channelId: string) {
    this.client = client;
    this.channelId = channelId;
  }

  async notify(item: HumanWorkItem): Promise<void> {
    await this.client.chat.postMessage({
      channel: this.channelId,
      text: `#${item.issueNumber} ${item.title}: ${item.nextAction}`,
      blocks: workItemBlocks(item),
      unfurl_links: false,
      unfurl_media: false,
    });
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
      text: `ART-TRAの未完了作業は${items.length}件です。`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*ART-TRA 作業ダイジェスト（${items.length}件）*\n${lines.join("\n")}`,
          },
        },
      ],
      unfurl_links: false,
      unfurl_media: false,
    });
  }
}
