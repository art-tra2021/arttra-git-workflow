import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse } from "yaml";
import type { SlackAdapterDependencies } from "./app.ts";
import type { IssueFieldSchema, IssueTemplateSchema } from "./issue-schema.ts";
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

interface RawIssueForm {
  name?: string;
  title?: string;
  labels?: string[];
  body?: Array<{
    type?: string;
    id?: string;
    attributes?: { label?: string; options?: string[]; value?: string };
    validations?: { required?: boolean };
  }>;
}

const execFileAsync = promisify(execFile);

export class GitHubCliDependencies implements SlackAdapterDependencies {
  private readonly repository: string;
  private readonly githubLogin: string;
  private readonly owners: string[];
  private readonly templateCache = new Map<string, IssueTemplateSchema[]>();

  constructor(
    repository: string,
    githubLogin: string,
    owners = [repository.split("/")[0] ?? githubLogin],
  ) {
    this.repository = repository;
    this.githubLogin = githubLogin;
    this.owners = owners;
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
    const issues = await ghJson<GhIssue[]>([
      "issue",
      "list",
      "--repo",
      this.repository,
      "--assignee",
      this.githubLogin,
      "--state",
      "open",
      "--limit",
      "20",
      "--json",
      "number,title,url,labels,assignees",
    ]);
    return issues.map((issue) => toHumanWorkItem(toSnapshot(issue), this.githubLogin));
  }

  async loadCanvasItems(): Promise<HumanWorkItem[]> {
    const issues = await ghJson<GhIssue[]>([
      "issue",
      "list",
      "--repo",
      this.repository,
      "--state",
      "open",
      "--limit",
      "50",
      "--json",
      "number,title,url,labels,assignees",
    ]);
    return issues.map((issue) => toHumanWorkItem(toSnapshot(issue), this.githubLogin));
  }

  async claimIssue(issueNumber: number): Promise<HumanWorkItem> {
    await gh([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      this.repository,
      "--add-assignee",
      this.githubLogin,
    ]);
    const issue = await ghJson<GhIssue>([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      this.repository,
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
    const body = [
      ...schema.fields.flatMap((field) => [
        `## ${field.label}`,
        "",
        command.fields[field.id] || "未設定",
        "",
      ]),
      "## 作成元",
      "",
      "Slack `/ar new`",
    ].join("\n");
    const labels = schema.labels.filter(
      (label) => command.template !== "work" || !label.startsWith("merge/"),
    );
    if (command.template === "work") {
      const mergeLabel: Record<string, string> = {
        "通常レビュー（既定）": "merge/review",
        自分でマージ可: "merge/self",
        "緊急マージ（事後レビュー必須）": "merge/emergency",
      };
      const mergeMode = command.fields.merge ?? "";
      labels.push(mergeLabel[mergeMode] ?? "merge/review");
    }
    const url = (
      await gh([
        "issue",
        "create",
        "--repo",
        command.repository,
        "--title",
        `${schema.titlePrefix}${command.title}`,
        "--body",
        body,
        ...labels.flatMap((label) => ["--label", label]),
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

function parseIssueForm(id: string, source: string): IssueTemplateSchema | null {
  const raw = parse(source) as RawIssueForm;
  if (!raw.name || !raw.body) {
    return null;
  }
  const fields = raw.body.flatMap<IssueFieldSchema>((item) => {
    if (!item.id || !item.attributes?.label) {
      return [];
    }
    const kind =
      item.type === "dropdown"
        ? "select"
        : item.type === "textarea"
          ? "textarea"
          : item.type === "input"
            ? "input"
            : null;
    if (!kind) {
      return [];
    }
    return [
      {
        id: item.id,
        label: item.attributes.label,
        kind,
        required: item.validations?.required ?? false,
        ...(item.attributes.options ? { options: item.attributes.options } : {}),
        ...(item.attributes.value ? { initialValue: item.attributes.value } : {}),
      },
    ];
  });
  return {
    id,
    name: raw.name,
    titlePrefix: raw.title ?? "",
    labels: raw.labels ?? [],
    fields,
  };
}
