import { createHash } from "node:crypto";

/**
 * Repository and Slack projection scope primitives.
 *
 * These values are deliberately data-only.  They are used both by the
 * read-model and by the Slack projection services so that a state record can
 * never be accidentally reused for another viewer, target, or repository
 * scope.
 */

export type RepositoryScope =
  | { kind: "repo"; repository: string }
  // `repository/fullName` is accepted as a migration-friendly spelling.  New
  // callers should use `repo` and `repository`.
  | { kind: "repository"; fullName: string }
  | { kind: "all-accessible" };

export type ProjectionKind = "list" | "canvas";

export type ProjectionTarget = { kind: "channel"; id: string } | { kind: "user"; id: string };

export interface ProjectionBinding {
  teamId: string;
  viewerId: string | null;
  target: ProjectionTarget;
  kind: ProjectionKind;
  scope: RepositoryScope;
}

export interface NormalizedRepositoryScope {
  kind: "repo" | "all-accessible";
  repository?: string;
}

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const slackChannelPattern = /^[CG][A-Z0-9]+$/;
const slackUserPattern = /^U[A-Z0-9]+$/;

export function repositoryScope(repository: string): RepositoryScope {
  const normalized = repository.trim();
  if (!repositoryPattern.test(normalized)) {
    throw new Error("repository scopeが不正です。owner/repositoryを指定してください。");
  }
  return { kind: "repo", repository: normalized };
}

export function allAccessibleScope(): RepositoryScope {
  return { kind: "all-accessible" };
}

export function normalizeRepositoryScope(scope: RepositoryScope): NormalizedRepositoryScope {
  if (scope.kind === "all-accessible") return { kind: "all-accessible" };
  const repository = scope.kind === "repo" ? scope.repository : scope.fullName;
  if (typeof repository !== "string" || !repositoryPattern.test(repository.trim())) {
    throw new Error("repository scopeが不正です。owner/repositoryを指定してください。");
  }
  return { kind: "repo", repository: repository.trim() };
}

export function repositoryScopeId(scope: RepositoryScope): string {
  const normalized = normalizeRepositoryScope(scope);
  return normalized.kind === "all-accessible" ? "all-accessible" : `repo:${normalized.repository}`;
}

export function projectionTarget(kind: ProjectionTarget["kind"], id: string): ProjectionTarget {
  const normalized = id.trim();
  if (!normalized) throw new Error("Slack投影先IDが空です。");
  if (kind === "channel" && !slackChannelPattern.test(normalized)) {
    throw new Error("Slack channel IDが不正です。");
  }
  if (kind === "user" && !slackUserPattern.test(normalized)) {
    throw new Error("Slack user IDが不正です。");
  }
  return { kind, id: normalized };
}

/** 共有投影は管理者が環境へ固定したchannelと単一repositoryの組だけを許可する。 */
export function assertSharedProjectionBinding(input: {
  channelId: string;
  configuredChannelId: string;
  repository: string;
  configuredRepository: string;
}): void {
  const target = projectionTarget("channel", input.channelId);
  const configuredTarget = projectionTarget("channel", input.configuredChannelId);
  const repository = normalizeRepositoryScope(repositoryScope(input.repository)).repository;
  const configuredRepository = normalizeRepositoryScope(
    repositoryScope(input.configuredRepository),
  ).repository;
  if (target.id !== configuredTarget.id) {
    throw new Error(
      `共有投影先channelは${configuredTarget.id}に固定されています。未登録channelへは公開できません。`,
    );
  }
  if (repository?.toLowerCase() !== configuredRepository?.toLowerCase()) {
    throw new Error(`共有投影できるrepositoryは${configuredRepository}に固定されています。`);
  }
}

/**
 * Validate the privacy boundary before any Slack resource is created.
 *
 * An all-accessible projection is viewer-dependent.  A shared channel cannot
 * express different repository visibility for each member, so it is rejected
 * deterministically.  Such projections must target the requesting user's
 * private resource (a user ACL).
 */
export function validateProjectionBinding(binding: ProjectionBinding): ProjectionBinding {
  const teamId = binding.teamId.trim();
  if (!teamId) throw new Error("Slack team IDが必要です。");
  if (binding.kind !== "list" && binding.kind !== "canvas") {
    throw new Error("投影種別はlistまたはcanvasで指定してください。");
  }
  const target = projectionTarget(binding.target.kind, binding.target.id);
  const scope = normalizeRepositoryScope(binding.scope);
  const viewerId = binding.viewerId?.trim() || null;
  if (scope.kind === "all-accessible") {
    if (target.kind !== "user") {
      throw new Error(
        "all-accessibleの投影を共有channelへ公開できません。個人user ACLを指定してください。",
      );
    }
    if (!viewerId || viewerId !== target.id) {
      throw new Error("all-accessibleの投影には、閲覧者本人と一致するSlack user IDが必要です。");
    }
  }
  return {
    teamId,
    viewerId,
    target,
    kind: binding.kind,
    scope:
      scope.kind === "all-accessible"
        ? { kind: "all-accessible" }
        : { kind: "repo", repository: scope.repository ?? "" },
  };
}

export const assertProjectionBinding = validateProjectionBinding;
export const validateProjectionAudience = validateProjectionBinding;

/**
 * Build a deterministic, bounded state key.  The canonical JSON is hashed so
 * values such as `a/b` and `a|b` can never escape the state-store path or hit
 * its 256-byte filename limit.  The object properties are inserted in a fixed
 * order intentionally; the SHA-256 digest is stable across runtimes.
 */
export function projectionStateKey(binding: ProjectionBinding): string {
  const validated = validateProjectionBinding(binding);
  const scope = normalizeRepositoryScope(validated.scope);
  const canonical = JSON.stringify({
    schemaVersion: 1,
    teamId: validated.teamId,
    viewerId: validated.viewerId,
    target: validated.target,
    kind: validated.kind,
    scope:
      scope.kind === "all-accessible"
        ? { kind: "all-accessible" }
        : { kind: "repo", repository: scope.repository },
  });
  return `v1_${createHash("sha256").update(canonical, "utf8").digest("base64url")}`;
}

export function repositoryFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    const [owner, name] = parsed.pathname.split("/").filter(Boolean);
    if (!owner || !name || !repositoryPattern.test(`${owner}/${name}`)) return null;
    return `${owner}/${name}`;
  } catch {
    return null;
  }
}

export function matchesRepositoryScope(scope: RepositoryScope, repository: string | null): boolean {
  const normalized = normalizeRepositoryScope(scope);
  if (normalized.kind === "all-accessible") return true;
  return Boolean(repository && repository.toLowerCase() === normalized.repository?.toLowerCase());
}

export function itemRepository(item: { url: string; repository?: string | null }): string | null {
  return item.repository?.trim() || repositoryFromUrl(item.url);
}

export function filterItemsByRepositoryScope<T extends { url: string; repository?: string | null }>(
  items: T[],
  scope: RepositoryScope,
): T[] {
  return items.filter((item) => matchesRepositoryScope(scope, itemRepository(item)));
}

export function filterItemsByAccessibleRepositories<
  T extends { url: string; repository?: string | null },
>(items: T[], repositories: readonly string[]): T[] {
  const allowed = new Set(repositories.map((repository) => repository.trim().toLowerCase()));
  return items.filter((item) => {
    const repository = itemRepository(item);
    return repository ? allowed.has(repository.toLowerCase()) : false;
  });
}
