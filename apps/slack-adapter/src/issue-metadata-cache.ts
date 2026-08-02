import type { IssueTemplateSchema } from "./issue-schema.ts";
import type { StateStore } from "./state-store.ts";

const REPOSITORY_NAMESPACE = "issue-metadata-repositories";
const TEMPLATE_NAMESPACE = "issue-metadata-templates";
const GLOBAL_KEY = "global";
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface IssueMetadataSource {
  listRepositories(): Promise<string[]>;
  /**
   * 利用者のGitHub loginが実際に参照できるrepositoryだけを返す。
   * viewer-aware APIを実装しないsourceからは、権限境界を推測してはいけない。
   */
  listRepositoriesForViewer?(githubLogin: string): Promise<string[]>;
  listIssueTemplates(repository: string): Promise<IssueTemplateSchema[]>;
  listIssueTemplatesForViewer?(
    githubLogin: string,
    repository: string,
  ): Promise<IssueTemplateSchema[]>;
}

interface RepositoryCache {
  schemaVersion: 1;
  viewerGithubLogin?: string;
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
  private readonly now: () => number;
  private repositories: string[] | null = null;
  private readonly repositoriesByViewer = new Map<string, RepositoryCache>();
  private readonly templates = new Map<string, TemplateCache>();

  constructor(source: IssueMetadataSource, store: StateStore, now: () => number = Date.now) {
    this.source = source;
    this.store = store;
    this.now = now;
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

  /**
   * GitHub利用者ごとのrepository picker候補を取得する。
   *
   * グローバル一覧のcacheを流用すると、private repository名だけでも漏れるため、
   * viewerごとにメモリ・永続cacheを分離する。sourceがviewer-aware APIを持たない
   * 場合は、推測でglobal一覧を返さず安全側で失敗する。
   */
  async listRepositoriesForViewer(githubLogin: string): Promise<string[]> {
    const viewer = normalizeViewer(githubLogin);
    const memory = this.repositoriesByViewer.get(viewer);
    if (memory && isFreshViewerCache(memory, this.now())) return [...memory.repositories];
    if (memory) this.repositoriesByViewer.delete(viewer);

    const cached = await this.store.get<RepositoryCache>(
      REPOSITORY_NAMESPACE,
      viewerRepositoryKey(viewer),
    );
    if (
      cached?.viewerGithubLogin?.toLowerCase() === viewer &&
      isFreshViewerCache(cached, this.now())
    ) {
      this.repositoriesByViewer.set(viewer, cached);
      return [...cached.repositories];
    }

    if (!this.source.listRepositoriesForViewer) {
      throw new Error("repositoryごとのGitHub権限を確認できるbackendが設定されていません。");
    }
    const repositories = uniqueRepositories(
      await this.source.listRepositoriesForViewer(githubLogin),
    );
    const refreshed: RepositoryCache = {
      schemaVersion: 1,
      viewerGithubLogin: githubLogin,
      repositories,
      refreshedAt: new Date(this.now()).toISOString(),
    };
    await this.store.set<RepositoryCache>(
      REPOSITORY_NAMESPACE,
      viewerRepositoryKey(viewer),
      refreshed,
    );
    this.repositoriesByViewer.set(viewer, refreshed);
    return [...repositories];
  }

  /**
   * viewer-aware pickerで選択されたrepositoryのIssue templateを読む。
   * repositoryがviewer一覧にない場合はtemplate APIを呼ばず拒否する。
   */
  async listIssueTemplatesForViewer(
    githubLogin: string,
    repository: string,
  ): Promise<IssueTemplateSchema[]> {
    const repositories = await this.listRepositoriesForViewer(githubLogin);
    if (!repositories.some((candidate) => candidate.toLowerCase() === repository.toLowerCase())) {
      throw new Error(`GitHub @${githubLogin} は${repository}を参照できません。`);
    }
    return this.listIssueTemplates(repository);
  }

  async listIssueTemplates(repository: string): Promise<IssueTemplateSchema[]> {
    const memory = this.templates.get(repository);
    if (memory && isFreshCache(memory.refreshedAt, this.now())) return [...memory.templates];
    if (memory) this.templates.delete(repository);
    const cached = await this.store.get<TemplateCache>(TEMPLATE_NAMESPACE, repository);
    if (cached && isFreshCache(cached.refreshedAt, this.now())) {
      this.templates.set(repository, cached);
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
    const unique = uniqueRepositories(repositories);
    await this.store.set<RepositoryCache>(REPOSITORY_NAMESPACE, GLOBAL_KEY, {
      schemaVersion: 1,
      repositories: unique,
      refreshedAt: new Date(this.now()).toISOString(),
    });
    this.repositories = unique;
    return [...unique];
  }

  private async refreshTemplates(repository: string): Promise<IssueTemplateSchema[]> {
    const templates = await this.source.listIssueTemplates(repository);
    const refreshed: TemplateCache = {
      schemaVersion: 1,
      repository,
      templates,
      refreshedAt: new Date(this.now()).toISOString(),
    };
    await this.store.set<TemplateCache>(TEMPLATE_NAMESPACE, repository, refreshed);
    this.templates.set(repository, refreshed);
    return [...templates];
  }
}

function normalizeViewer(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9-]{1,39}$/.test(normalized)) {
    throw new Error("GitHub loginが不正です。");
  }
  return normalized;
}

function viewerRepositoryKey(githubLogin: string): string {
  return `viewer:${githubLogin}`;
}

function uniqueRepositories(repositories: string[]): string[] {
  const canonical = new Map<string, string>();
  for (const repository of repositories) {
    const normalized = repository.trim();
    if (normalized) canonical.set(normalized.toLowerCase(), normalized);
  }
  return [...canonical.values()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function isFreshViewerCache(cache: RepositoryCache, now: number): boolean {
  return isFreshCache(cache.refreshedAt, now);
}

function isFreshCache(refreshedAtValue: string, now: number): boolean {
  const refreshedAt = Date.parse(refreshedAtValue);
  return Number.isFinite(refreshedAt) && now - refreshedAt < CACHE_TTL_MS;
}
