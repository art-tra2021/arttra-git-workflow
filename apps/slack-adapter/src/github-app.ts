import { createPrivateKey, sign } from "node:crypto";
import type { SlackAdapterDependencies } from "./app.ts";
import { buildIssueCreateInput, parseIssueForm } from "./github-shared.ts";
import type { IssueTemplateSchema } from "./issue-schema.ts";
import { toHumanWorkItem } from "./read-model.ts";
import type { CreatedIssue, CreateIssueCommand, HumanWorkItem, WorkItemSnapshot } from "./types.ts";

export type GitHubFetch = (input: string, init?: RequestInit) => Promise<Response>;

interface GitHubAppConfig {
  appId: string;
  installationId: string;
  privateKey: string;
  repository: string;
  githubLogin: string;
  owners: string[];
  apiBaseUrl?: string;
  fetch?: GitHubFetch;
  now?: () => number;
}

interface InstallationToken {
  token: string;
  expires_at: string;
}

interface InstallationRepositories {
  total_count: number;
  repositories: Array<{ full_name: string; archived: boolean }>;
}

interface ApiIssue {
  number: number;
  title: string;
  html_url: string;
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
}

export class GitHubAppDependencies implements SlackAdapterDependencies {
  private readonly config: Required<
    Pick<
      GitHubAppConfig,
      "appId" | "installationId" | "privateKey" | "repository" | "githubLogin" | "owners"
    >
  >;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: GitHubFetch;
  private readonly now: () => number;
  private readonly templateCache = new Map<string, IssueTemplateSchema[]>();
  private token: CachedToken | null = null;

  constructor(config: GitHubAppConfig) {
    this.config = config;
    this.apiBaseUrl = (config.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.fetchImpl = config.fetch ?? fetch;
    this.now = config.now ?? Date.now;
  }

  async listRepositories(): Promise<string[]> {
    const allowedOwners = new Set(this.config.owners.map((owner) => owner.toLowerCase()));
    const repositories: string[] = [];
    for (let page = 1; ; page += 1) {
      const result = await this.api<InstallationRepositories>(
        `/installation/repositories?per_page=100&page=${page}`,
      );
      repositories.push(
        ...result.repositories
          .filter(
            (repository) =>
              !repository.archived &&
              allowedOwners.has((repository.full_name.split("/")[0] ?? "").toLowerCase()),
          )
          .map((repository) => repository.full_name),
      );
      if (page * 100 >= result.total_count || result.repositories.length === 0) {
        break;
      }
    }
    const unique = [...new Set(repositories)].filter(
      (repository) => repository !== this.config.repository,
    );
    return [this.config.repository, ...unique.sort()];
  }

  async listIssueTemplates(repository: string): Promise<IssueTemplateSchema[]> {
    const cached = this.templateCache.get(repository);
    if (cached) {
      return cached;
    }
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
    this.templateCache.set(repository, templates);
    return templates;
  }

  async loadWorkItems(_slackUserId?: string): Promise<HumanWorkItem[]> {
    return (await this.listIssues(20, this.config.githubLogin)).map((issue) =>
      toHumanWorkItem(toSnapshot(issue), this.config.githubLogin),
    );
  }

  async loadCanvasItems(): Promise<HumanWorkItem[]> {
    return (await this.listIssues(50)).map((issue) =>
      toHumanWorkItem(toSnapshot(issue), this.config.githubLogin),
    );
  }

  async claimIssue(issueNumber: number, _slackUserId?: string): Promise<HumanWorkItem> {
    const issue = await this.api<ApiIssue>(
      `/repos/${this.config.repository}/issues/${issueNumber}`,
      {
        method: "PATCH",
        body: JSON.stringify({ assignees: [this.config.githubLogin] }),
      },
    );
    return toHumanWorkItem(toSnapshot(issue), this.config.githubLogin);
  }

  async createIssue(command: CreateIssueCommand): Promise<CreatedIssue> {
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

  private async listIssues(limit: number, assignee?: string): Promise<ApiIssue[]> {
    const query = new URLSearchParams({ state: "open", per_page: String(limit) });
    if (assignee) {
      query.set("assignee", assignee);
    }
    const issues = await this.api<ApiIssue[]>(
      `/repos/${this.config.repository}/issues?${query.toString()}`,
    );
    return issues.filter((issue) => issue.pull_request === undefined);
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
    this.token = { value: created.token, expiresAt };
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
  return new Error(
    `GitHub API操作に失敗しました（HTTP ${response.status}${requestId ? ` / request ${requestId}` : ""}）${detail}`,
  );
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
