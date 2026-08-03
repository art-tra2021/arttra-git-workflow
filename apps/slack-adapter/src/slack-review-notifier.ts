import type {
  LifecycleNotifier,
  LifecycleResource,
  ResolveLifecycleSlackUserId,
} from "./lifecycle-notification-service.ts";
import { notificationIntentId } from "./notification-outbox.ts";
import type { NotificationThreadService } from "./notification-thread-service.ts";
import type { ReviewRequestReadModel } from "./review-types.ts";

export class SlackReviewNotifier {
  private readonly notifier: LifecycleNotifier;
  private readonly threads: NotificationThreadService;
  private readonly resolveSlackUserId: ResolveLifecycleSlackUserId;

  constructor(
    notifier: LifecycleNotifier,
    threads: NotificationThreadService,
    resolveSlackUserId: ResolveLifecycleSlackUserId,
  ) {
    this.notifier = notifier;
    this.threads = threads;
    this.resolveSlackUserId = resolveSlackUserId;
  }

  async notify(
    model: ReviewRequestReadModel,
    context: { sourceDeliveryId?: string } = {},
  ): Promise<void> {
    const assigneeLogins = model.linkedIssues.flatMap((issue) => issue.assigneeLogins);
    const assigneeSlackIds = await Promise.all(
      assigneeLogins
        .filter((login) => login.toLowerCase() !== model.authorLogin.toLowerCase())
        .map(this.resolveSlackUserId),
    );
    const slackUserIds = [
      ...new Set([
        ...model.reviewers.flatMap((reviewer) =>
          reviewer.slackUserId ? [reviewer.slackUserId] : [],
        ),
        ...assigneeSlackIds.filter((value): value is string => value !== null),
      ]),
    ];
    const reviewerLines = model.reviewers.map(
      (reviewer) => `@${reviewer.githubLogin}: ${reviewer.reasons.join("、")}`,
    );
    const teamLines = model.teams.map(
      (team) => `@${team.slug}: ${team.reasons.join("、")}（GitHub team）`,
    );
    const detail = [
      ...reviewerLines,
      ...teamLines,
      `必要承認数: ${model.requiredApprovals}`,
      `期限: ${model.dueDate ?? "未設定"}`,
    ].join(" / ");
    const pullRequest = {
      number: model.pullRequest.number,
      title: model.pullRequest.title,
      url: model.pullRequest.url,
    };
    const resources: LifecycleResource[] =
      model.linkedIssues.length > 0
        ? model.linkedIssues.map((issue) => ({
            kind: "issue",
            number: issue.number,
            title: issue.title,
            url: issue.url,
          }))
        : [{ kind: "pull-request", ...pullRequest }];
    for (const resource of resources) {
      await this.threads.publish(resource.url, (threadTs) =>
        this.notifier.notify(
          {
            schemaVersion: 1,
            kind: "review-requested",
            resource,
            pullRequest,
            actorLogin: model.authorLogin,
            slackUserIds,
            summary: "PRが作成され、レビュー依頼が設定されました。",
            detail,
            nextAction: model.nextAction,
            actionUrl: model.pullRequest.url,
          },
          threadTs,
          {
            intentId: notificationIntentId({
              kind: "review-request",
              repository: model.repository,
              pullRequestNumber: model.pullRequest.number,
              resourceUrl: resource.url,
              updatedAt: model.updatedAt,
            }),
            ...(context.sourceDeliveryId ? { sourceDeliveryId: context.sourceDeliveryId } : {}),
          },
        ),
      );
    }
  }
}
