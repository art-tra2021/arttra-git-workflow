import type {
  LifecycleNotifier,
  ResolveLifecycleSlackUserId,
} from "./lifecycle-notification-service.ts";
import {
  issueRootMentionLogins,
  issueRootNotification,
  shouldSuppressActorMention,
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
    if (model.closingIssueCount !== 1 || !model.primaryIssue?.labels.includes("type/task")) {
      return;
    }
    const issue = model.primaryIssue;
    const assigneeLogins = issue.assigneeLogins;
    const assigneeSlackIds = await Promise.all(assigneeLogins.map(this.resolveSlackUserId));
    const [actorSlackUserId, ...rootResolvedUserIds] = await Promise.all([
      this.resolveSlackUserId(model.authorLogin),
      ...issueRootMentionLogins(issue).map(this.resolveSlackUserId),
    ]);
    const slackUserIds = [
      ...new Set([
        ...model.reviewers.flatMap((reviewer) =>
          reviewer.slackUserId ? [reviewer.slackUserId] : [],
        ),
        ...assigneeSlackIds.filter((value): value is string => value !== null),
      ]),
    ].filter((slackUserId) => slackUserId !== actorSlackUserId);
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
    const resource = {
      kind: "issue" as const,
      number: issue.number,
      title: issue.title,
      url: issue.url,
    };
    const rootNotification = issueRootNotification(
      issue,
      [...new Set(rootResolvedUserIds.filter((value): value is string => value !== null))],
      null,
    );
    await this.threads.publishReply(
      resource.url,
      () =>
        this.notifier.notify(rootNotification, null, {
          intentId: notificationIntentId({
            kind: "lifecycle",
            resourceUrl: issue.url,
            notificationKind: "issue-opened",
            eventFingerprint: "issue-root-v1",
          }),
          ...(context.sourceDeliveryId ? { sourceDeliveryId: context.sourceDeliveryId } : {}),
        }),
      (threadTs) =>
        this.notifier.notify(
          {
            schemaVersion: 1,
            kind: "review-requested",
            resource,
            pullRequest,
            actorLogin: model.authorLogin,
            actorSlackUserId: shouldSuppressActorMention("review-requested")
              ? null
              : actorSlackUserId,
            slackUserIds,
            issueType: rootNotification.issueType,
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
