import type {
  LifecycleNotification,
  LifecycleNotifier,
  ResolveLifecycleSlackUserId,
} from "./lifecycle-notification-service.ts";
import {
  issueOpenedEventFingerprint,
  issueRootMentionLogins,
  issueRootNotification,
  resolveNotificationThreadRootIssue,
} from "./lifecycle-notification-service.ts";
import {
  channelNoticeMetadata,
  type NotificationMode,
  type UnreachableRecipient,
} from "./notification-mode.ts";
import { type NotificationIntentMetadata, notificationIntentId } from "./notification-outbox.ts";
import type { NotificationThreadService } from "./notification-thread-service.ts";
import type { GitHubLifecycleClient, ReviewRequestReadModel } from "./review-types.ts";

export class SlackReviewNotifier {
  private readonly notifier: LifecycleNotifier;
  private readonly threads: NotificationThreadService;
  private readonly resolveSlackUserId: ResolveLifecycleSlackUserId;
  private readonly github: Pick<GitHubLifecycleClient, "loadIssueContext">;
  private readonly mode: NotificationMode;

  constructor(
    notifier: LifecycleNotifier,
    threads: NotificationThreadService,
    resolveSlackUserId: ResolveLifecycleSlackUserId,
    github: Pick<GitHubLifecycleClient, "loadIssueContext">,
    options: { mode?: NotificationMode } = {},
  ) {
    this.notifier = notifier;
    this.threads = threads;
    this.resolveSlackUserId = resolveSlackUserId;
    this.github = github;
    this.mode = options.mode ?? "thread";
  }

  async notify(
    model: ReviewRequestReadModel,
    context: { sourceDeliveryId?: string; actorLogin?: string } = {},
  ): Promise<void> {
    if (model.closingIssueCount !== 1 || !model.primaryIssue?.labels.includes("type/task")) {
      return;
    }
    const issue = model.primaryIssue;
    if (this.mode === "direct") {
      await this.notifyDirect(model, issue, context);
      return;
    }
    const threadRootIssue = await resolveNotificationThreadRootIssue(
      issue,
      this.github,
      new Set([model.repository.toLowerCase()]),
    );
    if (!threadRootIssue) return;
    const assigneeLogins = issue.assigneeLogins;
    const assigneeSlackIds = await Promise.all(assigneeLogins.map(this.resolveSlackUserId));
    const actorLogin = context.actorLogin ?? model.authorLogin;
    const [actorSlackUserId, rootResolvedUserIds, taskResolvedUserIds] = await Promise.all([
      this.resolveSlackUserId(actorLogin),
      Promise.all(issueRootMentionLogins(threadRootIssue).map(this.resolveSlackUserId)),
      Promise.all(issueRootMentionLogins(issue).map(this.resolveSlackUserId)),
    ]);
    const reviewerSlackUserIds = [
      ...new Set(
        model.reviewers.flatMap((reviewer) => (reviewer.slackUserId ? [reviewer.slackUserId] : [])),
      ),
    ].filter((slackUserId) => slackUserId !== actorSlackUserId);
    const slackUserIds = [
      ...new Set([
        ...reviewerSlackUserIds,
        ...assigneeSlackIds.filter((value): value is string => value !== null),
      ]),
    ].filter((slackUserId) => slackUserId !== actorSlackUserId);
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
        reviewRequestedNotification(model, issue, actorLogin, actorSlackUserId, slackUserIds),
        threadTs,
        {
          intentId: reviewRequestIntentId(model, issue.url),
          ...(context.sourceDeliveryId ? { sourceDeliveryId: context.sourceDeliveryId } : {}),
          requiredAction: {
            kind: "review-requested",
            recipientSlackUserIds: reviewerSlackUserIds,
            actorSlackUserId,
          },
        },
      ),
    );
  }

  /**
   * directモードでは親投稿、Task概要、レビュー依頼のthread返信を出さない。
   * 個人reviewerへはDMだけを送り、DMを送れないreviewer（GitHub未連携の個人とGitHub team）が
   * いるときだけ、そのGitHub loginとteamを書いたchannel単独投稿を出す。
   * DMの内容とintentは従来方式のレビュー依頼と同じものから決まる。
   */
  private async notifyDirect(
    model: ReviewRequestReadModel,
    issue: NonNullable<ReviewRequestReadModel["primaryIssue"]>,
    context: { sourceDeliveryId?: string; actorLogin?: string },
  ): Promise<void> {
    const actorLogin = context.actorLogin ?? model.authorLogin;
    const [actorSlackUserId, assigneeSlackIds] = await Promise.all([
      this.resolveSlackUserId(actorLogin),
      Promise.all(issue.assigneeLogins.map(this.resolveSlackUserId)),
    ]);
    const reviewerSlackUserIds = [
      ...new Set(
        model.reviewers.flatMap((reviewer) => (reviewer.slackUserId ? [reviewer.slackUserId] : [])),
      ),
    ].filter((slackUserId) => slackUserId !== actorSlackUserId);
    const notification = reviewRequestedNotification(
      model,
      issue,
      actorLogin,
      actorSlackUserId,
      [
        ...new Set([
          ...reviewerSlackUserIds,
          ...assigneeSlackIds.filter((value): value is string => value !== null),
        ]),
      ].filter((slackUserId) => slackUserId !== actorSlackUserId),
    );
    const metadata: NotificationIntentMetadata = {
      intentId: reviewRequestIntentId(model, notification.resource.url),
      ...(context.sourceDeliveryId ? { sourceDeliveryId: context.sourceDeliveryId } : {}),
      requiredAction: {
        kind: "review-requested",
        recipientSlackUserIds: reviewerSlackUserIds,
        actorSlackUserId,
      },
    };
    const actor = actorLogin.toLowerCase();
    const unreachable: UnreachableRecipient[] = [
      ...model.reviewers
        .filter(
          (reviewer) =>
            !reviewer.slackUserId &&
            reviewer.githubLogin.toLowerCase() !== actor &&
            !reviewer.githubLogin.toLowerCase().endsWith("[bot]"),
        )
        .map((reviewer) => ({ kind: "github-user" as const, name: reviewer.githubLogin })),
      ...model.teams.map((team) => ({ kind: "github-team" as const, name: team.slug })),
    ];
    if (reviewerSlackUserIds.length > 0) {
      if (this.notifier.notifyRequiredActionOnly) {
        await this.notifier.notifyRequiredActionOnly(notification, metadata);
      } else {
        // DM経路がなければ誰にも届かないため、個人reviewerもchannelで知らせる。
        unreachable.push(
          ...model.reviewers
            .filter(
              (reviewer) => reviewer.slackUserId && reviewer.githubLogin.toLowerCase() !== actor,
            )
            .map((reviewer) => ({ kind: "github-user" as const, name: reviewer.githubLogin })),
        );
      }
    }
    if (unreachable.length === 0) return;
    await this.notifier.notify(
      {
        ...notification,
        actorSlackUserId: null,
        slackUserIds: [],
        standalone: true,
        unreachableRecipients: unreachable,
      },
      null,
      channelNoticeMetadata(metadata, unreachable),
    );
  }
}

function reviewRequestedNotification(
  model: ReviewRequestReadModel,
  issue: NonNullable<ReviewRequestReadModel["primaryIssue"]>,
  actorLogin: string,
  actorSlackUserId: string | null,
  slackUserIds: string[],
): LifecycleNotification {
  return {
    schemaVersion: 1,
    kind: "review-requested",
    resource: { kind: "issue", number: issue.number, title: issue.title, url: issue.url },
    pullRequest: {
      number: model.pullRequest.number,
      title: model.pullRequest.title,
      url: model.pullRequest.url,
    },
    actorLogin,
    actorSlackUserId,
    slackUserIds,
    issueType: issueRootNotification(issue, [], null).issueType,
    summary: "PRが作成され、レビュー依頼が設定されました。",
    detail: reviewDetail(model),
    nextAction: model.nextAction,
    actionUrl: model.pullRequest.url,
  };
}

function reviewDetail(model: ReviewRequestReadModel): string {
  return [
    ...model.reviewers.map(
      (reviewer) => `@${reviewer.githubLogin}: ${reviewer.reasons.join("、")}`,
    ),
    ...model.teams.map((team) => `@${team.slug}: ${team.reasons.join("、")}（GitHub team）`),
    `必要承認数: ${model.requiredApprovals}`,
    `期限: ${model.dueDate ?? "未設定"}`,
  ].join(" / ");
}

function reviewRequestIntentId(model: ReviewRequestReadModel, resourceUrl: string): string {
  return notificationIntentId({
    kind: "review-request",
    repository: model.repository,
    pullRequestNumber: model.pullRequest.number,
    resourceUrl,
    updatedAt: model.updatedAt,
  });
}
