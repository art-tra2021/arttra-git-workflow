import type {
  NotificationOutboxState,
  NotificationReconciler,
  NotificationReconciliation,
} from "./notification-outbox.ts";
import type { StateStore } from "./state-store.ts";

const THREAD_NAMESPACE = "work-thread";
const PAGE_LIMIT = 200;
const MAX_PAGES = 10;
const SEARCH_BEFORE_MILLISECONDS = 5 * 60_000;
const SEARCH_AFTER_MILLISECONDS = 15 * 60_000;

interface SlackMessage {
  ts?: string;
  metadata?: {
    event_type?: string;
    event_payload?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

interface SlackConversationPage {
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

export interface SlackConversationClient {
  conversations: {
    history(arguments_: Record<string, unknown>): Promise<SlackConversationPage>;
    replies(arguments_: Record<string, unknown>): Promise<SlackConversationPage>;
  };
}

interface NotificationThreadState {
  schemaVersion: 1;
  issueUrl: string;
  rootTs: string;
  createdAt: string;
}

export class SlackNotificationReconciler implements NotificationReconciler {
  private readonly client: SlackConversationClient;
  private readonly store: StateStore;
  private readonly now: () => number;

  constructor(client: SlackConversationClient, store: StateStore, now: () => number = Date.now) {
    this.client = client;
    this.store = store;
    this.now = now;
  }

  async reconcile(state: NotificationOutboxState): Promise<NotificationReconciliation> {
    const checkedAt = new Date(this.now()).toISOString();
    try {
      const threadTs = await this.resolveThreadTs(state);
      const result = threadTs
        ? await this.scan(
            "replies",
            {
              channel: state.channelId,
              ts: threadTs,
              inclusive: true,
              include_all_metadata: true,
              limit: PAGE_LIMIT,
            },
            state.intentId,
          )
        : await this.scan("history", this.historyArguments(state), state.intentId);
      if (result.match?.ts) {
        return {
          schemaVersion: 1,
          method: "slack-conversations-api",
          outcome: "message_found",
          checkedAt,
          channelId: state.channelId,
          scannedMessages: result.scannedMessages,
          complete: true,
          messageTs: result.match.ts,
          reason: "outbox intent IDが一致するSlackメッセージを確認しました。",
        };
      }
      if (!result.complete) {
        return {
          schemaVersion: 1,
          method: "slack-conversations-api",
          outcome: "inconclusive",
          checkedAt,
          channelId: state.channelId,
          scannedMessages: result.scannedMessages,
          complete: false,
          reason: "Slack APIの全ページを確認できませんでした。安全のため再送しません。",
        };
      }
      return {
        schemaVersion: 1,
        method: "slack-conversations-api",
        outcome: "message_not_found",
        checkedAt,
        channelId: state.channelId,
        scannedMessages: result.scannedMessages,
        complete: true,
        reason: "対象時間帯またはIssue threadに同じoutbox intent IDはありませんでした。",
      };
    } catch (error) {
      return {
        schemaVersion: 1,
        method: "slack-conversations-api",
        outcome: "inconclusive",
        checkedAt,
        channelId: state.channelId,
        scannedMessages: 0,
        complete: false,
        reason: `Slack照合に失敗しました: ${failureCode(error)}`,
      };
    }
  }

  private async resolveThreadTs(state: NotificationOutboxState): Promise<string | null> {
    if (state.payload.kind === "lifecycle" && state.payload.threadTs) {
      return state.payload.threadTs;
    }
    if (state.payload.kind === "work" && state.payload.context.threadTs) {
      return state.payload.context.threadTs;
    }
    const resourceUrl = payloadResourceUrl(state);
    if (!resourceUrl) return null;
    const thread = await this.store.get<NotificationThreadState>(THREAD_NAMESPACE, resourceUrl);
    return thread?.rootTs ?? null;
  }

  private historyArguments(state: NotificationOutboxState): Record<string, unknown> {
    const startedAt = Date.parse(state.sendingStartedAt ?? state.updatedAt);
    if (!Number.isFinite(startedAt)) {
      throw new Error("notification_sending_time_invalid");
    }
    return {
      channel: state.channelId,
      oldest: ((startedAt - SEARCH_BEFORE_MILLISECONDS) / 1000).toFixed(6),
      latest: ((startedAt + SEARCH_AFTER_MILLISECONDS) / 1000).toFixed(6),
      inclusive: true,
      include_all_metadata: true,
      limit: PAGE_LIMIT,
    };
  }

  private async scan(
    method: "history" | "replies",
    baseArguments: Record<string, unknown>,
    intentId: string,
  ): Promise<{ match: SlackMessage | null; scannedMessages: number; complete: boolean }> {
    let cursor: string | undefined;
    let scannedMessages = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.client.conversations[method]({
        ...baseArguments,
        ...(cursor ? { cursor } : {}),
      });
      const messages = response.messages ?? [];
      scannedMessages += messages.length;
      const match = messages.find((message) => messageIntentId(message) === intentId);
      if (match) return { match, scannedMessages, complete: true };
      cursor = response.response_metadata?.next_cursor?.trim() || undefined;
      if (!cursor && !response.has_more) {
        return { match: null, scannedMessages, complete: true };
      }
    }
    return { match: null, scannedMessages, complete: false };
  }
}

function payloadResourceUrl(state: NotificationOutboxState): string | null {
  if (state.payload.kind === "lifecycle") return state.payload.notification.resource.url;
  if (state.payload.kind === "work") return state.payload.item.url;
  return null;
}

function messageIntentId(message: SlackMessage): string | null {
  if (message.metadata?.event_type !== "arttra_notification") return null;
  const value = message.metadata.event_payload?.intent_id;
  return typeof value === "string" ? value : null;
}

function failureCode(error: unknown): string {
  if (error && typeof error === "object") {
    const data = (error as { data?: { error?: unknown } }).data;
    if (typeof data?.error === "string" && data.error) return data.error;
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  return error instanceof Error && error.name ? error.name : "unknown_error";
}
