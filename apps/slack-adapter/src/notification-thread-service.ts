import type { StateStore } from "./state-store.ts";

const THREAD_NAMESPACE = "work-thread";

interface NotificationThreadState {
  schemaVersion: 1;
  issueUrl: string;
  rootTs: string;
  createdAt: string;
}

export interface ThreadMessageResult {
  messageTs: string;
}

export class NotificationThreadService {
  private readonly store: StateStore;
  private readonly now: () => number;

  constructor(store: StateStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  async publish(
    resourceUrl: string,
    send: (threadTs: string | null) => Promise<ThreadMessageResult>,
  ): Promise<string> {
    const thread = await this.store.get<NotificationThreadState>(THREAD_NAMESPACE, resourceUrl);
    const result = await send(thread?.rootTs ?? null);
    if (!thread) {
      await this.store.create<NotificationThreadState>(THREAD_NAMESPACE, resourceUrl, {
        schemaVersion: 1,
        issueUrl: resourceUrl,
        rootTs: result.messageTs,
        createdAt: new Date(this.now()).toISOString(),
      });
    }
    return thread?.rootTs ?? result.messageTs;
  }
}
