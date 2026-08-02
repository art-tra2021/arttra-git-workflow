import { randomUUID } from "node:crypto";
import type { GitHubWebhookJob } from "./job-queue.ts";
import type { LifecycleNotificationService } from "./lifecycle-notification-service.ts";
import { RetryableWorkError } from "./retryable-error.ts";
import type { PullRequestReviewService } from "./review-service.ts";
import type { StateStore } from "./state-store.ts";
import type { WorkNotificationService } from "./work-notification-service.ts";

const DELIVERY_NAMESPACE = "github-delivery";
const DELIVERY_LEASE_MILLISECONDS = 15 * 60_000;

interface GitHubDeliveryState {
  schemaVersion: 2;
  revision: number;
  status: "processing" | "effects_started" | "completed" | "failed" | "retryable";
  owner: string;
  event: string;
  expiresAt: string;
  effectsStartedAt?: string;
  processedAt?: string;
  failedAt?: string;
  failure?: string;
}

interface GitHubDeliveryLease {
  owner: string;
  revision: number;
}

export class GitHubWebhookProcessor {
  private readonly reviews: PullRequestReviewService | null;
  private readonly store: StateStore;
  private readonly syncProjectList: (() => Promise<unknown>) | undefined;
  private readonly notifications: WorkNotificationService | null;
  private readonly lifecycle: LifecycleNotificationService | null;

  constructor(
    reviews: PullRequestReviewService | null,
    store: StateStore,
    syncProjectList?: () => Promise<unknown>,
    notifications: WorkNotificationService | null = null,
    lifecycle: LifecycleNotificationService | null = null,
  ) {
    this.reviews = reviews;
    this.store = store;
    this.syncProjectList = syncProjectList;
    this.notifications = notifications;
    this.lifecycle = lifecycle;
  }

  async process(job: GitHubWebhookJob): Promise<void> {
    let lease = await this.acquireDelivery(job);
    if (!lease) {
      return;
    }
    let effectsStarted = false;
    try {
      // List同期を通知より先に完了させる。同期競合後の再試行で、通知だけが再送されるのを防ぐ。
      if (this.syncProjectList && shouldSyncProjectList(job)) {
        await this.syncProjectList();
      }
      lease = await this.beginEffects(job, lease);
      effectsStarted = true;
      const target = reviewTarget(job);
      if (target && this.reviews) {
        await this.reviews.process(target.repository, target.pullRequestNumber, {
          reRequestChanges: target.reRequestChanges,
        });
      }
      if (this.lifecycle) {
        await this.lifecycle.process(job);
      }
      if (this.notifications && shouldRefreshWorkNotifications(job)) {
        await this.notifications.notifyImmediate();
      }
      await this.completeDelivery(job, lease);
    } catch (error) {
      if (effectsStarted) {
        await this.failDelivery(job, lease, error);
      } else {
        await this.releaseDelivery(job, lease);
      }
      throw error;
    }
  }

  private async acquireDelivery(job: GitHubWebhookJob): Promise<GitHubDeliveryLease | null> {
    const owner = randomUUID();
    const fresh: GitHubDeliveryState = {
      schemaVersion: 2,
      revision: 1,
      status: "processing",
      owner,
      event: job.event,
      expiresAt: new Date(Date.now() + DELIVERY_LEASE_MILLISECONDS).toISOString(),
    };
    if (await this.store.create(DELIVERY_NAMESPACE, job.deliveryId, fresh)) {
      return { owner, revision: fresh.revision };
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.store.get<GitHubDeliveryState>(DELIVERY_NAMESPACE, job.deliveryId);
      // schemaVersion 1の旧delivery markerも完了済みとして扱う。
      if (
        current?.schemaVersion !== 2 ||
        current.status === "effects_started" ||
        current.status === "completed" ||
        current.status === "failed"
      ) {
        return null;
      }
      if (current.status === "processing" && Date.parse(current.expiresAt) > Date.now()) {
        throw new RetryableWorkError(
          "github_delivery_in_progress",
          "同じGitHub webhookを処理中です。完了後に自動で再試行します。",
        );
      }
      const next: GitHubDeliveryState = {
        ...fresh,
        revision: current.revision + 1,
      };
      if (
        await this.store.compareAndSet(DELIVERY_NAMESPACE, job.deliveryId, current.revision, next)
      ) {
        return { owner, revision: next.revision };
      }
    }
    throw new RetryableWorkError(
      "github_delivery_claim_conflict",
      "GitHub webhookの処理権取得が競合しました。自動で再試行します。",
    );
  }

  private async beginEffects(
    job: GitHubWebhookJob,
    lease: GitHubDeliveryLease,
  ): Promise<GitHubDeliveryLease> {
    const current = await this.store.get<GitHubDeliveryState>(DELIVERY_NAMESPACE, job.deliveryId);
    if (
      current?.schemaVersion !== 2 ||
      current.status !== "processing" ||
      current.owner !== lease.owner ||
      current.revision !== lease.revision
    ) {
      throw new RetryableWorkError(
        "github_delivery_effects_claim_conflict",
        "GitHub webhookの通知処理権が競合しました。自動で再試行します。",
      );
    }
    const effectsStarted: GitHubDeliveryState = {
      ...current,
      revision: current.revision + 1,
      status: "effects_started",
      expiresAt: new Date(0).toISOString(),
      effectsStartedAt: new Date().toISOString(),
    };
    if (
      !(await this.store.compareAndSet(
        DELIVERY_NAMESPACE,
        job.deliveryId,
        current.revision,
        effectsStarted,
      ))
    ) {
      throw new RetryableWorkError(
        "github_delivery_effects_claim_conflict",
        "GitHub webhookの通知処理権が競合しました。自動で再試行します。",
      );
    }
    return { owner: lease.owner, revision: effectsStarted.revision };
  }

  private async completeDelivery(job: GitHubWebhookJob, lease: GitHubDeliveryLease): Promise<void> {
    const completed: GitHubDeliveryState = {
      schemaVersion: 2,
      revision: lease.revision + 1,
      status: "completed",
      owner: lease.owner,
      event: job.event,
      expiresAt: new Date(0).toISOString(),
      processedAt: new Date().toISOString(),
    };
    if (
      !(await this.store.compareAndSet(
        DELIVERY_NAMESPACE,
        job.deliveryId,
        lease.revision,
        completed,
      ))
    ) {
      throw new RetryableWorkError(
        "github_delivery_completion_conflict",
        "GitHub webhookの完了記録が競合しました。自動で再試行します。",
      );
    }
  }

  private async releaseDelivery(job: GitHubWebhookJob, lease: GitHubDeliveryLease): Promise<void> {
    const current = await this.store.get<GitHubDeliveryState>(DELIVERY_NAMESPACE, job.deliveryId);
    if (
      current?.schemaVersion !== 2 ||
      current.status !== "processing" ||
      current.owner !== lease.owner
    ) {
      return;
    }
    await this.store.compareAndSet(DELIVERY_NAMESPACE, job.deliveryId, current.revision, {
      ...current,
      revision: current.revision + 1,
      status: "retryable",
      expiresAt: new Date(0).toISOString(),
    });
  }

  private async failDelivery(
    job: GitHubWebhookJob,
    lease: GitHubDeliveryLease,
    error: unknown,
  ): Promise<void> {
    const current = await this.store.get<GitHubDeliveryState>(DELIVERY_NAMESPACE, job.deliveryId);
    if (
      current?.schemaVersion !== 2 ||
      current.status !== "effects_started" ||
      current.owner !== lease.owner
    ) {
      return;
    }
    await this.store.compareAndSet(DELIVERY_NAMESPACE, job.deliveryId, current.revision, {
      ...current,
      revision: current.revision + 1,
      status: "failed",
      failedAt: new Date().toISOString(),
      failure: failureCode(error),
    });
  }
}

function failureCode(error: unknown): string {
  if (error instanceof RetryableWorkError) return error.code;
  if (error instanceof Error && error.name) return error.name;
  return "unknown_error";
}

function shouldRefreshWorkNotifications(job: GitHubWebhookJob): boolean {
  if (job.event === "check_run" || job.event === "check_suite") {
    return Boolean(actionFrom(job));
  }
  return shouldSyncProjectList(job);
}

function shouldSyncProjectList(job: GitHubWebhookJob): boolean {
  const action = actionFrom(job);
  if (job.event === "projects_v2_item") {
    return Boolean(action);
  }
  const actions: Record<string, Set<string>> = {
    issues: new Set([
      "opened",
      "edited",
      "deleted",
      "transferred",
      "pinned",
      "unpinned",
      "closed",
      "reopened",
      "assigned",
      "unassigned",
      "labeled",
      "unlabeled",
    ]),
    pull_request: new Set([
      "opened",
      "closed",
      "reopened",
      "converted_to_draft",
      "ready_for_review",
      "synchronize",
    ]),
    pull_request_review: new Set(["submitted", "dismissed"]),
  };
  return action ? (actions[job.event]?.has(action) ?? false) : false;
}

function actionFrom(job: GitHubWebhookJob): string | null {
  if (!job.payload || typeof job.payload !== "object" || !("action" in job.payload)) return null;
  return typeof job.payload.action === "string" ? job.payload.action : null;
}

function reviewTarget(job: GitHubWebhookJob): {
  repository: string;
  pullRequestNumber: number;
  reRequestChanges: boolean;
} | null {
  if (job.event !== "pull_request" && job.event !== "pull_request_review") {
    return null;
  }
  const payload = job.payload as {
    action?: string;
    repository?: { full_name?: string };
    pull_request?: { number?: number };
  };
  const allowedActions =
    job.event === "pull_request"
      ? new Set(["opened", "reopened", "ready_for_review", "synchronize"])
      : new Set(["submitted", "dismissed"]);
  if (!payload.action || !allowedActions.has(payload.action)) {
    return null;
  }
  const repository = payload.repository?.full_name ?? "";
  const pullRequestNumber = payload.pull_request?.number ?? 0;
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !Number.isSafeInteger(pullRequestNumber) ||
    pullRequestNumber < 1
  ) {
    throw new Error("GitHub webhookからrepositoryまたはPR番号を読み取れませんでした。");
  }
  return {
    repository,
    pullRequestNumber,
    reRequestChanges: job.event === "pull_request" && payload.action === "synchronize",
  };
}
