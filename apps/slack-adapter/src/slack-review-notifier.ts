import type {
  LifecycleNotifier,
  ResolveLifecycleSlackUserId,
} from "./lifecycle-notification-service.ts";
import {
  issueOpenedEventFingerprint,
  issueRootMentionLogins,
  issueRootNotification,
  resolveNotificationThreadRootIssue,
  shouldSuppressActorMention,
} from "./lifecycle-notification-service.ts";
import { notificationIntentId } from "./notification-outbox.ts";
import type { NotificationThreadService } from "./notification-thread-service.ts";
import type { GitHubLifecycleClient, ReviewRequestReadModel } from "./review-types.ts";

export class SlackReviewNotifier {
  private readonly notifier: LifecycleNotifier;
  private readonly threads: NotificationThreadService;
  private readonly resolveSlackUserId: ResolveLifecycleSlackUserId;
  private readonly github: Pick<GitHubLifecycleClient, "loadIssueContext">;

  constructor(
    notifier: LifecycleNotifier,
    threads: NotificationThreadService,
    resolveSlackUserId: ResolveLifecycleSlackUserId,
    github: Pick<GitHubLifecycleClient, "loadIssueContext">,
  ) {
    this.notifier = notifier;
    this.threads = threads;
    this.resolveSlackUserId = resolveSlackUserId;
    this.github = github;
  }

  async notify(
    model: ReviewRequestReadModel,
    context: { sourceDeliveryId?: string } = {},
  ): Promise<void> {
    if (model.closingIssueCount !== 1 || !model.primaryIssue?.labels.includes("type/task")) {
      return;
    }
    const issue = model.primaryIssue;
    const threadRootIssue = await resolveNotificationThreadRootIssue(
      issue,
      this.github,
      new Set([model.repository.toLowerCase()]),
    );
    if (!threadRootIssue) return;
    const assigneeLogins = issue.assigneeLogins;
    const assigneeSlackIds = await Promise.all(assigneeLogins.map(this.resolveSlackUserId));
    const [actorSlackUserId, rootResolvedUserIds, taskResolvedUserIds] = await Promise.all([
      this.resolveSlackUserId(model.authorLogin),
      Promise.all(issueRootMentionLogins(threadRootIssue).map(this.resolveSlackUserId)),
      Promise.all(issueRootMentionLogins(issue).map(this.resolveSlackUserId)),
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
      threadRootIssue,
      [...new Set(rootResolvedUserIds.filter((value): value is string => value !== null))],
      null,
    );
    const taskOpenedNotification = issueRootNotification(
      issue,
      [...new Set(taskResolvedUserIds.filter((value): value is string => value !== null))],
      null,
    );
    const createRoot = () =>
      this.notifier.notify(rootNotification, null, {
        intentId: notificationIntentId({
          kind: "lifecycle",
          resourceUrl: threadRootIssue.url,
          notificationKind: "issue-opened",
          eventFingerprint: "issue-root-v1",
        }),
        ...(context.sourceDeliveryId ? { sourceDeliveryId: context.sourceDeliveryId } : {}),
      });
    await this.threads.publishReply(threadRootIssue.url, createRoot, (threadTs) =>
      this.notifier.notify(taskOpenedNotification, threadTs, {
        intentId: notificationIntentId({
          kind: "lifecycle",
          resourceUrl: issue.url,
          notificationKind: "issue-opened",
          eventFingerprint: issueOpenedEventFingerprint(issue),
        }),
        ...(context.sourceDeliveryId ? { sourceDeliveryId: context.sourceDeliveryId } : {}),
      }),
    );
    await this.threads.publishReply(threadRootIssue.url, createRoot, (threadTs) =>
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
          issueType: taskOpenedNotification.issueType,
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
