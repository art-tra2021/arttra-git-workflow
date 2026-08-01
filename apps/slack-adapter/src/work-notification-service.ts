import { createHash } from "node:crypto";
import type { StateStore } from "./state-store.ts";
import type { HumanWorkItem } from "./types.ts";

const NOTIFICATION_NAMESPACE = "work-notification";

export interface WorkItemSource {
  loadProjectItems(): Promise<HumanWorkItem[]>;
}

export interface WorkNotifier {
  notify(item: HumanWorkItem): Promise<void>;
  digest(items: HumanWorkItem[]): Promise<void>;
}

interface WorkNotificationState {
  schemaVersion: 1;
  issueUrl: string;
  fingerprint: string;
  notifiedAt: string;
}

export class WorkNotificationService {
  private readonly source: WorkItemSource;
  private readonly store: StateStore;
  private readonly notifier: WorkNotifier;
  private readonly now: () => number;

  constructor(
    source: WorkItemSource,
    store: StateStore,
    notifier: WorkNotifier,
    now: () => number = Date.now,
  ) {
    this.source = source;
    this.store = store;
    this.notifier = notifier;
    this.now = now;
  }

  async notifyImmediate(): Promise<number> {
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
      await this.notifier.notify(item);
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

  async sendDigest(): Promise<number> {
    const items = (await this.source.loadProjectItems())
      .filter((item) => item.delivery !== "silent")
      .sort(compareWorkItems);
    if (items.length > 0) {
      await this.notifier.digest(items);
    }
    return items.length;
  }
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
