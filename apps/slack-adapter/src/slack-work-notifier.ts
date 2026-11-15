import type { KnownBlock, WebClient } from "@slack/web-api";
import { unreachableRecipientLines } from "./notification-mode.ts";
import type { NotificationIntentMetadata } from "./notification-outbox.ts";
import { workItemBlocks } from "./presentation.ts";
import { slackDivider, slackHeader, slackPlain } from "./slack-message-style.ts";
import type { HumanWorkItem } from "./types.ts";
import type {
  DigestCategory,
  WorkDiffDigest,
  WorkDiffDigestGroup,
  WorkDiffDigestLine,
} from "./work-diff-digest.ts";
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
        ...(context.unreachableRecipients?.length
          ? [
              {
                type: "section" as const,
                text: {
                  type: "mrkdwn" as const,
                  text: unreachableRecipientLines(context.unreachableRecipients).join("\n"),
                },
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

  async diffDigest(digest: WorkDiffDigest, metadata?: NotificationIntentMetadata): Promise<void> {
    const message = diffDigestMessage(digest);
    await this.client.chat.postMessage({
      channel: this.channelId,
      text: message.text,
      blocks: message.blocks,
      ...(metadata ? { metadata: slackMetadata(metadata.intentId) } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
  }
}

/** Slackのsection textとblock数の上限。 */
export const SLACK_SECTION_TEXT_LIMIT = 3000;
export const SLACK_BLOCK_LIMIT = 50;

const CATEGORY_LABEL: Record<DigestCategory, { emoji: string; label: string }> = {
  attention: { emoji: "🚨", label: "止まり・期限超過" },
  completed: { emoji: "✅", label: "完了" },
  new: { emoji: "🆕", label: "新規" },
  changed: { emoji: "🔁", label: "変更" },
  removed: { emoji: "📤", label: "Projectから外れた" },
};

const CATEGORY_ORDER: DigestCategory[] = ["attention", "completed", "new", "changed", "removed"];

/**
 * 差分digestをSlackの投稿へ描画する。人名はmentionせずGitHub loginのまま書く。
 * Work・Businessごとに1つのsectionにし、section textとblock数の上限を超えないよう行を削る。
 */
export function diffDigestMessage(digest: WorkDiffDigest): {
  text: string;
  blocks: KnownBlock[];
} {
  const summary = CATEGORY_ORDER.filter((category) => digest.counts[category] > 0)
    .map((category) => `${CATEGORY_LABEL[category].label} ${digest.counts[category]}件`)
    .join("、");
  const blocks: KnownBlock[] = [
    slackHeader("digest", `ART-TRA Work 前日からの変化（${digest.date}）`),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: escapeSlackText(`${digest.baselineDate} からの変化: ${summary}`),
        },
      ],
    },
    slackDivider(),
  ];
  // block数の上限で載せられないブロックも、件数の上限で省いた分と合わせてfooterに数える。
  const available = SLACK_BLOCK_LIMIT - blocks.length;
  const needsFooter = digest.hiddenGroupCount > 0 || digest.groups.length > available;
  const room = needsFooter ? available - 1 : available;
  const shown = digest.groups.slice(0, room);
  const dropped = digest.groups.slice(room);
  for (const group of shown) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: groupSectionText(group) },
    });
  }
  if (needsFooter) {
    const hiddenGroups = digest.hiddenGroupCount + dropped.length;
    const hiddenChanges =
      digest.hiddenGroupChangeCount +
      dropped.reduce((total, group) => total + group.lines.length + group.hiddenLineCount, 0);
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `ほか${hiddenGroups}件のWork・Businessに${hiddenChanges}件の変化があります。GitHub Projectsで確認してください。`,
        },
      ],
    });
  }
  return {
    text: slackPlain("digest", `ART-TRA Workの前日からの変化: ${summary}`),
    blocks,
  };
}

/** Project #8に無い親（parent）は種別が分からないため、WorkやBusinessと書かない。 */
const GROUP_KIND_LABEL: Record<Exclude<WorkDiffDigestGroup["kind"], "other">, string> = {
  work: "Work",
  business: "Business",
  parent: "親",
};

function groupSectionText(group: WorkDiffDigestGroup): string {
  const heading =
    group.kind === "other"
      ? "*その他（親の分からないTask・Intake）*"
      : `*${GROUP_KIND_LABEL[group.kind]}: ${issueLink(group.url ?? "", group.issueNumber, group.title)}*`;
  const lines = group.lines.map(lineText);
  let hidden = group.hiddenLineCount;
  const compose = () => [heading, ...lines, ...(hidden > 0 ? [`…ほか${hidden}件`] : [])].join("\n");
  // 長いタイトルが続いても3000字を超えないよう、末尾の行から「ほか n 件」へ回す。
  while (compose().length > SLACK_SECTION_TEXT_LIMIT && lines.length > 0) {
    lines.pop();
    hidden += 1;
  }
  const text = compose();
  return text.length > SLACK_SECTION_TEXT_LIMIT
    ? `${text.slice(0, SLACK_SECTION_TEXT_LIMIT - 1)}…`
    : text;
}

function lineText(line: WorkDiffDigestLine): string {
  return `${CATEGORY_LABEL[line.category].emoji} ${issueLink(line.url, line.issueNumber, line.title)} — ${escapeSlackText(line.detail)}`;
}

function issueLink(url: string, issueNumber: number | null, title: string): string {
  const label = escapeSlackText(
    issueNumber !== null ? [`#${issueNumber}`, title].filter(Boolean).join(" ") : title,
  );
  return url ? `<${url}|${label}>` : label;
}

/** mrkdwnの制御文字を無効にし、<!channel>や<@U…>のようなmentionを作らせない。 */
function escapeSlackText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function slackMetadata(intentId: string) {
  return {
    event_type: "arttra_notification",
    event_payload: { intent_id: intentId },
  };
}
