import { createHash } from "node:crypto";
import type { GitHubIdentityService } from "./identity-service.ts";
import type {
  GitHubReviewClient,
  GitHubReviewerIdentity,
  PullRequestReviewContext,
  ReviewRequestReadModel,
} from "./review-types.ts";
import type { StateStore } from "./state-store.ts";

const READ_MODEL_NAMESPACE = "review-read-model";
const NOTIFICATION_NAMESPACE = "review-notification";

interface ReviewNotifier {
  notify(model: ReviewRequestReadModel, context?: ReviewNotificationContext): Promise<void>;
}

interface ReviewNotificationContext {
  sourceDeliveryId?: string;
}

interface ReviewNotificationState {
  revision: number;
  headSha: string;
  fingerprint: string;
  notifiedAt: string;
}

interface ReviewServiceOptions {
  slackTeamId: string;
  reminderMilliseconds?: number;
  now?: () => number;
  allowedRepositories?: readonly string[];
}

interface ReviewerCandidate {
  login: string;
  reasons: Set<string>;
  expectedGitHubUserIds: Set<number>;
}

interface ReviewProcessOptions {
  reRequestChanges?: boolean;
  sourceDeliveryId?: string;
}

export class PullRequestReviewService {
  private readonly github: GitHubReviewClient;
  private readonly identities: Pick<GitHubIdentityService, "findByGitHubUserId">;
  private readonly store: StateStore;
  private readonly notifier: ReviewNotifier;
  private readonly slackTeamId: string;
  private readonly reminderMilliseconds: number;
  private readonly now: () => number;
  private readonly allowedRepositories: Set<string> | null;

  constructor(
    github: GitHubReviewClient,
    identities: Pick<GitHubIdentityService, "findByGitHubUserId">,
    store: StateStore,
    notifier: ReviewNotifier,
    options: ReviewServiceOptions,
  ) {
    this.github = github;
    this.identities = identities;
    this.store = store;
    this.notifier = notifier;
    this.slackTeamId = options.slackTeamId;
    this.reminderMilliseconds = options.reminderMilliseconds ?? 24 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
    this.allowedRepositories = options.allowedRepositories
      ? new Set(options.allowedRepositories.map((repository) => repository.toLowerCase()))
      : null;
  }

  async process(
    repository: string,
    pullRequestNumber: number,
    options: ReviewProcessOptions = {},
  ): Promise<ReviewRequestReadModel | null> {
    if (this.allowedRepositories && !this.allowedRepositories.has(repository.toLowerCase())) {
      return null;
    }
    const context = await this.github.loadPullRequestReviewContext(repository, pullRequestNumber);
    if (context.draft || context.state !== "open") {
      return null;
    }
    if (context.closingIssueCount !== 1 || !context.primaryIssue?.labels.includes("type/task")) {
      return null;
    }
    const { users, teams } = collectReviewerCandidates(context);
    const approved = new Set(context.approvedReviewerLogins.map(normalizeLogin));
    const changesRequested = new Set(context.changesRequestedReviewerLogins.map(normalizeLogin));
    const requestedUsers = new Set(context.requestedReviewerLogins.map(normalizeLogin));
    const requestedTeams = new Set(context.requestedTeamSlugs.map(normalizeLogin));
    const author = normalizeLogin(context.authorLogin);
    const activeUsers = [...users.values()].filter(
      (candidate) =>
        normalizeLogin(candidate.login) !== author &&
        !approved.has(normalizeLogin(candidate.login)) &&
        (options.reRequestChanges === true ||
          !changesRequested.has(normalizeLogin(candidate.login))),
    );
    const activeTeams = [...teams.entries()].filter(
      ([slug]) => !requestedTeams.has(normalizeLogin(slug)),
    );
    await this.github.requestPullRequestReviewers(
      repository,
      pullRequestNumber,
      activeUsers
        .filter((candidate) => !requestedUsers.has(normalizeLogin(candidate.login)))
        .map((candidate) => candidate.login),
      activeTeams.map(([slug]) => slug),
    );
    const resolvedUsers = await this.github.resolveGitHubUsers(
      activeUsers.map((candidate) => candidate.login),
    );
    const identityByLogin = new Map(
      resolvedUsers.map((identity) => [normalizeLogin(identity.login), identity]),
    );
    const reviewerModels = await Promise.all(
      activeUsers.map(async (candidate) => {
        const githubIdentity = identityByLogin.get(normalizeLogin(candidate.login));
        if (!githubIdentity) {
          throw new Error(`GitHub reviewerを検証できませんでした: @${candidate.login}`);
        }
        if (
          candidate.expectedGitHubUserIds.size > 0 &&
          !candidate.expectedGitHubUserIds.has(githubIdentity.id)
        ) {
          throw new Error(`予定レビュワー @${candidate.login} のGitHub user IDが一致しません。`);
        }
        const slackIdentity = await this.identities.findByGitHubUserId(
          this.slackTeamId,
          githubIdentity.id,
        );
        return {
          githubUserId: githubIdentity.id,
          githubLogin: githubIdentity.login,
          slackUserId: slackIdentity?.slackUserId ?? null,
          reasons: [...candidate.reasons].sort(),
          notified: false,
        };
      }),
    );
    const model: ReviewRequestReadModel = {
      schemaVersion: 1,
      kind: "review.request",
      repository,
      pullRequest: {
        number: context.number,
        title: context.title,
        url: context.url,
        headSha: context.headSha,
      },
      authorLogin: context.authorLogin,
      primaryIssue: context.primaryIssue,
      closingIssueCount: context.closingIssueCount,
      linkedIssues: context.linkedIssues,
      requiredApprovals: context.requiredApprovals,
      reviewers: reviewerModels,
      teams: [...teams.entries()].map(([slug, reasons]) => ({
        slug,
        reasons: [...reasons].sort(),
      })),
      dueDate: extractDueDate(context.primaryIssue ? [context.primaryIssue.body] : []),
      nextAction: "GitHubで変更内容を確認し、Approveまたは修正依頼を行う",
      updatedAt: new Date(this.now()).toISOString(),
    };
    const shouldNotify = await this.shouldNotify(model);
    if (shouldNotify) {
      await this.notifier.notify(model, {
        ...(options.sourceDeliveryId ? { sourceDeliveryId: options.sourceDeliveryId } : {}),
      });
      for (const reviewer of model.reviewers) {
        reviewer.notified = reviewer.slackUserId !== null;
      }
      await this.rememberNotification(model);
    }
    await this.store.set(READ_MODEL_NAMESPACE, reviewKey(repository, pullRequestNumber), model);
    return model;
  }

  async remindPending(): Promise<number> {
    const models = await this.store.list<ReviewRequestReadModel>(READ_MODEL_NAMESPACE);
    let processed = 0;
    for (const model of models) {
      await this.process(model.repository, model.pullRequest.number);
      processed += 1;
    }
    return processed;
  }

  private async shouldNotify(model: ReviewRequestReadModel): Promise<boolean> {
    const previous = await this.store.get<ReviewNotificationState>(
      NOTIFICATION_NAMESPACE,
      reviewKey(model.repository, model.pullRequest.number),
    );
    if (!previous) {
      return true;
    }
    const fingerprint = reviewFingerprint(model);
    return (
      previous.fingerprint !== fingerprint ||
      this.now() - Date.parse(previous.notifiedAt) >= this.reminderMilliseconds
    );
  }

  private async rememberNotification(model: ReviewRequestReadModel): Promise<void> {
    const key = reviewKey(model.repository, model.pullRequest.number);
    const previous = await this.store.get<ReviewNotificationState>(NOTIFICATION_NAMESPACE, key);
    await this.store.set<ReviewNotificationState>(NOTIFICATION_NAMESPACE, key, {
      revision: (previous?.revision ?? 0) + 1,
      headSha: model.pullRequest.headSha,
      fingerprint: reviewFingerprint(model),
      notifiedAt: new Date(this.now()).toISOString(),
    });
  }
}

export function collectReviewerCandidates(context: PullRequestReviewContext): {
  users: Map<string, ReviewerCandidate>;
  teams: Map<string, Set<string>>;
} {
  const users = new Map<string, ReviewerCandidate>();
  const teams = new Map<string, Set<string>>();
  for (const login of context.requestedReviewerLogins) {
    addUser(users, login, "GitHubで指定されたreviewer");
  }
  for (const slug of context.requestedTeamSlugs) {
    addReason(teams, slug, "GitHubで指定されたreviewer team");
  }
  for (const issue of context.closingIssueCount === 1 &&
  context.primaryIssue?.labels.includes("type/task")
    ? [context.primaryIssue]
    : []) {
    for (const reviewer of parsePlannedReviewers(issue.body)) {
      addUser(users, reviewer.login, `Issue #${issue.number}の予定レビュワー`, reviewer.id);
    }
  }
  const rules = parseCodeowners(context.codeowners);
  for (const file of context.files) {
    const owners = matchingOwners(file, rules);
    for (const owner of owners) {
      const value = owner.slice(1);
      if (value.includes("/")) {
        const slug = value.split("/")[1] ?? value;
        addReason(teams, slug, `CODEOWNERS: ${file}`);
      } else {
        addUser(users, value, `CODEOWNERS: ${file}`);
      }
    }
  }
  return { users, teams };
}

export function parsePlannedReviewers(body: string): GitHubReviewerIdentity[] {
  const match = body.match(/<!--\s*ar:reviewers:v1\s+(\[[\s\S]*?\])\s*-->/);
  if (!match?.[1]) {
    return [];
  }
  try {
    const parsed = JSON.parse(match[1]) as Array<{ id?: number; login?: string }>;
    return parsed.filter(
      (reviewer): reviewer is GitHubReviewerIdentity =>
        Number.isSafeInteger(reviewer.id) &&
        typeof reviewer.login === "string" &&
        /^[A-Za-z0-9-]{1,39}$/.test(reviewer.login),
    );
  } catch {
    return [];
  }
}

interface CodeownerRule {
  pattern: RegExp;
  owners: string[];
}

export function parseCodeowners(source: string): CodeownerRule[] {
  return source.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return [];
    }
    const [rawPattern, ...owners] = trimmed.split(/\s+/);
    if (!rawPattern || owners.length === 0) {
      return [];
    }
    return [
      {
        pattern: codeownerPattern(rawPattern),
        owners: owners.filter((owner) => owner.startsWith("@")),
      },
    ];
  });
}

function matchingOwners(file: string, rules: CodeownerRule[]): string[] {
  let owners: string[] = [];
  for (const rule of rules) {
    if (rule.pattern.test(file)) {
      owners = rule.owners;
    }
  }
  return owners;
}

function codeownerPattern(pattern: string): RegExp {
  const anchored = pattern.startsWith("/");
  const directory = pattern.endsWith("/");
  const normalized = pattern.replace(/^\//, "").replace(/\/$/, "");
  let expression = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index] ?? "";
    const next = normalized[index + 1] ?? "";
    if (character === "*" && next === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const prefix = anchored || normalized.includes("/") ? "^" : "(?:^|.*/)";
  return new RegExp(`${prefix}${expression}${directory ? "(?:/.*)?" : ""}$`);
}

function addUser(
  users: Map<string, ReviewerCandidate>,
  login: string,
  reason: string,
  expectedGitHubUserId?: number,
): void {
  const key = normalizeLogin(login);
  const existing = users.get(key) ?? {
    login,
    reasons: new Set<string>(),
    expectedGitHubUserIds: new Set<number>(),
  };
  existing.reasons.add(reason);
  if (expectedGitHubUserId !== undefined) {
    existing.expectedGitHubUserIds.add(expectedGitHubUserId);
  }
  users.set(key, existing);
}

function addReason(map: Map<string, Set<string>>, key: string, reason: string): void {
  const reasons = map.get(key) ?? new Set<string>();
  reasons.add(reason);
  map.set(key, reasons);
}

function extractDueDate(bodies: string[]): string | null {
  for (const body of bodies) {
    const match = body.match(/##\s*目標日\s*\n+\s*(\d{4}-\d{2}-\d{2})\b/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

function reviewKey(repository: string, pullRequestNumber: number): string {
  return `${repository}#${pullRequestNumber}`;
}

function reviewFingerprint(model: ReviewRequestReadModel): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        reviewers: model.reviewers.map((reviewer) => ({
          id: reviewer.githubUserId,
          reasons: reviewer.reasons,
        })),
        teams: model.teams,
        dueDate: model.dueDate,
        requiredApprovals: model.requiredApprovals,
      }),
    )
    .digest("hex");
}

function normalizeLogin(value: string): string {
  return value.toLowerCase();
}
