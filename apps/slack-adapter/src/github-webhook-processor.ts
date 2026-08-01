import type { GitHubWebhookJob } from "./job-queue.ts";
import type { PullRequestReviewService } from "./review-service.ts";
import type { StateStore } from "./state-store.ts";

const DELIVERY_NAMESPACE = "github-delivery";

export class GitHubWebhookProcessor {
  private readonly reviews: PullRequestReviewService | null;
  private readonly store: StateStore;
  private readonly syncProjectList: (() => Promise<unknown>) | undefined;

  constructor(
    reviews: PullRequestReviewService | null,
    store: StateStore,
    syncProjectList?: () => Promise<unknown>,
  ) {
    this.reviews = reviews;
    this.store = store;
    this.syncProjectList = syncProjectList;
  }

  async process(job: GitHubWebhookJob): Promise<void> {
    if (await this.store.get(DELIVERY_NAMESPACE, job.deliveryId)) {
      return;
    }
    const target = reviewTarget(job);
    if (target && this.reviews) {
      await this.reviews.process(target.repository, target.pullRequestNumber);
    }
    if (this.syncProjectList && shouldSyncProjectList(job)) {
      await this.syncProjectList();
    }
    await this.store.create(DELIVERY_NAMESPACE, job.deliveryId, {
      schemaVersion: 1,
      processedAt: new Date().toISOString(),
      event: job.event,
    });
  }
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

function reviewTarget(
  job: GitHubWebhookJob,
): { repository: string; pullRequestNumber: number } | null {
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
  return { repository, pullRequestNumber };
}
