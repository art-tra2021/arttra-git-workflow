import { createHash } from "node:crypto";
import {
  parseIssueReferenceUrl,
  resolveNotificationThreadRootIssue,
} from "./lifecycle-notification-service.ts";
import { type NotificationIntentMetadata, notificationIntentId } from "./notification-outbox.ts";
import { NotificationThreadService } from "./notification-thread-service.ts";
import type { GitHubLifecycleClient } from "./review-types.ts";
import type { StateStore } from "./state-store.ts";
import type { HumanWorkItem } from "./types.ts";

const NOTIFICATION_NAMESPACE = "work-notification";
const DEADLINE_NAMESPACE = "work-deadline-notification";
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

export interface WorkItemSource {
  loadProjectItems(): Promise<HumanWorkItem[]>;
}

export interface WorkNotifier {
  notify(
    item: HumanWorkItem,
    context: WorkNotificationContext,
    metadata?: NotificationIntentMetadata,
  ): Promise<WorkNotificationResult>;
  digest(items: HumanWorkItem[], metadata?: NotificationIntentMetadata): Promise<void>;
}

export interface WorkNotificationContext {
  kind: "state" | "deadline";
  threadTs: string | null;
  slackUserId: string | null;
}

export interface WorkNotificationResult {
  messageTs: string;
}

export type ResolveSlackUserId = (githubLogin: string) => Promise<string | null>;

interface WorkNotificationState {
  schemaVersion: 1;
  issueUrl: string;
  fingerprint: string;
  notifiedAt: string;
}

type DeadlineStage = "due-soon" | "due-today" | "overdue";

interface WorkDeadlineNotificationState {
  schemaVersion: 1;
  issueUrl: string;
  targetDate: string;
  stage: DeadlineStage;
  notifiedAt: string;
}

export class WorkNotificationService {
  private readonly source: WorkItemSource;
  private readonly store: StateStore;
  private readonly notifier: WorkNotifier;
  private readonly now: () => number;
  private readonly resolveSlackUserId: ResolveSlackUserId;
  private readonly deadlineLeadDays: number;
  private readonly threads: NotificationThreadService;
  private readonly github: Pick<GitHubLifecycleClient, "loadIssueContext"> | null;

  constructor(
    source: WorkItemSource,
    store: StateStore,
    notifier: WorkNotifier,
    now: () => number = Date.now,
    resolveSlackUserId: ResolveSlackUserId = async () => null,
    deadlineLeadDays = 3,
    threads: NotificationThreadService = new NotificationThreadService(store, now),
    github: Pick<GitHubLifecycleClient, "loadIssueContext"> | null = null,
  ) {
    if (!Number.isSafeInteger(deadlineLeadDays) || deadlineLeadDays < 1 || deadlineLeadDays > 30) {
      throw new Error("期限通知の日数は1日から30日で指定してください。");
    }
    this.source = source;
    this.store = store;
    this.notifier = notifier;
    this.now = now;
    this.resolveSlackUserId = resolveSlackUserId;
    this.deadlineLeadDays = deadlineLeadDays;
    this.threads = threads;
    this.github = github;
  }

  async notifyImmediate(sourceDeliveryId?: string): Promise<number> {
    const items = await this.source.loadProjectItems();
    let notified = 0;
    for (const item of items) {
      if (item.delivery !== "immediate") {
        await this.store.remove(NOTIFICATION_NAMESPACE, item.url);
        continue;
      }
      const fingerprint = workFingerprint(item);
      const previous = await this.store.get<WorkNotificationState>(
        NOTIFICATION_NAMESPACE,
        item.url,
      );
      if (previous?.fingerprint === fingerprint) {
        continue;
      }
      const sent = await this.notifyThreaded(item, "state", {
        intentId: notificationIntentId({ kind: "work-state", issueUrl: item.url, fingerprint }),
        ...(sourceDeliveryId ? { sourceDeliveryId } : {}),
      });
      if (!sent) continue;
      await this.store.set<WorkNotificationState>(NOTIFICATION_NAMESPACE, item.url, {
        schemaVersion: 1,
        issueUrl: item.url,
        fingerprint,
        notifiedAt: new Date(this.now()).toISOString(),
      });
      notified += 1;
    }
    return notified;
  }

  async notifyDeadlines(): Promise<number> {
    const items = await this.source.loadProjectItems();
    const today = dateInTokyo(this.now());
    let notified = 0;
    for (const item of items) {
      const stage = deadlineStage(item, today, this.deadlineLeadDays);
      if (!stage || !item.targetDate) {
        await this.store.remove(DEADLINE_NAMESPACE, item.url);
        continue;
      }
      const previous = await this.store.get<WorkDeadlineNotificationState>(
        DEADLINE_NAMESPACE,
        item.url,
      );
      if (previous?.targetDate === item.targetDate && previous.stage === stage) {
        continue;
      }
      const sent = await this.notifyThreaded(deadlineWorkItem(item, stage, today), "deadline", {
        intentId: notificationIntentId({
          kind: "work-deadline",
          issueUrl: item.url,
          targetDate: item.targetDate,
          stage,
        }),
      });
      if (!sent) continue;
      await this.store.set<WorkDeadlineNotificationState>(DEADLINE_NAMESPACE, item.url, {
        schemaVersion: 1,
        issueUrl: item.url,
        targetDate: item.targetDate,
        stage,
        notifiedAt: new Date(this.now()).toISOString(),
      });
      notified += 1;
    }
    return notified;
  }

  async sendDigest(): Promise<number> {
    const items = (await this.source.loadProjectItems())
      .filter((item) => item.delivery !== "silent")
      .sort(compareWorkItems);
    if (items.length > 0) {
      await this.notifier.digest(items, {
        intentId: notificationIntentId({
          kind: "work-digest",
          date: dateInTokyo(this.now()),
          items: items.map((item) => ({
            url: item.url,
            reasonCode: item.reasonCode,
            nextAction: item.nextAction,
          })),
        }),
      });
    }
    return items.length;
  }

  private async notifyThreaded(
    item: HumanWorkItem,
    kind: WorkNotificationContext["kind"],
    metadata: NotificationIntentMetadata,
  ): Promise<boolean> {
    const slackUserId = item.owner ? await this.resolveSlackUserId(item.owner) : null;
    if (this.github) {
      const reference = parseIssueReferenceUrl(item.url);
      if (!reference) return false;
      const issue = await this.github.loadIssueContext(reference.repository, reference.number);
      const threadRootIssue = await resolveNotificationThreadRootIssue(
        issue,
        this.github,
        new Set([(item.repository ?? reference.repository).toLowerCase()]),
      );
      if (!threadRootIssue) return false;
      if (threadRootIssue.url !== issue.url) {
        const threadTs = await this.threads.rootTs(threadRootIssue.url);
        if (!threadTs) return false;
        await this.notifier.notify(item, { kind, threadTs, slackUserId }, metadata);
        return true;
      }
    }
    await this.threads.publish(item.url, (threadTs) =>
      this.notifier.notify(item, { kind, threadTs, slackUserId }, metadata),
    );
    return true;
  }
}

function deadlineStage(item: HumanWorkItem, today: string, leadDays: number): DeadlineStage | null {
  if (item.status === "done" || item.delivery === "silent" || !item.owner || !item.targetDate) {
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(item.targetDate)) return null;
  const target = Date.parse(`${item.targetDate}T00:00:00Z`);
  const current = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(target) || !Number.isFinite(current)) return null;
  const remainingDays = Math.round((target - current) / DAY_MILLISECONDS);
  if (remainingDays < 0) return "overdue";
  if (remainingDays === 0) return "due-today";
  if (remainingDays <= leadDays) return "due-soon";
  return null;
}

function deadlineWorkItem(item: HumanWorkItem, stage: DeadlineStage, today: string): HumanWorkItem {
  const content: Record<
    DeadlineStage,
    Pick<HumanWorkItem, "reasonCode" | "nextAction" | "reason">
  > = {
    "due-soon": {
      reasonCode: "DUE_SOON",
      nextAction: "期限までに完了できるか確認する",
      reason: `目標日 ${item.targetDate} が近づいています。`,
    },
    "due-today": {
      reasonCode: "DUE_TODAY",
      nextAction: "今日中に完了するか、期限を見直す",
      reason: `目標日は今日（${today}）です。`,
    },
    overdue: {
      reasonCode: "OVERDUE",
      nextAction: "進捗を確認し、完了または期限変更を行う",
      reason: `目標日 ${item.targetDate} を過ぎています。`,
    },
  };
  return {
    ...item,
    delivery: "immediate",
    ...content[stage],
  };
}

function dateInTokyo(nowMilliseconds: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMilliseconds));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function workFingerprint(item: HumanWorkItem): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        reasonCode: item.reasonCode,
        status: item.status,
        owner: item.owner,
        targetDate: item.targetDate,
        nextActor: item.nextActor,
        nextAction: item.nextAction,
        reason: item.reason,
      }),
    )
    .digest("hex");
}

function compareWorkItems(left: HumanWorkItem, right: HumanWorkItem): number {
  const delivery = { immediate: 0, digest: 1, silent: 2 } as const;
  const priority = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;
  return (
    delivery[left.delivery] - delivery[right.delivery] ||
    priority[left.priority] - priority[right.priority] ||
    (left.targetDate ?? "9999-12-31").localeCompare(right.targetDate ?? "9999-12-31") ||
    left.issueNumber - right.issueNumber
  );
}
