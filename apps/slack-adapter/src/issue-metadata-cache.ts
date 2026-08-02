import type { IssueTemplateSchema } from "./issue-schema.ts";
import type { StateStore } from "./state-store.ts";

const REPOSITORY_NAMESPACE = "issue-metadata-repositories";
const TEMPLATE_NAMESPACE = "issue-metadata-templates";
const GLOBAL_KEY = "global";

export interface IssueMetadataSource {
  listRepositories(): Promise<string[]>;
  listIssueTemplates(repository: string): Promise<IssueTemplateSchema[]>;
}

interface RepositoryCache {
  schemaVersion: 1;
  repositories: string[];
  refreshedAt: string;
}

interface TemplateCache {
  schemaVersion: 1;
  repository: string;
  templates: IssueTemplateSchema[];
  refreshedAt: string;
}

export interface IssueMetadataRefreshResult {
  repositoryCount: number;
  templateRepositoryCount: number;
}

export class IssueMetadataCache implements IssueMetadataSource {
  private readonly source: IssueMetadataSource;
  private readonly store: StateStore;
  private repositories: string[] | null = null;
  private readonly templates = new Map<string, IssueTemplateSchema[]>();

  constructor(source: IssueMetadataSource, store: StateStore) {
    this.source = source;
    this.store = store;
  }

  async listRepositories(): Promise<string[]> {
    if (this.repositories) return [...this.repositories];
    const cached = await this.store.get<RepositoryCache>(REPOSITORY_NAMESPACE, GLOBAL_KEY);
    if (cached) {
      this.repositories = cached.repositories;
      return [...cached.repositories];
    }
    return this.refreshRepositories();
  }

  async listIssueTemplates(repository: string): Promise<IssueTemplateSchema[]> {
    const memory = this.templates.get(repository);
    if (memory) return [...memory];
    const cached = await this.store.get<TemplateCache>(TEMPLATE_NAMESPACE, repository);
    if (cached) {
      this.templates.set(repository, cached.templates);
      return [...cached.templates];
    }
    return this.refreshTemplates(repository);
  }

  async refresh(defaultTemplateRepositories: string[] = []): Promise<IssueMetadataRefreshResult> {
    const repositories = await this.refreshRepositories();
    const cachedTemplates = await this.store.list<TemplateCache>(TEMPLATE_NAMESPACE);
    const templateRepositories = [
      ...new Set([
        ...defaultTemplateRepositories,
        ...cachedTemplates.map((cached) => cached.repository),
      ]),
    ].filter((repository) => repositories.includes(repository));
    await Promise.all(templateRepositories.map((repository) => this.refreshTemplates(repository)));
    return {
      repositoryCount: repositories.length,
      templateRepositoryCount: templateRepositories.length,
    };
  }

  private async refreshRepositories(): Promise<string[]> {
    const repositories = await this.source.listRepositories();
    const unique = [...new Set(repositories)];
    await this.store.set<RepositoryCache>(REPOSITORY_NAMESPACE, GLOBAL_KEY, {
      schemaVersion: 1,
      repositories: unique,
      refreshedAt: new Date().toISOString(),
    });
    this.repositories = unique;
    return [...unique];
  }

  private async refreshTemplates(repository: string): Promise<IssueTemplateSchema[]> {
    const templates = await this.source.listIssueTemplates(repository);
    await this.store.set<TemplateCache>(TEMPLATE_NAMESPACE, repository, {
      schemaVersion: 1,
      repository,
      templates,
      refreshedAt: new Date().toISOString(),
    });
    this.templates.set(repository, templates);
    return [...templates];
  }
}
