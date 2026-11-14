import type { WebClient } from "@slack/web-api";
import type { LifecycleNotification, LifecycleNotifier } from "./lifecycle-notification-service.ts";
import type {
  NotificationIntentMetadata,
  NotificationRequiredActionKind,
} from "./notification-outbox.ts";
import { type SlackMessageTone, slackPlain } from "./slack-message-style.ts";
import type { HumanWorkItem } from "./types.ts";
import type {
  WorkNotificationContext,
  WorkNotificationResult,
  WorkNotifier,
} from "./work-notification-service.ts";

export interface SlackDirectConversationClient {
  conversations: {
    open(arguments_: { users: string; return_im: true }): Promise<{ channel?: { id?: string } }>;
  };
}

type SlackDirectClient = Pick<WebClient, "chat"> & SlackDirectConversationClient;

export async function resolveSlackDirectChannel(
  client: SlackDirectConversationClient,
  slackUserId: string,
): Promise<string> {
  if (!/^[UW][A-Z0-9]{2,31}$/.test(slackUserId)) {
    throw new Error("DM通知のSlack user IDが不正です。");
  }
  const response = await client.conversations.open({
    users: slackUserId,
    return_im: true,
  });
  const channelId = response.channel?.id;
  if (!channelId || !/^D[A-Z0-9]{2,31}$/.test(channelId)) {
    throw new Error("Slack DM conversation IDを取得できませんでした。");
  }
  return channelId;
}

export class SlackDirectLifecycleNotifier implements LifecycleNotifier {
  private readonly client: SlackDirectClient;
  private readonly slackUserId: string;

  constructor(client: SlackDirectClient, slackUserId: string) {
    this.client = client;
    this.slackUserId = slackUserId;
  }

  async notify(
    notification: LifecycleNotification,
    _threadTs: string | null,
    metadata?: NotificationIntentMetadata,
  ): Promise<WorkNotificationResult> {
    const channelId = await resolveSlackDirectChannel(this.client, this.slackUserId);
    return postDirectMessage(
      this.client,
      channelId,
      directLifecycleMessage(notification, metadata),
      metadata,
    );
  }
}

export class SlackDirectWorkNotifier implements WorkNotifier {
  private readonly client: SlackDirectClient;
  private readonly slackUserId: string;

  constructor(client: SlackDirectClient, slackUserId: string) {
    this.client = client;
    this.slackUserId = slackUserId;
  }

  async notify(
    item: HumanWorkItem,
    context: WorkNotificationContext,
    metadata?: NotificationIntentMetadata,
  ): Promise<WorkNotificationResult> {
    const channelId = await resolveSlackDirectChannel(this.client, this.slackUserId);
    return postDirectMessage(
      this.client,
      channelId,
      directWorkMessage(item, context, metadata),
      metadata,
    );
  }

  async digest(): Promise<void> {
    throw new Error("日次digestはDM outboxから送信できません。");
  }
}

interface DirectMessage {
  /** 1行目の依頼文。fallback textにも同じ文を使う。 */
  request: string;
  tone: SlackMessageTone;
  /** 「@login から」のような依頼元。分からない場合はnull。 */
  from: string | null;
  /** Issue/PR番号とタイトルのリンク（mrkdwn）。 */
  target: string;
  nextAction: string | null;
  url: string;
  buttonActionId: string;
}

const DIRECT_REQUESTS: Record<
  NotificationRequiredActionKind,
  { request: string; tone: SlackMessageTone }
> = {
  "review-requested": { request: "レビューをお願いします", tone: "review" },
  "approval-wait": { request: "PRのreviewerを指定してください", tone: "warning" },
  "ci-failed": { request: "CIが失敗しました、修正してください", tone: "error" },
  "changes-requested": {
    request: "PRが差し戻されました、指摘を反映してください",
    tone: "warning",
  },
  "revision-pushed": {
    request: "差し戻したPRが修正されました、再レビューをお願いします",
    tone: "revision",
  },
  approved: { request: "PRが承認されました、マージを進めてください", tone: "approved" },
  mentioned: { request: "コメントでメンションされました、確認してください", tone: "comment" },
  assigned: { request: "Issueの担当になりました、内容を確認してください", tone: "action" },
  blocker: {
    request: "作業が止まっています、blockerの解消条件を確認してください",
    tone: "warning",
  },
  overdue: {
    request: "目標日を過ぎています、完了するか期限を見直してください",
    tone: "deadline",
  },
  "due-today": {
    request: "目標日は今日です、完了するか期限を見直してください",
    tone: "deadline",
  },
  conflict: { request: "PRがconflictしています、解消してください", tone: "warning" },
};

const GENERIC_REQUEST = { request: "対応をお願いします", tone: "action" as SlackMessageTone };

/** DMはHeader Blockを使わず、1行目で「何を頼まれたか」と「誰からか」を伝える。 */
export function directLifecycleMessage(
  notification: LifecycleNotification,
  metadata?: NotificationIntentMetadata,
): DirectMessage {
  const kind = metadata?.requiredAction?.kind ?? lifecycleRequiredActionKind(notification);
  const copy = kind ? DIRECT_REQUESTS[kind] : GENERIC_REQUEST;
  const issue = notification.resource;
  const issueLink = `<${issue.url}|#${issue.number} ${escapeMrkdwn(issue.title)}>`;
  const pullRequest = notification.pullRequest;
  return {
    ...copy,
    // check_runのsenderはpushした本人なので、CI起点の依頼は人ではなくGitHub Checksを依頼元にする。
    from:
      kind === "ci-failed" || kind === "approval-wait"
        ? "GitHub Checks から"
        : `@${escapeMrkdwn(notification.actorLogin)} から`,
    target: pullRequest
      ? `<${pullRequest.url}|PR #${pullRequest.number} ${escapeMrkdwn(pullRequest.title)}>（Issue <${issue.url}|#${issue.number}>）`
      : issueLink,
    nextAction: notification.nextAction,
    url: notification.actionUrl,
    buttonActionId: "ar.lifecycle.open",
  };
}

export function directWorkMessage(
  item: HumanWorkItem,
  context: WorkNotificationContext,
  metadata?: NotificationIntentMetadata,
): DirectMessage {
  const kind = metadata?.requiredAction?.kind ?? workRequiredActionKind(item);
  const copy = kind ? DIRECT_REQUESTS[kind] : GENERIC_REQUEST;
  return {
    ...copy,
    from: context.kind === "deadline" ? "GitHub Projectsの目標日から" : "GitHub Projectsの状態から",
    target: `<${item.url}|#${item.issueNumber} ${escapeMrkdwn(item.title)}>`,
    nextAction: item.nextAction,
    url: item.url,
    buttonActionId: "ar.open-github",
  };
}

async function postDirectMessage(
  client: Pick<WebClient, "chat">,
  channelId: string,
  message: DirectMessage,
  metadata?: NotificationIntentMetadata,
): Promise<WorkNotificationResult> {
  const firstLine = `${message.request}${message.from ? `（${message.from}）` : ""}`;
  const response = await client.chat.postMessage({
    channel: channelId,
    text: slackPlain(message.tone, firstLine),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `*${slackPlain(message.tone, message.request)}*${message.from ? `（${message.from}）` : ""}`,
            message.target,
            message.nextAction ? `次の操作: ${escapeMrkdwn(message.nextAction)}` : null,
          ]
            .filter((value): value is string => Boolean(value))
            .join("\n"),
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "GitHubで開く" },
            url: message.url,
            action_id: message.buttonActionId,
          },
        ],
      },
    ],
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
    throw new Error("Slack DM通知のmessage tsを取得できませんでした。");
  }
  return { messageTs: response.ts };
}

/** metadataに種別がない旧DM payloadの再送でも、通知種別から依頼文を復元する。 */
function lifecycleRequiredActionKind(
  notification: LifecycleNotification,
): NotificationRequiredActionKind | null {
  switch (notification.kind) {
    case "review-requested":
      return "review-requested";
    case "ci-failed":
      return notification.summary.includes("reviewer") ? "approval-wait" : "ci-failed";
    case "review-changes-requested":
      return "changes-requested";
    case "revision-pushed":
      return "revision-pushed";
    case "review-approved":
      return "approved";
    case "comment-created":
    case "review-commented":
      return "mentioned";
    case "issue-assignment-changed":
      return "assigned";
    default:
      return null;
  }
}

function workRequiredActionKind(item: HumanWorkItem): NotificationRequiredActionKind | null {
  switch (item.reasonCode) {
    case "BLOCKED":
      return "blocker";
    case "OVERDUE":
      return "overdue";
    case "DUE_TODAY":
      return "due-today";
    case "CONFLICTING":
      return "conflict";
    default:
      return null;
  }
}

function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
