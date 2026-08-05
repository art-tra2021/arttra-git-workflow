import type { WebClient } from "@slack/web-api";
import type { LifecycleNotification, LifecycleNotifier } from "./lifecycle-notification-service.ts";
import type { NotificationIntentMetadata } from "./notification-outbox.ts";
import { SlackLifecycleNotifier } from "./slack-lifecycle-notifier.ts";
import { SlackWorkNotifier } from "./slack-work-notifier.ts";
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
    return new SlackLifecycleNotifier(this.client, channelId, { direct: true }).notify(
      notification,
      null,
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
    return new SlackWorkNotifier(this.client, channelId, { direct: true }).notify(
      item,
      { ...context, threadTs: null },
      metadata,
    );
  }

  async digest(): Promise<void> {
    throw new Error("日次digestはDM outboxから送信できません。");
  }
}
