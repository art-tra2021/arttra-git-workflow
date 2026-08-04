import { createHash } from "node:crypto";
import { type GitHubCapabilityAccess, GitHubCapabilityGrants } from "./github-capabilities.ts";
import { parseIssueRequester } from "./issue-requester.ts";
import type { GitHubWebhookJob } from "./job-queue.ts";
import { type NotificationIntentMetadata, notificationIntentId } from "./notification-outbox.ts";
import type {
  NotificationThreadService,
  ThreadMessageResult,
} from "./notification-thread-service.ts";
import type {
  GitHubIssueContext,
  GitHubLifecycleClient,
  PullRequestReviewContext,
} from "./review-types.ts";
import type { StateStore } from "./state-store.ts";

const NOTIFICATION_NAMESPACE = "lifecycle-notification";
const ISSUE_CREATION_SETUP_NAMESPACE = "issue-creation-setup";
const SUPPRESS_ACTOR_MENTION_KINDS = new Set<LifecycleNotificationKind>([
  "issue-opened",
  "issue-reopened",
  "issue-assignment-changed",
  "comment-created",
  "issue-completed",
  "pr-merged",
  "review-requested",
  "review-approved",
  "review-commented",
  "review-dismissed",
  "revision-pushed",
  "self-merge-scheduled",
]);

export type LifecycleNotificationKind =
  | "issue-opened"
  | "issue-reopened"
  | "issue-assignment-changed"
  | "comment-created"
  | "issue-completed"
  | "pr-merged"
  | "review-requested"
  | "review-approved"
  | "review-changes-requested"
  | "review-commented"
  | "review-dismissed"
  | "revision-pushed"
  | "ci-failed"
  | "self-merge-scheduled"
  | "self-merge-ready";

export type IssueNotificationType = "intake" | "work" | "task" | "business" | null;

export interface LifecycleResource {
  kind: "issue" | "pull-request";
  number: number;
  title: string;
  url: string;
}

export interface LifecyclePullRequest {
  number: number;
  title: string;
  url: string;
}

export interface LifecycleNotification {
  schemaVersion: 1;
  kind: LifecycleNotificationKind;
  resource: LifecycleResource;
  pullRequest: LifecyclePullRequest | null;
  actorLogin: string;
  actorSlackUserId: string | null;
  slackUserIds: string[];
  issueType: IssueNotificationType;
  summary: string;
  detail: string;
  nextAction: string;
  actionUrl: string;
  selfMergeControl?: { repository: string; issueNumber: number } | null;
  /** self-merge-scheduledをchannelへ展開するか。未指定の旧payloadは展開する。 */
  replyBroadcast?: boolean;
}

export interface LifecycleNotifier {
  notify(
    notification: LifecycleNotification,
    threadTs: string | null,
    metadata?: NotificationIntentMetadata,
  ): Promise<ThreadMessageResult>;
}

export type ResolveLifecycleSlackUserId = (githubLogin: string) => Promise<string | null>;

interface LifecycleNotificationState {
  schemaVersion: 1;
  resourceUrl: string;
  kind: LifecycleNotificationKind;
  fingerprint: string;
  notifiedAt: string;
}

interface IssueCreationSetupState {
  schemaVersion: 1;
  revision: number;
  issueUrl: string;
  pendingAssigneeLogins: string[];
}

export class LifecycleNotificationService {
  private readonly github: GitHubLifecycleClient;
  private readonly store: StateStore;
  private readonly threads: NotificationThreadService;
  private readonly notifier: LifecycleNotifier;
  private readonly resolveSlackUserId: ResolveLifecycleSlackUserId;
  private readonly now: () => number;
  private readonly allowedRepositories: Set<string> | null;
  private readonly githubCapabilities: GitHubCapabilityAccess;

  constructor(
    github: GitHubLifecycleClient,
    store: StateStore,
    threads: NotificationThreadService,
    notifier: LifecycleNotifier,
    resolveSlackUserId: ResolveLifecycleSlackUserId,
    now: () => number = Date.now,
    allowedRepositories: readonly string[] | null = null,
    githubCapabilities: GitHubCapabilityAccess = GitHubCapabilityGrants.empty(),
  ) {
    this.github = github;
    this.store = store;
    this.threads = threads;
    this.notifier = notifier;
    this.resolveSlackUserId = resolveSlackUserId;
    this.now = now;
    this.allowedRepositories = allowedRepositories
      ? new Set(allowedRepositories.map((repository) => repository.toLowerCase()))
      : null;
    this.githubCapabilities = githubCapabilities;
  }

  async process(job: GitHubWebhookJob): Promise<number> {
    if (this.allowedRepositories) {
      const repository = repositoryName(objectPayload(job)).toLowerCase();
      if (!this.allowedRepositories.has(repository)) return 0;
    }
    switch (job.event) {
      case "issues":
        return this.processIssue(job);
      case "issue_comment":
        return this.processIssueComment(job);
      case "pull_request":
        return this.processPullRequest(job);
      case "pull_request_review":
        return this.processReview(job);
      case "pull_request_review_comment":
        return this.processReviewComment(job);
      case "check_run":
      case "check_suite":
        return this.processCheck(job);
      default:
        return 0;
    }
  }

  private async processIssue(job: GitHubWebhookJob): Promise<number> {
    const payload = objectPayload(job);
    const action = stringValue(payload.action);
    const repository = repositoryName(payload);
    const issueNumber = nestedNumber(payload, "issue", "number");
    const actor = nestedString(payload, "sender", "login");
    const issue = await this.github.loadIssueContext(repository, issueNumber);
    if (action === "opened") {
      const opened = await this.ensureIssueOpened(issue, job.deliveryId);
      return (
        opened +
        (await this.notifySelfMergeScheduled(issue, repository, issueRootActorLogin(issue), job))
      );
    }
    if (action === "reopened") {
      return this.send(
        issue,
        null,
        "issue-reopened",
        actor,
        [...issue.assigneeLogins, issue.authorLogin],
        "Issueが再開されました。",
        `#${issue.number} ${issue.title} がreopenされました。`,
        "再開理由と残作業を確認する",
        issue.url,
        fingerprint({ action, state: issue.state }),
        job.deliveryId,
      );
    }
    if (action === "assigned" || action === "unassigned") {
      const assignee = nestedString(payload, "assignee", "login");
      const opened = await this.ensureIssueOpened(issue, job.deliveryId);
      if (action === "assigned" && (await this.consumeInitialAssignee(issue.url, assignee))) {
        return opened;
      }
      if (action === "unassigned") {
        await this.discardInitialAssignee(issue.url, assignee);
      }
      return (
        opened +
        (await this.send(
          issue,
          null,
          "issue-assignment-changed",
          actor,
          [...issue.assigneeLogins, issue.authorLogin],
          "Issueの担当者が変更されました。",
          `現在の担当: ${issue.assigneeLogins.map((login) => `@${login}`).join("、") || "未設定"}`,
          "担当と次の操作を確認する",
          issue.url,
          fingerprint({ action, assignees: issue.assigneeLogins }),
          job.deliveryId,
        ))
      );
    }
    if (action === "labeled" && nestedString(payload, "label", "name") === "merge/self") {
      return this.notifySelfMergeScheduled(issue, repository, actor, job);
    }
    if (action !== "closed") return 0;
    return this.send(
      issue,
      null,
      "issue-completed",
      actor,
      [...issue.assigneeLogins, issue.authorLogin],
      "Issueが完了しました。",
      `#${issue.number} ${issue.title} がcloseされました。`,
      "残作業がなければ、このスレッドを完了記録として残す",
      issue.url,
      fingerprint({ state: issue.state, url: issue.url }),
      job.deliveryId,
    );
  }

  private async processIssueComment(job: GitHubWebhookJob): Promise<number> {
    const payload = objectPayload(job);
    if (stringValue(payload.action) !== "created") return 0;
    const repository = repositoryName(payload);
    const issueNumber = nestedNumber(payload, "issue", "number");
    const actor = nestedString(payload, "comment", "user", "login");
    const body = nestedString(payload, "comment", "body");
    const commentUrl = nestedString(payload, "comment", "html_url");
    const commentId = nestedNumber(payload, "comment", "id");
    const issuePayload = nestedObject(payload, "issue");
    if ("pull_request" in issuePayload) {
      const context = await this.github.loadPullRequestReviewContext(repository, issueNumber);
      return this.sendToPullRequestTargets(
        context,
        "comment-created",
        actor,
        [context.authorLogin, ...mentionedLogins(body)],
        "PRにコメントが追加されました。",
        excerpt(body),
        "コメントを確認し、必要なら返信または修正する",
        commentUrl,
        fingerprint({ commentId, commentUrl }),
        job.deliveryId,
      );
    }
    const issue = await this.github.loadIssueContext(repository, issueNumber);
    return this.send(
      issue,
      null,
      "comment-created",
      actor,
      [...issue.assigneeLogins, ...mentionedLogins(body)],
      "Issueにコメントが追加されました。",
      excerpt(body),
      "コメントを確認し、必要なら返信または作業へ反映する",
      commentUrl,
      fingerprint({ commentId, commentUrl }),
      job.deliveryId,
    );
  }

  private async processPullRequest(job: GitHubWebhookJob): Promise<number> {
    const payload = objectPayload(job);
    const action = stringValue(payload.action);
    if (action !== "synchronize" && action !== "closed") return 0;
    const repository = repositoryName(payload);
    const pullRequestNumber = nestedNumber(payload, "pull_request", "number");
    const actor = nestedString(payload, "sender", "login");
    const context = await this.github.loadPullRequestReviewContext(repository, pullRequestNumber);
    if (action === "synchronize") {
      if (context.changesRequestedReviewerLogins.length === 0) return 0;
      return this.sendToPullRequestTargets(
        context,
        "revision-pushed",
        actor,
        context.changesRequestedReviewerLogins,
        "差し戻し後の修正がpushされました。",
        `head: ${context.headSha.slice(0, 12)}`,
        "修正内容を確認し、再レビューする",
        context.url,
        fingerprint({ headSha: context.headSha }),
        job.deliveryId,
      );
    }
    if (!nestedBoolean(payload, "pull_request", "merged")) return 0;
    const mergeCommitSha = nestedOptionalString(payload, "pull_request", "merge_commit_sha");
    return this.sendToPullRequestTargets(
      context,
      "pr-merged",
      actor,
      [context.authorLogin, ...(context.primaryIssue?.assigneeLogins ?? [])],
      "PRがマージされました。",
      `PR #${context.number} ${context.title}`,
      "Issueの完了条件と残作業を確認する",
      context.url,
      fingerprint({ mergeCommitSha, headSha: context.headSha }),
      job.deliveryId,
    );
  }

  private async processCheck(job: GitHubWebhookJob): Promise<number> {
    const payload = objectPayload(job);
    if (stringValue(payload.action) !== "completed") return 0;
    const checkKey = job.event === "check_run" ? "check_run" : "check_suite";
    const check = nestedObject(payload, checkKey);
    const conclusion = stringValue(check.conclusion).toLowerCase();
    const failedConclusions = new Set([
      "failure",
      "timed_out",
      "cancelled",
      "action_required",
      "stale",
    ]);
    if (conclusion !== "success" && !failedConclusions.has(conclusion)) return 0;
    const pullRequests = check.pull_requests;
    if (!Array.isArray(pullRequests) || pullRequests.length === 0) return 0;
    const repository = repositoryName(payload);
    const actor = nestedString(payload, "sender", "login");
    let notified = 0;
    for (const value of pullRequests) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const number = numberValue((value as Record<string, unknown>).number);
      if (number < 1) continue;
      const context = await this.github.loadPullRequestReviewContext(repository, number);
      const issue = primaryIssue(context);
      if (!issue || context.draft || context.state !== "open") continue;
      if (conclusion !== "success") {
        const checkName =
          optionalString(check.name) ?? (job.event === "check_run" ? "check" : "CI");
        const actionUrl = optionalString(check.html_url) ?? context.url;
        notified += await this.send(
          issue,
          { number: context.number, title: context.title, url: context.url },
          "ci-failed",
          actor,
          [context.authorLogin, ...issue.assigneeLogins],
          "PRのCIに対応が必要です。",
          `${checkName}: ${conclusion} / head: ${context.headSha.slice(0, 12)}`,
          "CIの失敗内容を確認し、修正または再実行する",
          actionUrl,
          fingerprint({ headSha: context.headSha, conclusion }),
          job.deliveryId,
        );
        continue;
      }
      if (
        context.mergeableState !== "clean" ||
        issueNotificationType(issue) !== "task" ||
        !issue.labels.includes("merge/self")
      ) {
        continue;
      }
      notified += await this.send(
        issue,
        { number: context.number, title: context.title, url: context.url },
        "self-merge-ready",
        actor,
        issue.assigneeLogins,
        "セルフマージ予定のPRがCIを通過しました。",
        "第三者承認を待たず、PR作成者本人が必須CI通過後にマージします。",
        "問題がある場合は、マージ前にセルフマージを停止してください",
        context.url,
        fingerprint({ headSha: context.headSha, conclusion: "success" }),
        job.deliveryId,
        { repository, issueNumber: issue.number },
      );
    }
    return notified;
  }

  private async notifySelfMergeScheduled(
    issue: GitHubIssueContext,
    repository: string,
    actor: string,
    job: GitHubWebhookJob,
  ): Promise<number> {
    if (issueNotificationType(issue) !== "task" || !issue.labels.includes("merge/self")) return 0;
    return this.send(
      issue,
      null,
      "self-merge-scheduled",
      actor,
      issue.assigneeLogins,
      "このIssueはセルフマージ予定です。",
      "第三者承認を待たず、PR作成者本人が必須CI通過後にマージします。",
      "問題がある場合は、マージ前にセルフマージを停止してください",
      issue.url,
      fingerprint({ url: issue.url, merge: "self" }),
      job.deliveryId,
      { repository, issueNumber: issue.number },
      !this.githubCapabilities.has(actor, "suppress_self_merge_channel_broadcast"),
    );
  }

  private async processReview(job: GitHubWebhookJob): Promise<number> {
    const payload = objectPayload(job);
    const action = stringValue(payload.action);
    if (action !== "submitted" && action !== "dismissed") return 0;
    const repository = repositoryName(payload);
    const pullRequestNumber = nestedNumber(payload, "pull_request", "number");
    const actor = nestedString(payload, "review", "user", "login");
    const body = nestedOptionalString(payload, "review", "body") ?? "";
    const reviewUrl =
      nestedOptionalString(payload, "review", "html_url") ??
      nestedString(payload, "pull_request", "html_url");
    const reviewId = nestedNumber(payload, "review", "id");
    const state = nestedString(payload, "review", "state").toUpperCase();
    const context = await this.github.loadPullRequestReviewContext(repository, pullRequestNumber);
    if (action === "dismissed") {
      return this.sendToPullRequestTargets(
        context,
        "review-dismissed",
        actor,
        [context.authorLogin],
        "レビュー結果が取り消されました。",
        excerpt(body || "GitHubでレビューの取り消し理由を確認してください。"),
        "必要なレビュー状態を確認する",
        reviewUrl,
        fingerprint({ reviewId, action }),
        job.deliveryId,
      );
    }
    if (state === "CHANGES_REQUESTED") {
      return this.sendToPullRequestTargets(
        context,
        "review-changes-requested",
        actor,
        [context.authorLogin, ...mentionedLogins(body)],
        "PRが差し戻されました。",
        excerpt(body || "GitHubで指摘内容を確認してください。"),
        "指摘を反映して修正をpushする",
        reviewUrl,
        fingerprint({ reviewId, state }),
        job.deliveryId,
      );
    }
    if (state === "APPROVED") {
      return this.sendToPullRequestTargets(
        context,
        "review-approved",
        actor,
        [context.authorLogin],
        "PRが承認されました。",
        excerpt(body || `@${actor} がApproveしました。`),
        "必要なcheckと承認が揃っていればマージする",
        reviewUrl,
        fingerprint({ reviewId, state }),
        job.deliveryId,
      );
    }
    if (state === "COMMENTED" && body.trim()) {
      return this.sendToPullRequestTargets(
        context,
        "review-commented",
        actor,
        [context.authorLogin, ...mentionedLogins(body)],
        "PRレビューにコメントが追加されました。",
        excerpt(body),
        "レビューコメントを確認し、必要なら返信または修正する",
        reviewUrl,
        fingerprint({ reviewId, state }),
        job.deliveryId,
      );
    }
    return 0;
  }

  private async processReviewComment(job: GitHubWebhookJob): Promise<number> {
    const payload = objectPayload(job);
    if (stringValue(payload.action) !== "created") return 0;
    const repository = repositoryName(payload);
    const pullRequestNumber = nestedNumber(payload, "pull_request", "number");
    const actor = nestedString(payload, "comment", "user", "login");
    const body = nestedString(payload, "comment", "body");
    const commentUrl = nestedString(payload, "comment", "html_url");
    const commentId = nestedNumber(payload, "comment", "id");
    const context = await this.github.loadPullRequestReviewContext(repository, pullRequestNumber);
    return this.sendToPullRequestTargets(
      context,
      "review-commented",
      actor,
      [context.authorLogin, ...mentionedLogins(body)],
      "PRのコードにコメントが追加されました。",
      excerpt(body),
      "コードコメントを確認し、必要なら返信または修正する",
      commentUrl,
      fingerprint({ commentId, commentUrl }),
      job.deliveryId,
    );
  }

  private async sendToPullRequestTargets(
    context: PullRequestReviewContext,
    kind: LifecycleNotificationKind,
    actor: string,
    mentionLogins: string[],
    summary: string,
    detail: string,
    nextAction: string,
    actionUrl: string,
    eventFingerprint: string,
    sourceDeliveryId: string,
  ): Promise<number> {
    const issue = primaryIssue(context);
    if (!issue) return 0;
    const pullRequest = {
      number: context.number,
      title: context.title,
      url: context.url,
    };
    return this.send(
      issue,
      pullRequest,
      kind,
      actor,
      mentionLogins,
      summary,
      detail,
      nextAction,
      actionUrl,
      eventFingerprint,
      sourceDeliveryId,
    );
  }

  private async send(
    issue: GitHubIssueContext,
    pullRequest: LifecyclePullRequest | null,
    kind: LifecycleNotificationKind,
    actorLogin: string,
    mentionLogins: string[],
    summary: string,
    detail: string,
    nextAction: string,
    actionUrl: string,
    eventFingerprint: string,
    sourceDeliveryId: string,
    selfMergeControl: { repository: string; issueNumber: number } | null = null,
    replyBroadcast: boolean | null = null,
  ): Promise<number> {
    const resource = issueResource(issue);
    const stateKey = `${resource.url}:${kind}`;
    const previous = await this.store.get<LifecycleNotificationState>(
      NOTIFICATION_NAMESPACE,
      stateKey,
    );
    if (previous?.fingerprint === eventFingerprint) return 0;
    if (kind !== "issue-opened" && issueNotificationType(issue) === "task") {
      await this.ensureIssueOpened(issue, sourceDeliveryId);
    }
    const suppressActorMention = shouldSuppressActorMention(kind);
    const recipientLogins = suppressActorMention
      ? withoutLogin(mentionLogins, actorLogin)
      : mentionLogins;
    const [slackUserIds, actorSlackUserId] = await Promise.all([
      this.resolveMentions(recipientLogins),
      suppressActorMention ? Promise.resolve(null) : this.resolveSlackUserId(actorLogin),
    ]);
    const notification: LifecycleNotification = {
      schemaVersion: 1,
      kind,
      resource,
      pullRequest,
      actorLogin,
      actorSlackUserId,
      slackUserIds,
      issueType: issueNotificationType(issue),
      summary,
      detail,
      nextAction,
      actionUrl,
      selfMergeControl,
      ...(replyBroadcast === null ? {} : { replyBroadcast }),
    };
    const metadata = {
      intentId: notificationIntentId({
        kind: "lifecycle",
        resourceUrl: resource.url,
        notificationKind: kind,
        eventFingerprint,
      }),
      sourceDeliveryId,
    };
    const threadRootIssue = await resolveNotificationThreadRootIssue(
      issue,
      this.github,
      this.allowedRepositories,
    );
    if (!threadRootIssue) {
      console.error(
        `Task ${issue.url} の親Work/Businessを通知scope内で解決できないため、channel直下へのfallbackを停止しました。`,
      );
      return 0;
    }
    const threadRootUrl = threadRootIssue.url;
    if (kind === "issue-opened" && threadRootUrl === resource.url) {
      await this.threads.ensureRoot(threadRootUrl, () =>
        this.notifier.notify(notification, null, metadata),
      );
    } else {
      await this.threads.publishReply(
        threadRootUrl,
        () => this.createIssueRoot(threadRootIssue, sourceDeliveryId),
        (threadTs) => this.notifier.notify(notification, threadTs, metadata),
      );
    }
    await this.store.set<LifecycleNotificationState>(NOTIFICATION_NAMESPACE, stateKey, {
      schemaVersion: 1,
      resourceUrl: resource.url,
      kind,
      fingerprint: eventFingerprint,
      notifiedAt: new Date(this.now()).toISOString(),
    });
    return 1;
  }

  private async ensureIssueOpened(
    issue: GitHubIssueContext,
    sourceDeliveryId: string,
  ): Promise<number> {
    const copy = issueOpenedCopy(issue);
    const opened = await this.send(
      issue,
      null,
      "issue-opened",
      issueRootActorLogin(issue),
      issueRootMentionLogins(issue),
      copy.summary,
      issueOverview(issue),
      copy.nextAction,
      issue.url,
      issueOpenedEventFingerprint(issue),
      sourceDeliveryId,
    );
    if (opened > 0) {
      await this.store.create<IssueCreationSetupState>(ISSUE_CREATION_SETUP_NAMESPACE, issue.url, {
        schemaVersion: 1,
        revision: 1,
        issueUrl: issue.url,
        pendingAssigneeLogins: uniqueNormalizedLogins(issue.assigneeLogins),
      });
    }
    return opened;
  }

  private async consumeInitialAssignee(issueUrl: string, assigneeLogin: string): Promise<boolean> {
    return this.updateInitialAssignee(issueUrl, assigneeLogin, true);
  }

  private async discardInitialAssignee(issueUrl: string, assigneeLogin: string): Promise<void> {
    await this.updateInitialAssignee(issueUrl, assigneeLogin, false);
  }

  private async updateInitialAssignee(
    issueUrl: string,
    assigneeLogin: string,
    reportConsumption: boolean,
  ): Promise<boolean> {
    const normalizedAssignee = assigneeLogin.toLowerCase();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.store.get<IssueCreationSetupState>(
        ISSUE_CREATION_SETUP_NAMESPACE,
        issueUrl,
      );
      if (!current?.pendingAssigneeLogins.includes(normalizedAssignee)) return false;
      const next: IssueCreationSetupState = {
        ...current,
        revision: current.revision + 1,
        pendingAssigneeLogins: current.pendingAssigneeLogins.filter(
          (login) => login !== normalizedAssignee,
        ),
      };
      if (
        await this.store.compareAndSet(
          ISSUE_CREATION_SETUP_NAMESPACE,
          issueUrl,
          current.revision,
          next,
        )
      ) {
        return reportConsumption;
      }
    }
    throw new Error("Issue作成時の初期担当者状態が競合しました。");
  }

  private async createIssueRoot(
    issue: GitHubIssueContext,
    sourceDeliveryId: string,
  ): Promise<ThreadMessageResult> {
    const [slackUserIds, actorSlackUserId] = await Promise.all([
      this.resolveMentions(issueRootMentionLogins(issue)),
      Promise.resolve(null),
    ]);
    return this.notifier.notify(
      issueRootNotification(issue, slackUserIds, actorSlackUserId),
      null,
      {
        intentId: notificationIntentId({
          kind: "lifecycle",
          resourceUrl: issue.url,
          notificationKind: "issue-opened",
          eventFingerprint: "issue-root-v1",
        }),
        sourceDeliveryId,
      },
    );
  }

  private async resolveMentions(logins: string[]): Promise<string[]> {
    const uniqueLogins = [...new Map(logins.map((login) => [login.toLowerCase(), login])).values()];
    const resolved = await Promise.all(uniqueLogins.map(this.resolveSlackUserId));
    return [...new Set(resolved.filter((value): value is string => value !== null))];
  }
}

export async function resolveNotificationThreadRootIssue(
  issue: GitHubIssueContext,
  github: Pick<GitHubLifecycleClient, "loadIssueContext">,
  allowedRepositories: ReadonlySet<string> | null = null,
): Promise<GitHubIssueContext | null> {
  const type = issueNotificationType(issue);
  if (type !== "task") return issue;
  const parent = issue.parentIssueUrl ? parseIssueReferenceUrl(issue.parentIssueUrl) : null;
  if (!parent) return null;
  if (allowedRepositories && !allowedRepositories.has(parent.repository.toLowerCase())) return null;
  const parentIssue = await github.loadIssueContext(parent.repository, parent.number);
  const parentType = issueNotificationType(parentIssue);
  return parentType === "work" || parentType === "business" ? parentIssue : null;
}

function primaryIssue(context: PullRequestReviewContext): GitHubIssueContext | null {
  return context.closingIssueCount === 1 && context.primaryIssue?.labels.includes("type/task")
    ? context.primaryIssue
    : null;
}

function issueResource(issue: GitHubIssueContext): LifecycleResource {
  return { kind: "issue", number: issue.number, title: issue.title, url: issue.url };
}

function issueOverview(issue: GitHubIssueContext): string {
  const type = issue.labels.find((label) => label.startsWith("type/")) ?? "種別未設定";
  const owners = issue.assigneeLogins.map((login) => `@${login}`).join("、") || "未担当";
  const parent = issue.parentIssueUrl ? issueReferenceFromUrl(issue.parentIssueUrl) : "なし";
  const done = issueSectionSummary(issue.body, "完了条件") ?? "未記載";
  const targetDate = issueSectionSummary(issue.body, "目標日") ?? "未設定";
  const overview = [
    `種別: ${type}`,
    `親Issue: ${parent}`,
    `担当: ${owners}`,
    `完了条件: ${done}`,
    `目標日: ${targetDate}`,
  ];
  if (issueNotificationType(issue) === "task") {
    overview.push(
      `マージ方針: ${issue.labels.find((label) => label.startsWith("merge/")) ?? "未設定"}`,
    );
  }
  return overview.join("\n");
}

export function issueRootNotification(
  issue: GitHubIssueContext,
  slackUserIds: string[],
  actorSlackUserId: string | null,
): LifecycleNotification {
  const copy = issueOpenedCopy(issue);
  return {
    schemaVersion: 1,
    kind: "issue-opened",
    resource: issueResource(issue),
    pullRequest: null,
    actorLogin: issueRootActorLogin(issue),
    actorSlackUserId,
    slackUserIds,
    issueType: issueNotificationType(issue),
    summary: copy.summary,
    detail: issueOverview(issue),
    nextAction: copy.nextAction,
    actionUrl: issue.url,
    selfMergeControl: null,
  };
}

export function issueRootMentionLogins(issue: GitHubIssueContext): string[] {
  return withoutLogin([issue.authorLogin, ...issue.assigneeLogins], issueRootActorLogin(issue));
}

export function issueOpenedEventFingerprint(issue: GitHubIssueContext): string {
  return fingerprint({ action: "opened", url: issue.url });
}

export function issueRootActorLogin(issue: GitHubIssueContext): string {
  return parseIssueRequester(issue.body)?.login ?? issue.authorLogin;
}

export function shouldSuppressActorMention(kind: LifecycleNotificationKind): boolean {
  return SUPPRESS_ACTOR_MENTION_KINDS.has(kind);
}

function withoutLogin(logins: string[], actorLogin: string): string[] {
  const actor = actorLogin.toLowerCase();
  return logins.filter((login) => login.toLowerCase() !== actor);
}

function issueNotificationType(issue: GitHubIssueContext): IssueNotificationType {
  for (const type of ["intake", "work", "task", "business"] as const) {
    if (issue.labels.includes(`type/${type}`)) return type;
  }
  return null;
}

function issueOpenedCopy(issue: GitHubIssueContext): { summary: string; nextAction: string } {
  switch (issueNotificationType(issue)) {
    case "intake":
      return {
        summary: "Intakeに新しい相談・要望が届きました。",
        nextAction: "背景と期待結果を整理し、WorkまたはBusinessへ分解する",
      };
    case "work":
      return {
        summary: "開発Workが作成されました。",
        nextAction: "目的・完了条件・親Issueを確認し、実装に着手する",
      };
    case "task":
      return {
        summary: "親Issue配下のTaskが作成されました。",
        nextAction: "親Issueと作業範囲を確認し、担当作業を進める",
      };
    case "business":
      return {
        summary: "Business項目が作成されました。",
        nextAction: "期待する事業上の変化・確認者・検証方法を確認する",
      };
    default:
      return {
        summary: "Issueが作成されました。",
        nextAction: "種別・担当・完了条件・親子関係を確認する",
      };
  }
}

function issueReferenceFromUrl(url: string): string {
  const reference = parseIssueReferenceUrl(url);
  return reference ? `${reference.repository}#${reference.number}` : url;
}

export function parseIssueReferenceUrl(url: string): { repository: string; number: number } | null {
  const match = url.match(/(?:\/repos)?\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]*)\/?$/u);
  return match?.[1] && match[2] ? { repository: match[1], number: Number(match[2]) } : null;
}

function issueSectionSummary(body: string, heading: string): string | null {
  const marker = `## ${heading}`;
  const start = body.indexOf(marker);
  if (start < 0) return null;
  const contentStart = start + marker.length;
  const nextHeading = body.indexOf("\n## ", contentStart);
  const section = body
    .slice(contentStart, nextHeading < 0 ? undefined : nextHeading)
    .trim()
    .replace(/^- \[[ xX]\]\s*/u, "");
  return section ? excerpt(section) : null;
}

function mentionedLogins(body: string): string[] {
  return [...body.matchAll(/(?:^|[^A-Za-z0-9_.+-])@([A-Za-z0-9-]{1,39})\b/g)]
    .flatMap((match) => (match[1] ? [match[1]] : []))
    .filter((login, index, values) => values.indexOf(login) === index);
}

function uniqueNormalizedLogins(logins: string[]): string[] {
  return [...new Set(logins.map((login) => login.toLowerCase()))];
}

function excerpt(value: string): string {
  const collapsed = value
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return "GitHubで内容を確認してください。";
  return collapsed.length <= 500 ? collapsed : `${collapsed.slice(0, 497)}...`;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function objectPayload(job: GitHubWebhookJob): Record<string, unknown> {
  if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) {
    throw new Error("GitHub webhook payloadを読み取れませんでした。");
  }
  return job.payload as Record<string, unknown>;
}

function repositoryName(payload: Record<string, unknown>): string {
  const repository = nestedString(payload, "repository", "full_name");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("GitHub webhookのrepository名が不正です。");
  }
  return repository;
}

function nestedObject(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const nested = value[key];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
    throw new Error(`GitHub webhookの${key}を読み取れませんでした。`);
  }
  return nested as Record<string, unknown>;
}

function nestedString(value: Record<string, unknown>, ...keys: string[]): string {
  const result = nestedValue(value, keys);
  if (typeof result !== "string" || !result) {
    throw new Error(`GitHub webhookの${keys.join(".")}を読み取れませんでした。`);
  }
  return result;
}

function nestedOptionalString(value: Record<string, unknown>, ...keys: string[]): string | null {
  const result = nestedValue(value, keys);
  return typeof result === "string" && result ? result : null;
}

function nestedNumber(value: Record<string, unknown>, ...keys: string[]): number {
  const result = nestedValue(value, keys);
  if (!Number.isSafeInteger(result) || Number(result) < 1) {
    throw new Error(`GitHub webhookの${keys.join(".")}を読み取れませんでした。`);
  }
  return Number(result);
}

function nestedBoolean(value: Record<string, unknown>, ...keys: string[]): boolean {
  return nestedValue(value, keys) === true;
}

function nestedValue(value: Record<string, unknown>, keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function numberValue(value: unknown): number {
  return Number.isSafeInteger(value) ? Number(value) : 0;
}
