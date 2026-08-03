import { randomUUID } from "node:crypto";
import { RetryableWorkError } from "./retryable-error.ts";
import type { StateStore } from "./state-store.ts";

const THREAD_NAMESPACE = "work-thread";
const ROOT_LEASE_MILLISECONDS = 60_000;

interface LegacyNotificationThreadState {
  schemaVersion: 1;
  issueUrl: string;
  rootTs: string;
  createdAt: string;
}

interface CreatingNotificationThreadState {
  schemaVersion: 2;
  revision: number;
  status: "creating";
  issueUrl: string;
  owner: string;
  leaseExpiresAt: string;
  createdAt: string;
}

interface ReadyNotificationThreadState {
  schemaVersion: 2;
  revision: number;
  status: "ready";
  issueUrl: string;
  rootTs: string;
  createdAt: string;
  readyAt: string;
}

type NotificationThreadState =
  | LegacyNotificationThreadState
  | CreatingNotificationThreadState
  | ReadyNotificationThreadState;

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

  async ensureRoot(
    resourceUrl: string,
    createRoot: () => Promise<ThreadMessageResult>,
  ): Promise<string> {
    const owner = randomUUID();
    const claimed = await this.claimRootCreation(resourceUrl, owner);
    if (typeof claimed === "string") return claimed;

    const result = await createRoot();
    const ready: ReadyNotificationThreadState = {
      schemaVersion: 2,
      revision: claimed.revision + 1,
      status: "ready",
      issueUrl: resourceUrl,
      rootTs: result.messageTs,
      createdAt: claimed.createdAt,
      readyAt: new Date(this.now()).toISOString(),
    };
    if (!(await this.store.compareAndSet(THREAD_NAMESPACE, resourceUrl, claimed.revision, ready))) {
      const current = await this.store.get<NotificationThreadState>(THREAD_NAMESPACE, resourceUrl);
      if (isReady(current)) return current.rootTs;
      throw new RetryableWorkError(
        "notification_thread_root_completion_conflict",
        "Issue通知threadのroot保存が競合しました。状態を確認して自動で再試行します。",
      );
    }
    return ready.rootTs;
  }

  async publishReply(
    resourceUrl: string,
    createRoot: () => Promise<ThreadMessageResult>,
    sendReply: (threadTs: string) => Promise<ThreadMessageResult>,
  ): Promise<string> {
    const rootTs = await this.ensureRoot(resourceUrl, createRoot);
    await sendReply(rootTs);
    return rootTs;
  }

  async publish(
    resourceUrl: string,
    send: (threadTs: string | null) => Promise<ThreadMessageResult>,
  ): Promise<string> {
    const thread = await this.store.get<NotificationThreadState>(THREAD_NAMESPACE, resourceUrl);
    if (thread && !hasRoot(thread)) throw rootCreationInProgress();
    const existingRootTs = hasRoot(thread) ? thread.rootTs : null;
    const result = await send(existingRootTs);
    if (!thread) {
      await this.store.create<NotificationThreadState>(THREAD_NAMESPACE, resourceUrl, {
        schemaVersion: 1,
        issueUrl: resourceUrl,
        rootTs: result.messageTs,
        createdAt: new Date(this.now()).toISOString(),
      });
    }
    return existingRootTs ?? result.messageTs;
  }

  private async claimRootCreation(
    resourceUrl: string,
    owner: string,
  ): Promise<string | CreatingNotificationThreadState> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.store.get<NotificationThreadState>(THREAD_NAMESPACE, resourceUrl);
      if (hasRoot(current)) return current.rootTs;

      const now = this.now();
      if (!current) {
        const fresh = creatingState(resourceUrl, owner, 1, now);
        if (await this.store.create(THREAD_NAMESPACE, resourceUrl, fresh)) return fresh;
        continue;
      }
      if (current.schemaVersion !== 2 || current.status !== "creating") {
        throw new Error("Issue通知threadの保存状態が不正です。");
      }
      if (Date.parse(current.leaseExpiresAt) > now) {
        throw rootCreationInProgress();
      }
      const takeover = creatingState(resourceUrl, owner, current.revision + 1, now);
      if (
        await this.store.compareAndSet(THREAD_NAMESPACE, resourceUrl, current.revision, takeover)
      ) {
        return takeover;
      }
    }
    throw rootCreationInProgress();
  }
}

function creatingState(
  issueUrl: string,
  owner: string,
  revision: number,
  now: number,
): CreatingNotificationThreadState {
  return {
    schemaVersion: 2,
    revision,
    status: "creating",
    issueUrl,
    owner,
    leaseExpiresAt: new Date(now + ROOT_LEASE_MILLISECONDS).toISOString(),
    createdAt: new Date(now).toISOString(),
  };
}

function hasRoot(
  state: NotificationThreadState | null,
): state is LegacyNotificationThreadState | ReadyNotificationThreadState {
  return state?.schemaVersion === 1 || state?.status === "ready";
}

function isReady(state: NotificationThreadState | null): state is ReadyNotificationThreadState {
  return state?.schemaVersion === 2 && state.status === "ready";
}

function rootCreationInProgress(): RetryableWorkError {
  return new RetryableWorkError(
    "notification_thread_root_in_progress",
    "Issue通知threadのrootを別のworkerが作成中です。完了後に自動で再試行します。",
  );
}
