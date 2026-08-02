import { createPrivateKey, sign } from "node:crypto";
import type { SlackAdapterDependencies } from "./app.ts";
import { buildIssueCreateInput, parseIssueForm } from "./github-shared.ts";
import type { IssueTemplateSchema } from "./issue-schema.ts";
import {
  ORGANIZATION_PROJECT_ITEMS_QUERY,
  type OrganizationProjectItemsResponse,
  organizationProjectIssuePage,
  PROJECT_ISSUES_QUERY,
  type ProjectIssueNode,
  type ProjectIssuesResponse,
  projectIssueNodes,
  projectIssueSnapshot,
} from "./project-read-model.ts";
import { toHumanWorkItem } from "./read-model.ts";
import type {
  GitHubIssueContext,
  GitHubReviewClient,
  GitHubReviewerIdentity,
  PullRequestReviewContext,
} from "./review-types.ts";
import type {
  CreatedIssue,
  CreateIssueCommand,
  HumanWorkItem,
  RepositoryPermission,
  WorkItemSnapshot,
} from "./types.ts";

export type GitHubFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** GitHub loginから見えるrepositoryの最小公開モデル。 */
export interface AccessibleRepository {
  fullName: string;
  permission: RepositoryPermission;
  visibility: "public" | "private" | "internal";
}

/** repository名・GitHub loginの組み合わせを安全側で拒否したときのエラー。 */
export class RepositoryAccessDeniedError extends Error {
  readonly repository: string;
  readonly githubLogin: string;

  constructor(repository: string, githubLogin: string) {
    super(`GitHub @${githubLogin} は${repository}を参照する権限がありません。`);
    this.name = "RepositoryAccessDeniedError";
    this.repository = repository;
    this.githubLogin = githubLogin;
  }
}

interface GitHubAppConfig {
  appId: string;
  installationId: string;
  privateKey: string;
  repository: string;
  githubLogin: string;
  owners: string[];
  project?: { owner: string; number: number } | null;
  apiBaseUrl?: string;
  fetch?: GitHubFetch;
  now?: () => number;
  resolveGitHubLogin?: (slackUserId: string) => Promise<string>;
}

interface InstallationToken {
  token: string;
  expires_at: string;
  permissions?: Record<string, string>;
}

interface InstallationRepositories {
  total_count: number;
  repositories: Array<{
    full_name: string;
    archived: boolean;
    private?: boolean;
    visibility?: string | null;
  }>;
}

type InstallationRepository = InstallationRepositories["repositories"][number];

interface ApiRepository {
  full_name?: string;
  archived?: boolean;
  private?: boolean;
  visibility?: string | null;
}

interface ApiIssue {
  number: number;
  title: string;
  html_url: string;
  body: string | null;
  state: "open" | "closed";
  user: { login: string };
  labels: Array<string | { name?: string }>;
  assignees: Array<{ login: string }>;
  pull_request?: unknown;
}

interface ContentEntry {
  name: string;
  path: string;
  type: string;
}

interface CachedToken {
  value: string;
  expiresAt: number;
  permissions: Record<string, string>;
}

interface CachedIssueTemplates {
  templates: IssueTemplateSchema[];
  expiresAt: number;
}

export class GitHubAppDependencies implements SlackAdapterDependencies, GitHubReviewClient {
  private readonly config: Required<
    Pick<
      GitHubAppConfig,
      "appId" | "installationId" | "privateKey" | "repository" | "githubLogin" | "owners"
    >
  >;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: GitHubFetch;
  private readonly now: () => number;
  private readonly resolveGitHubLogin: (slackUserId: string) => Promise<string>;
  private readonly project: { owner: string; number: number } | null;
  private readonly templateCache = new Map<string, CachedIssueTemplates>();
  private token: CachedToken | null = null;

  constructor(config: GitHubAppConfig) {
    this.config = config;
    this.apiBaseUrl = (config.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.fetchImpl = config.fetch ?? fetch;
    this.now = config.now ?? Date.now;
    this.resolveGitHubLogin = config.resolveGitHubLogin ?? (async () => this.config.githubLogin);
    this.project = config.project ?? null;
  }

  async listRepositories(): Promise<string[]> {
    const repositories = await this.installationRepositories();
    const unique = [...new Set(repositories.map((repository) => repository.full_name))].filter(
      (repository) => repository !== this.config.repository,
    );
    return [this.config.repository, ...unique.sort()];
  }

  /**
   * Installationが参照でき、かつ指定GitHub loginがread以上で参照できるrepositoryを返す。
   *
   * Installation tokenはApp自身の権限しか表さないため、private/internal repositoryでは
   * collaborator permission APIで利用者のeffective permissionを再確認する。public repository
   * はGitHubの公開read権限を明示的に`read`として扱い、権限APIが404になる通常ケースでも
   * 正しく候補へ含める。不明なvisibility・403・404は候補から除外する。
   */
  async listAccessibleRepositories(githubLogin: string): Promise<AccessibleRepository[]> {
    const viewer = normalizeGitHubLogin(githubLogin);
    const candidates = await this.installationRepositories();
    const accessible = await Promise.all(
      candidates.map(async (candidate): Promise<AccessibleRepository | null> => {
        const visibility = await this.repositoryVisibility(candidate);
        if (!visibility) return null;
        const permission =
          visibility === "public"
            ? ("read" as const)
            : await this.repositoryPermission(candidate.full_name, viewer);
        if (permission === "none") return null;
        return { fullName: candidate.full_name, permission, visibility };
      }),
    );
    return accessible
      .filter((repository): repository is AccessibleRepository => repository !== null)
      .sort((left, right) => compareStrings(left.fullName, right.fullName));
  }

  /** repository picker向けのviewer-awareな名前だけのAPI。 */
  async listRepositoriesForViewer(githubLogin: string): Promise<string[]> {
    const repositories = await this.listAccessibleRepositories(githubLogin);
    return repositories.map((repository) => repository.fullName);
  }

  /**
   * Issue作成・template取得前に、利用者が対象repositoryを参照できることを確認する。
   * read権限も候補としては有効だが、作成操作自体はGitHub AppのIssues write権限で行う。
   */
  async assertRepositoryAccess(
    repository: string,
    githubLogin: string,
  ): Promise<AccessibleRepository> {
    const normalizedRepository = normalizeRepositoryName(repository);
    const viewer = normalizeGitHubLogin(githubLogin);
    const accessible = await this.listAccessibleRepositories(viewer);
    const match = accessible.find(
      (candidate) => candidate.fullName.toLowerCase() === normalizedRepository.toLowerCase(),
    );
    if (!match) {
      throw new RepositoryAccessDeniedError(repository, viewer);
    }
    return match;
  }

  private async installationRepositories(): Promise<InstallationRepository[]> {
    const allowedOwners = new Set(this.config.owners.map((owner) => owner.toLowerCase()));
    const repositories: InstallationRepository[] = [];
    for (let page = 1; ; page += 1) {
      const result = await this.api<InstallationRepositories>(
        `/installation/repositories?per_page=100&page=${page}`,
      );
      repositories.push(
        ...result.repositories.filter(
          (repository) =>
            !repository.archived &&
            allowedOwners.has((repository.full_name.split("/")[0] ?? "").toLowerCase()),
        ),
      );
      if (page * 100 >= result.total_count || result.repositories.length === 0) {
        break;
      }
    }
    const seen = new Set<string>();
    return repositories.filter((repository) => {
      const key = repository.full_name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private async repositoryVisibility(
    candidate: InstallationRepository,
  ): Promise<AccessibleRepository["visibility"] | null> {
    const known = normalizeVisibility(candidate.visibility, candidate.private);
    if (known) return known;
    try {
      const repository = await this.api<ApiRepository>(`/repos/${candidate.full_name}`);
      return normalizeVisibility(repository.visibility, repository.private);
    } catch (error) {
      if (error instanceof GitHubApiError && (error.status === 403 || error.status === 404)) {
        return null;
      }
      throw error;
    }
  }

  async listIssueTemplates(repository: string): Promise<IssueTemplateSchema[]> {
    const cached = this.templateCache.get(repository);
    if (cached && cached.expiresAt > this.now()) return [...cached.templates];
    if (cached) this.templateCache.delete(repository);
    const entries = await this.api<ContentEntry[]>(
      `/repos/${repository}/contents/.github/ISSUE_TEMPLATE`,
    );
    const templates = (
      await Promise.all(
        entries
          .filter(
            (entry) =>
              entry.type === "file" && /\.ya?ml$/i.test(entry.name) && entry.name !== "config.yml",
          )
          .map(async (entry) =>
            parseIssueForm(
              entry.name.replace(/\.ya?ml$/i, ""),
              await this.apiText(`/repos/${repository}/contents/${entry.path}`),
            ),
          ),
      )
    ).filter((template): template is IssueTemplateSchema => template !== null);
    this.templateCache.set(repository, {
      templates,
      expiresAt: this.now() + 5 * 60 * 1000,
    });
    return templates;
  }

  async loadWorkItems(slackUserId: string): Promise<HumanWorkItem[]> {
    const githubLogin = await this.resolveGitHubLogin(slackUserId);
    return (await this.workIssues(100, githubLogin)).map((issue) =>
      toHumanWorkItem(projectIssueSnapshot(issue), githubLogin),
    );
  }

  async loadProjectItems(): Promise<HumanWorkItem[]> {
    return (await this.workIssues(100)).map((issue) =>
      toHumanWorkItem(projectIssueSnapshot(issue), this.config.githubLogin),
    );
  }

  async claimIssue(
    repository: string,
    issueNumber: number,
    _slackUserId?: string,
    viewerGitHubLogin?: string,
  ): Promise<HumanWorkItem> {
    if (!viewerGitHubLogin) throw new Error("Issueの担当者となるGitHub loginが必要です。");
    const viewer = normalizeGitHubLogin(viewerGitHubLogin);
    await this.assertRepositoryAccess(repository, viewer);
    const issue = await this.api<ApiIssue>(`/repos/${repository}/issues/${issueNumber}`, {
      method: "PATCH",
      body: JSON.stringify({ assignees: [viewer] }),
    });
    return toHumanWorkItem(toSnapshot(issue), viewer);
  }

  async createIssue(
    command: CreateIssueCommand,
    viewerGitHubLogin?: string,
  ): Promise<CreatedIssue> {
    const viewer = await this.resolveIssueViewer(command, viewerGitHubLogin);
    if (viewer) {
      await this.assertRepositoryAccess(command.repository, viewer);
    }
    const schema = (await this.listIssueTemplates(command.repository)).find(
      (template) => template.id === command.template,
    );
    if (!schema) {
      throw new Error(`Issue templateが見つかりません: ${command.template}`);
    }
    const input = buildIssueCreateInput(command, schema);
    const issue = await this.api<ApiIssue>(`/repos/${command.repository}/issues`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    return { number: issue.number, title: issue.title, url: issue.html_url };
  }

  async validateIssueAuthorization(
    command: CreateIssueCommand,
    viewerGitHubLogin?: string,
  ): Promise<void> {
    const viewer = await this.resolveIssueViewer(command, viewerGitHubLogin);
    if (viewer) {
      await this.assertRepositoryAccess(command.repository, viewer);
    }
    await this.installationToken();
    const permissions = this.token?.permissions ?? {};
    if (permissions.issues !== "write") {
      throw new Error("GitHub AppにIssues write権限がありません。App設定を確認してください。");
    }
    if (permissions.contents !== "read" && permissions.contents !== "write") {
      throw new Error("GitHub AppにContents read権限がありません。App設定を確認してください。");
    }
    await this.api<unknown>(`/repos/${command.repository}`);
    const template = (await this.listIssueTemplates(command.repository)).find(
      (candidate) => candidate.id === command.template,
    );
    if (!template) {
      throw new Error(`Issue templateが見つかりません: ${command.template}`);
    }
  }

  async repositoryPermission(
    repository: string,
    githubLogin: string,
  ): Promise<RepositoryPermission> {
    try {
      const result = await this.api<{ permission?: string }>(
        `/repos/${repository}/collaborators/${githubLogin}/permission`,
      );
      return normalizeRepositoryPermission(result.permission);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        return "none";
      }
      if (error instanceof GitHubApiError && error.status === 403) {
        // 権限APIを読めない場合にglobal候補へ戻すとprivate repositoryが漏れるため、
        // 例外ではなくnoneとしてfail-closedで扱う。
        return "none";
      }
      throw error;
    }
  }

  async loadPullRequestReviewContext(
    repository: string,
    pullRequestNumber: number,
  ): Promise<PullRequestReviewContext> {
    const pullRequest = await this.api<{
      number: number;
      title: string;
      html_url: string;
      body: string | null;
      draft: boolean;
      state: "open" | "closed";
      user: { login: string };
      head: { sha: string };
      requested_reviewers: Array<{ login: string }>;
      requested_teams: Array<{ slug: string }>;
    }>(`/repos/${repository}/pulls/${pullRequestNumber}`);
    const [files, reviews, linkedIssues, codeowners, requiredApprovals] = await Promise.all([
      this.paginate<Array<{ filename: string }>>(
        `/repos/${repository}/pulls/${pullRequestNumber}/files`,
      ),
      this.paginate<Array<{ state: string; user: { login: string } }>>(
        `/repos/${repository}/pulls/${pullRequestNumber}/reviews`,
      ),
      this.loadLinkedIssues(repository, pullRequest.body ?? ""),
      this.loadCodeowners(repository),
      this.loadRequiredApprovals(repository),
    ]);
    const latestDecisions = latestReviewDecisions(reviews);
    return {
      schemaVersion: 1,
      repository,
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.html_url,
      authorLogin: pullRequest.user.login,
      headSha: pullRequest.head.sha,
      draft: pullRequest.draft,
      state: pullRequest.state,
      body: pullRequest.body ?? "",
      files: files.map((file) => file.filename),
      linkedIssues,
      codeowners,
      requiredApprovals,
      requestedReviewerLogins: pullRequest.requested_reviewers.map((reviewer) => reviewer.login),
      requestedTeamSlugs: pullRequest.requested_teams.map((team) => team.slug),
      approvedReviewerLogins: reviews
        .filter(
          (review) =>
            latestDecisions.get(review.user.login.toLowerCase()) === "APPROVED" &&
            review.state.toUpperCase() === "APPROVED",
        )
        .map((review) => review.user.login)
        .filter((login, index, values) => values.indexOf(login) === index),
      changesRequestedReviewerLogins: reviews
        .filter(
          (review) =>
            latestDecisions.get(review.user.login.toLowerCase()) === "CHANGES_REQUESTED" &&
            review.state.toUpperCase() === "CHANGES_REQUESTED",
        )
        .map((review) => review.user.login)
        .filter((login, index, values) => values.indexOf(login) === index),
    };
  }

  async loadIssueContext(repository: string, issueNumber: number): Promise<GitHubIssueContext> {
    const issue = await this.api<ApiIssue>(`/repos/${repository}/issues/${issueNumber}`);
    if (issue.pull_request) {
      throw new Error(`Issue #${issueNumber}はPull Requestです。`);
    }
    return issueContext(issue);
  }

  async resolveGitHubUsers(logins: string[]): Promise<GitHubReviewerIdentity[]> {
    return Promise.all(
      [...new Set(logins)].map(async (login) => {
        const user = await this.api<{ id: number; login: string }>(`/users/${login}`);
        return { id: user.id, login: user.login };
      }),
    );
  }

  async requestPullRequestReviewers(
    repository: string,
    pullRequestNumber: number,
    reviewerLogins: string[],
    teamSlugs: string[],
  ): Promise<void> {
    if (reviewerLogins.length === 0 && teamSlugs.length === 0) {
      return;
    }
    await this.api(`/repos/${repository}/pulls/${pullRequestNumber}/requested_reviewers`, {
      method: "POST",
      body: JSON.stringify({ reviewers: reviewerLogins, team_reviewers: teamSlugs }),
    });
  }

  private async resolveIssueViewer(
    command: CreateIssueCommand,
    explicitViewer?: string,
  ): Promise<string | null> {
    if (explicitViewer !== undefined) {
      return normalizeGitHubLogin(explicitViewer);
    }
    // 旧CLIやmigration用のJSON command（slackTeamIdを持たないもの）は、
    // 既存の非対話契約を壊さないようviewer確認を明示指定時だけ行う。
    if (!command.slackTeamId) return null;
    return normalizeGitHubLogin(await this.resolveGitHubLogin(command.actor));
  }

  private async projectIssues(
    limit: number,
    assignee: string | null = null,
  ): Promise<ProjectIssueNode[]> {
    const [owner, name] = this.config.repository.split("/");
    if (!owner || !name) throw new Error(`repository名が不正です: ${this.config.repository}`);
    const response = await this.api<ProjectIssuesResponse>("/graphql", {
      method: "POST",
      body: JSON.stringify({
        query: PROJECT_ISSUES_QUERY,
        variables: { owner, name, limit, assignee },
      }),
    });
    return projectIssueNodes(response);
  }

  private async workIssues(
    limit: number,
    assignee: string | null = null,
  ): Promise<ProjectIssueNode[]> {
    if (!this.project) {
      return this.projectIssues(limit, assignee);
    }
    const issues: ProjectIssueNode[] = [];
    let cursor: string | null = null;
    do {
      const response = await this.api<OrganizationProjectItemsResponse>("/graphql", {
        method: "POST",
        body: JSON.stringify({
          query: ORGANIZATION_PROJECT_ITEMS_QUERY,
          variables: {
            owner: this.project.owner,
            number: this.project.number,
            limit,
            cursor,
          },
        }),
      });
      const page = organizationProjectIssuePage(response, this.project.number, assignee);
      issues.push(...page.issues);
      if (page.hasNextPage && !page.endCursor) {
        throw new Error("GitHub Projectの次ページ位置を読み取れませんでした。");
      }
      cursor = page.hasNextPage ? page.endCursor : null;
    } while (cursor);
    return issues;
  }

  private async paginate<T extends unknown[]>(path: string): Promise<T> {
    const results: unknown[] = [];
    for (let page = 1; ; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const pageResults = await this.api<unknown[]>(`${path}${separator}per_page=100&page=${page}`);
      results.push(...pageResults);
      if (pageResults.length < 100) {
        return results as T;
      }
    }
  }

  private async loadLinkedIssues(
    repository: string,
    pullRequestBody: string,
  ): Promise<GitHubIssueContext[]> {
    const numbers = [...pullRequestBody.matchAll(/(?:^|\s)#([1-9][0-9]*)\b/gm)]
      .map((match) => Number(match[1]))
      .filter((number, index, values) => values.indexOf(number) === index)
      .slice(0, 10);
    return Promise.all(
      numbers.map(async (number) =>
        issueContext(await this.api<ApiIssue>(`/repos/${repository}/issues/${number}`)),
      ),
    );
  }

  private async loadCodeowners(repository: string): Promise<string> {
    for (const path of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
      try {
        return await this.apiText(`/repos/${repository}/contents/${path}`);
      } catch (error) {
        if (!(error instanceof GitHubApiError) || error.status !== 404) {
          throw error;
        }
      }
    }
    return "";
  }

  private async loadRequiredApprovals(repository: string): Promise<number> {
    try {
      const summaries = await this.api<Array<{ id: number; enforcement: string }>>(
        `/repos/${repository}/rulesets?includes_parents=true`,
      );
      const rulesets = await Promise.all(
        summaries
          .filter((ruleset) => ruleset.enforcement === "active")
          .map((ruleset) =>
            this.api<{
              rules: Array<{
                type: string;
                parameters?: { required_approving_review_count?: number };
              }>;
            }>(`/repos/${repository}/rulesets/${ruleset.id}`),
          ),
      );
      return Math.max(
        0,
        ...rulesets.flatMap((ruleset) =>
          ruleset.rules
            .filter((rule) => rule.type === "pull_request")
            .map((rule) => rule.parameters?.required_approving_review_count ?? 0),
        ),
      );
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 403) {
        throw new Error(
          "GitHub AppにRulesetsを読むAdministration read権限がありません。App設定を確認してください。",
        );
      }
      if (error instanceof GitHubApiError && error.status === 404) {
        return 0;
      }
      throw error;
    }
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.installationToken();
    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "arttra-slack-adapter",
        "X-GitHub-Api-Version": "2022-11-28",
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw await githubError(response);
    }
    return (await response.json()) as T;
  }

  private async apiText(path: string): Promise<string> {
    const token = await this.installationToken();
    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      headers: {
        Accept: "application/vnd.github.raw+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "arttra-slack-adapter",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw await githubError(response);
    }
    return response.text();
  }

  private async installationToken(): Promise<string> {
    const now = this.now();
    if (this.token && this.token.expiresAt - now > 60_000) {
      return this.token.value;
    }
    const jwt = createAppJwt(this.config.appId, this.config.privateKey, now);
    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/app/installations/${this.config.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          "User-Agent": "arttra-slack-adapter",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      throw await githubError(response);
    }
    const created = (await response.json()) as InstallationToken;
    const expiresAt = Date.parse(created.expires_at);
    if (!created.token || !Number.isFinite(expiresAt)) {
      throw new Error("GitHub Appのinstallation token応答を読み取れませんでした。");
    }
    this.token = { value: created.token, expiresAt, permissions: created.permissions ?? {} };
    return created.token;
  }
}

export function createAppJwt(appId: string, privateKey: string, nowMilliseconds: number): string {
  const nowSeconds = Math.floor(nowMilliseconds / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }),
  );
  const signingInput = `${header}.${payload}`;
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(privateKey.replace(/\\n/g, "\n"));
  } catch {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEYを読み取れませんでした。Secret Managerの値を確認してください。",
    );
  }
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), key).toString("base64url");
  return `${signingInput}.${signature}`;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

async function githubError(response: Response): Promise<Error> {
  const requestId = response.headers.get("x-github-request-id");
  let detail = "";
  try {
    const body = (await response.json()) as { message?: string };
    detail = body.message ? `: ${body.message}` : "";
  } catch {
    // GitHubがJSONを返さない場合も秘密情報を含めずstatusだけを通知する。
  }
  return new GitHubApiError(
    response.status,
    `GitHub API操作に失敗しました（HTTP ${response.status}${requestId ? ` / request ${requestId}` : ""}）${detail}`,
  );
}

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

function normalizeGitHubLogin(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9-]{1,39}$/.test(normalized)) {
    throw new Error("GitHub loginが不正です。");
  }
  return normalized;
}

function normalizeRepositoryName(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(normalized)) {
    throw new Error("repository名が不正です。");
  }
  return normalized;
}

function normalizeVisibility(
  visibility: string | null | undefined,
  isPrivate: boolean | undefined,
): AccessibleRepository["visibility"] | null {
  if (visibility === "public") return "public";
  if (visibility === "internal") return "internal";
  if (visibility === "private" || isPrivate === true) return "private";
  if (isPrivate === false) return "public";
  return null;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeRepositoryPermission(value: string | undefined): RepositoryPermission {
  return ["admin", "maintain", "write", "triage", "read"].includes(value ?? "")
    ? (value as RepositoryPermission)
    : "none";
}

function issueContext(issue: ApiIssue): GitHubIssueContext {
  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    body: issue.body ?? "",
    state: issue.state,
    authorLogin: issue.user.login,
    assigneeLogins: issue.assignees.map((assignee) => assignee.login),
  };
}

function latestReviewDecisions(
  reviews: Array<{ state: string; user: { login: string } }>,
): Map<string, "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED"> {
  const decisions = new Map<string, "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED">();
  for (const review of reviews) {
    const state = review.state.toUpperCase();
    if (state === "APPROVED" || state === "CHANGES_REQUESTED" || state === "DISMISSED") {
      decisions.set(review.user.login.toLowerCase(), state);
    }
  }
  return decisions;
}

function toSnapshot(issue: ApiIssue): WorkItemSnapshot {
  const labels = issue.labels.map((label) =>
    typeof label === "string" ? label : (label.name ?? ""),
  );
  const type = labels.includes("type/business")
    ? "business"
    : labels.includes("type/intake")
      ? "intake"
      : "work";
  return {
    schemaVersion: 1,
    issue: { number: issue.number, title: issue.title, url: issue.html_url, type },
    project: {
      status: "todo",
      priority: "P2",
      owner: issue.assignees[0]?.login ?? null,
      targetDate: null,
    },
    relationships: { blockedBy: [] },
    pullRequest: null,
  };
}
