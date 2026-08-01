import type { GitHubWebhookJob } from "./job-queue.ts";
import type { PullRequestReviewService } from "./review-service.ts";
import type { StateStore } from "./state-store.ts";

const DELIVERY_NAMESPACE = "github-delivery";

export class GitHubWebhookProcessor {
  private readonly reviews: PullRequestReviewService;
  private readonly store: StateStore;

  constructor(reviews: PullRequestReviewService, store: StateStore) {
    this.reviews = reviews;
    this.store = store;
  }

  async process(job: GitHubWebhookJob): Promise<void> {
    if (await this.store.get(DELIVERY_NAMESPACE, job.deliveryId)) {
      return;
    }
    const target = reviewTarget(job);
    if (target) {
      await this.reviews.process(target.repository, target.pullRequestNumber);
    }
    await this.store.create(DELIVERY_NAMESPACE, job.deliveryId, {
      schemaVersion: 1,
      processedAt: new Date().toISOString(),
      event: job.event,
    });
  }
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
