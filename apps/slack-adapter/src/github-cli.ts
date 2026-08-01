import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SlackAdapterDependencies } from "./app.ts";
import { buildIssueCreateInput, parseIssueForm } from "./github-shared.ts";
import type { IssueTemplateSchema } from "./issue-schema.ts";
import {
  ORGANIZATION_PROJECT_ITEMS_QUERY,
  type OrganizationProjectItemsResponse,
  organizationProjectIssuePage,
  PROJECT_ISSUES_QUERY,
  type ProjectIssuesResponse,
  projectIssueNodes,
  projectIssueSnapshot,
} from "./project-read-model.ts";
import { toHumanWorkItem } from "./read-model.ts";
import type { CreatedIssue, CreateIssueCommand, HumanWorkItem, WorkItemSnapshot } from "./types.ts";

interface GhIssue {
  number: number;
  title: string;
  url: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
}

interface GhRepository {
  nameWithOwner: string;
  isArchived: boolean;
}

interface GhContentEntry {
  name: string;
  path: string;
  type: string;
}

const execFileAsync = promisify(execFile);

export class GitHubCliDependencies implements SlackAdapterDependencies {
  private readonly repository: string;
  private readonly githubLogin: string;
  private readonly owners: string[];
  private readonly project: { owner: string; number: number } | null;
  private readonly templateCache = new Map<string, IssueTemplateSchema[]>();

  constructor(
    repository: string,
    githubLogin: string,
    owners = [repository.split("/")[0] ?? githubLogin],
    project: { owner: string; number: number } | null = null,
  ) {
    this.repository = repository;
    this.githubLogin = githubLogin;
    this.owners = owners;
    this.project = project;
  }

  async listRepositories(): Promise<string[]> {
    const lists = await Promise.all(
      this.owners.map((owner) =>
        ghJson<GhRepository[]>([
          "repo",
          "list",
          owner,
          "--limit",
          "100",
          "--source",
          "--json",
          "nameWithOwner,isArchived",
        ]),
      ),
    );
    const repositories = [
      ...new Set(
        lists
          .flat()
          .filter((repo) => !repo.isArchived)
          .map((repo) => repo.nameWithOwner),
      ),
    ].filter((repository) => repository !== this.repository);
    return [this.repository, ...repositories.sort()];
  }

  async listIssueTemplates(repository: string): Promise<IssueTemplateSchema[]> {
    const cached = this.templateCache.get(repository);
    if (cached) {
      return cached;
    }
    const entries = await ghJson<GhContentEntry[]>([
      "api",
      `repos/${repository}/contents/.github/ISSUE_TEMPLATE`,
    ]);
    const forms = await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.type === "file" && /\.ya?ml$/i.test(entry.name) && entry.name !== "config.yml",
        )
        .map(async (entry) =>
          parseIssueForm(
            entry.name.replace(/\.ya?ml$/i, ""),
            await gh([
              "api",
              "-H",
              "Accept: application/vnd.github.raw+json",
              `repos/${repository}/contents/${entry.path}`,
            ]),
          ),
        ),
    );
    const templates = forms.filter((form): form is IssueTemplateSchema => form !== null);
    this.templateCache.set(repository, templates);
    return templates;
  }

  async loadWorkItems(): Promise<HumanWorkItem[]> {
    const issues = await this.workIssues(100, this.githubLogin);
    return issues.map((issue) => toHumanWorkItem(projectIssueSnapshot(issue), this.githubLogin));
  }

  async loadProjectItems(): Promise<HumanWorkItem[]> {
    return (await this.workIssues(100)).map((issue) =>
      toHumanWorkItem(projectIssueSnapshot(issue), this.githubLogin),
    );
  }

  async claimIssue(repository: string, issueNumber: number): Promise<HumanWorkItem> {
    await gh([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repository,
      "--add-assignee",
      this.githubLogin,
    ]);
    const issue = await ghJson<GhIssue>([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repository,
      "--json",
      "number,title,url,labels,assignees",
    ]);
    return toHumanWorkItem(toSnapshot(issue), this.githubLogin);
  }

  async createIssue(command: CreateIssueCommand): Promise<CreatedIssue> {
    const schema = (await this.listIssueTemplates(command.repository)).find(
      (template) => template.id === command.template,
    );
    if (!schema) {
      throw new Error(`Issue templateが見つかりません: ${command.template}`);
    }
    const input = buildIssueCreateInput(command, schema);
    const url = (
      await gh([
        "issue",
        "create",
        "--repo",
        command.repository,
        "--title",
        input.title,
        "--body",
        input.body,
        ...input.labels.flatMap((label) => ["--label", label]),
        ...input.assignees.flatMap((assignee) => ["--assignee", assignee]),
      ])
    ).trim();
    return ghJson<CreatedIssue>([
      "issue",
      "view",
      url,
      "--repo",
      command.repository,
      "--json",
      "number,title,url",
    ]);
  }

  async validateIssueAuthorization(command: CreateIssueCommand): Promise<void> {
    const canWrite = (
      await gh([
        "api",
        `repos/${command.repository}`,
        "--jq",
        ".permissions.triage or .permissions.push or .permissions.maintain or .permissions.admin",
      ])
    ).trim();
    if (canWrite !== "true") {
      throw new Error(`GitHubで${command.repository}のIssueを作成する権限がありません。`);
    }
    const template = (await this.listIssueTemplates(command.repository)).find(
      (candidate) => candidate.id === command.template,
    );
    if (!template) {
      throw new Error(`Issue templateが見つかりません: ${command.template}`);
    }
  }

  private async projectIssues(limit: number, assignee: string | null = null) {
    const [owner, name] = this.repository.split("/");
    if (!owner || !name) throw new Error(`repository名が不正です: ${this.repository}`);
    return projectIssueNodes(
      await ghJson<ProjectIssuesResponse>([
        "api",
        "graphql",
        "-f",
        `query=${PROJECT_ISSUES_QUERY}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `limit=${limit}`,
        ...(assignee ? ["-F", `assignee=${assignee}`] : []),
      ]),
    );
  }

  private async workIssues(limit: number, assignee: string | null = null) {
    if (!this.project) {
      return this.projectIssues(limit, assignee);
    }
    const issues = [];
    let cursor: string | null = null;
    do {
      const page = organizationProjectIssuePage(
        await ghJson<OrganizationProjectItemsResponse>([
          "api",
          "graphql",
          "-f",
          `query=${ORGANIZATION_PROJECT_ITEMS_QUERY}`,
          "-F",
          `owner=${this.project.owner}`,
          "-F",
          `number=${this.project.number}`,
          "-F",
          `limit=${limit}`,
          ...(cursor ? ["-f", `cursor=${cursor}`] : []),
        ]),
        this.project.number,
        assignee,
      );
      issues.push(...page.issues);
      if (page.hasNextPage && !page.endCursor) {
        throw new Error("GitHub Projectの次ページ位置を読み取れませんでした。");
      }
      cursor = page.hasNextPage ? page.endCursor : null;
    } while (cursor);
    return issues;
  }
}

function toSnapshot(issue: GhIssue): WorkItemSnapshot {
  const type = issue.labels.some((label) => label.name === "type/business")
    ? "business"
    : issue.labels.some((label) => label.name === "type/intake")
      ? "intake"
      : "work";
  return {
    schemaVersion: 1,
    issue: { number: issue.number, title: issue.title, url: issue.url, type },
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

async function gh(args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("gh", args, { maxBuffer: 4 * 1024 * 1024 });
    return result.stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GitHub操作に失敗しました: ${message}`);
  }
}

async function ghJson<T>(args: string[]): Promise<T> {
  return JSON.parse(await gh(args)) as T;
}
