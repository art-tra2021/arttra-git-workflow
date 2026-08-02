import { randomUUID } from "node:crypto";
import {
  clearProjectListItems,
  createProjectList,
  markLegacyProjectList,
  type ProjectListClient,
  type ProjectListCreatedHook,
  type ProjectListProjectionOptions,
  type ProjectListState,
  type ProjectListSyncResult,
  type ResolveSlackUserId,
  syncProjectList,
} from "./project-list.ts";
import {
  filterItemsByAccessibleRepositories,
  normalizeRepositoryScope,
  projectionStateKey,
} from "./project-scope.ts";
import { RetryableWorkError } from "./retryable-error.ts";
import type { StateStore } from "./state-store.ts";
import type { HumanWorkItem } from "./types.ts";

const STATE_NAMESPACE = "project-list";
const LEGACY_GUARD_NAMESPACE = "project-list-legacy-guard";
const LEASE_NAMESPACE = "project-list-sync";
const LEASE_MILLISECONDS = 15 * 60_000;

interface ProjectListSyncLease {
  schemaVersion: 1;
  revision: number;
  owner: string;
  expiresAt: string;
}

interface ProjectListLegacyGuard {
  schemaVersion: 1;
  kind: "scoped-only";
  channelId: string;
  createdAt: string;
}

export interface ProjectListWorkSource {
  loadProjectItems(): Promise<HumanWorkItem[]>;
}

export interface ProjectListSyncCommand {
  schemaVersion: 1;
  kind: "project-list.sync";
}

export interface ProjectListSyncOptions {
  teamId: string;
  viewerId?: string | null;
  scope: ProjectListProjectionOptions["scope"];
  /** viewerのGitHub権限で確認済みのrepository集合。指定時は必ずintersectionを取る。 */
  accessibleRepositories?: string[];
  /** Explicit target is useful for a private user List; channel is the default. */
  target?: ProjectListProjectionOptions["target"];
}

export function parseProjectListSyncCommand(body: string): ProjectListSyncCommand {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("Project List同期commandのJSONを読み取れませんでした。");
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("kind" in value) ||
    value.kind !== "project-list.sync"
  ) {
    throw new Error("Project List同期commandが不正です。");
  }
  return { schemaVersion: 1, kind: "project-list.sync" };
}

export class ProjectListSyncService {
  private readonly client: ProjectListClient;
  private readonly source: ProjectListWorkSource;
  private readonly store: StateStore;
  private readonly resolveSlackUserId: ResolveSlackUserId;

  constructor(
    client: ProjectListClient,
    source: ProjectListWorkSource,
    store: StateStore,
    resolveSlackUserId: ResolveSlackUserId = async () => null,
  ) {
    this.client = client;
    this.source = source;
    this.store = store;
    this.resolveSlackUserId = resolveSlackUserId;
  }

  async revokeViewerAccess(teamId: string, viewerId: string): Promise<number> {
    if (!this.client.slackLists.access.delete) {
      throw new Error("Slack Listのaccess.deleteが利用できません。");
    }
    const states = await this.store.list<ProjectListState>(STATE_NAMESPACE);
    const targets = states.filter(
      (state) =>
        state.binding?.teamId === teamId &&
        state.binding.viewerId === viewerId &&
        state.binding.target.kind === "user" &&
        state.binding.target.id === viewerId &&
        state.stateKey,
    );
    for (const state of targets) {
      await this.client.slackLists.access.delete({ list_id: state.listId, user_ids: [viewerId] });
      if (state.stateKey) await this.store.remove(STATE_NAMESPACE, state.stateKey);
    }
    return targets.length;
  }

  async sync(
    channelId: string,
    requesterUserId?: string,
    options?: ProjectListSyncOptions,
  ): Promise<ProjectListSyncResult> {
    if (options && options.accessibleRepositories === undefined) {
      throw new Error(
        `${normalizeRepositoryScope(options.scope).kind}投影にはGitHubで確認済みのrepository集合が必要です。`,
      );
    }
    const stateKey = options
      ? projectionStateKey({
          teamId: options.teamId,
          viewerId: options.viewerId ?? requesterUserId ?? null,
          target: options.target ?? { kind: "channel", id: channelId },
          kind: "list",
          scope: options.scope,
        })
      : channelId;
    const leaseOwner = await this.acquireLease(stateKey);
    try {
      return await this.syncWithLease(channelId, requesterUserId, options, stateKey);
    } finally {
      await this.releaseLease(stateKey, leaseOwner);
    }
  }

  private async syncWithLease(
    channelId: string,
    requesterUserId?: string,
    options?: ProjectListSyncOptions,
    stateKey = channelId,
  ): Promise<ProjectListSyncResult> {
    // This check intentionally runs after the channel lease was acquired by
    // sync(). A stale unscoped retry must not pass a check performed before a
    // concurrent scoped migration writes its durable guard.
    if (!options) await this.assertUnscopedProjectionAllowed(channelId);
    await this.migrateLegacyChannelProjection(channelId, options, stateKey);
    let state = await this.store.get<ProjectListState>(STATE_NAMESPACE, stateKey);
    try {
      let created = false;
      if (state?.schemaVersion !== 3) {
        const legacyListId = state?.listId;
        const createOptions: ProjectListProjectionOptions | undefined = options
          ? {
              teamId: options.teamId,
              scope: options.scope,
              ...(options.viewerId !== undefined ? { viewerId: options.viewerId } : {}),
              ...(options.target ? { target: options.target } : {}),
            }
          : undefined;
        const persistCreated: ProjectListCreatedHook = async (createdState) => {
          state = {
            ...createdState,
            accessPending: true,
            ...(legacyListId ? { pendingLegacyListId: legacyListId } : {}),
          };
          await this.store.set(STATE_NAMESPACE, stateKey, state);
        };
        state = await createProjectList(
          this.client,
          channelId,
          requesterUserId,
          createOptions,
          persistCreated,
        );
        created = true;
        state = {
          ...state,
          ...(legacyListId ? { pendingLegacyListId: legacyListId } : {}),
        };
        await this.store.set(STATE_NAMESPACE, stateKey, state);
      }
      // A previous attempt may have persisted the newly-created List before its
      // ACL succeeded. Retry that ACL before loading or mutating rows.
      if (!created && state?.accessPending) {
        const target = state.binding?.target ?? { kind: "channel" as const, id: channelId };
        await this.client.slackLists.access.set({
          list_id: state.listId,
          access_level: "read",
          ...(target.kind === "user" ? { user_ids: [target.id] } : { channel_ids: [target.id] }),
        });
        state = { ...state, accessPending: false };
        await this.store.set(STATE_NAMESPACE, stateKey, state);
      }
      if (
        requesterUserId &&
        state &&
        (state.binding?.target.kind !== "user" || state.binding?.target.id !== requesterUserId)
      ) {
        await this.client.slackLists.access.set({
          list_id: state.listId,
          access_level: "read",
          user_ids: [requesterUserId],
        });
      }
      if (state?.pendingLegacyListId) {
        await markLegacyProjectList(this.client, state.pendingLegacyListId);
        const { pendingLegacyListId: _pendingLegacyListId, ...completedState } = state;
        state = completedState;
        await this.store.set(STATE_NAMESPACE, stateKey, state);
      }
      const loadedItems = await this.source.loadProjectItems();
      const items = options
        ? filterItemsByAccessibleRepositories(loadedItems, options.accessibleRepositories ?? [])
        : loadedItems;
      return await syncProjectList(
        this.client,
        state,
        items,
        this.resolveSlackUserId,
        options?.scope ?? state.binding?.scope,
      );
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === "missing_scope") {
        throw new Error(
          "Slack AppにList同期権限がありません。lists:readとlists:writeを追加してAppを再インストールしてください。",
        );
      }
      if (code === "not_in_channel" || code === "no_permission") {
        throw new Error(
          "ART-TRA Work Labが対象チャンネルに参加していません。Slackで `/invite @ART-TRA Work Lab` を実行してください。",
        );
      }
      if (code === "lists_disabled_user_team") {
        throw new Error(
          "このSlackワークスペースではListsを利用できません。契約プランを確認してください。",
        );
      }
      throw error;
    }
  }

  /**
   * scope導入前のstate keyはchannel IDそのものだった。
   * そのListへ全repositoryの行が残ったまま新しい投影だけを作ると情報漏えいになるため、
   * channel ACLを先に外し、行を空にして旧表示として残す。
   */
  private async migrateLegacyChannelProjection(
    channelId: string,
    options: ProjectListSyncOptions | undefined,
    scopedStateKey: string,
  ): Promise<void> {
    const target = options?.target ?? { kind: "channel" as const, id: channelId };
    if (!options || target.kind !== "channel" || scopedStateKey === channelId) return;

    // Keep the channel lease across the complete migration and marker write.
    // This serializes the marker with any unscoped retry that could otherwise
    // recreate the old all-repository List after this scoped sync succeeds.
    const owner = await this.acquireLease(channelId);
    try {
      await this.migrateLegacyChannelStateWithLease(channelId);
    } finally {
      await this.releaseLease(channelId, owner);
    }
  }

  async migrateLegacyChannelState(channelId: string): Promise<void> {
    const owner = await this.acquireLease(channelId);
    try {
      await this.migrateLegacyChannelStateWithLease(channelId);
    } finally {
      await this.releaseLease(channelId, owner);
    }
  }

  private async migrateLegacyChannelStateWithLease(channelId: string): Promise<void> {
    const legacy = await this.store.get<Pick<ProjectListState, "listId" | "pendingLegacyListId">>(
      STATE_NAMESPACE,
      channelId,
    );
    if (!legacy) {
      await this.ensureScopedOnlyGuard(channelId);
      return;
    }

    // A scoped sync may race with the first unscoped sync after the latter
    // has already created FNEW but before its ACL is confirmed. In that
    // case the channel state contains both the old shared List (FOLD) and
    // the provisional replacement (FNEW). Remove the old List first so a
    // potentially confidential row set cannot remain visible while the
    // migration is retried.
    const listIds = [legacy.pendingLegacyListId, legacy.listId].filter(
      (listId, index, ids): listId is string => Boolean(listId) && ids.indexOf(listId) === index,
    );
    if (listIds.length === 0 || listIds.some((listId) => !/^F[A-Z0-9]+$/.test(listId))) {
      throw new Error("旧Slack Listの保存状態が不正です。安全のため共有投影を停止しました。");
    }
    if (!this.client.slackLists.access.delete) {
      throw new Error("旧Slack Listを安全に移行するためのaccess.deleteが利用できません。");
    }

    // Keep the state until every List is ACL-revoked, emptied, and marked.
    // Any failure therefore leaves the IDs available for a safe retry.
    for (const listId of listIds) {
      await this.client.slackLists.access.delete({ list_id: listId, channel_ids: [channelId] });
      await clearProjectListItems(this.client, listId);
      await markLegacyProjectList(this.client, listId);
    }
    await this.ensureScopedOnlyGuard(channelId);
    await this.store.remove(STATE_NAMESPACE, channelId);
  }

  private async ensureScopedOnlyGuard(channelId: string): Promise<void> {
    const marker = await this.store.get<ProjectListLegacyGuard>(LEGACY_GUARD_NAMESPACE, channelId);
    if (marker !== null) {
      if (!this.isValidScopedOnlyGuard(marker, channelId)) {
        throw new Error(
          "Project Listの移行保護状態が不正です。安全のため全repository同期を停止しました。",
        );
      }
      return;
    }
    await this.store.set<ProjectListLegacyGuard>(LEGACY_GUARD_NAMESPACE, channelId, {
      schemaVersion: 1,
      kind: "scoped-only",
      channelId,
      createdAt: new Date().toISOString(),
    });
  }

  private async assertUnscopedProjectionAllowed(channelId: string): Promise<void> {
    const marker = await this.store.get<ProjectListLegacyGuard>(LEGACY_GUARD_NAMESPACE, channelId);
    if (marker === null) return;
    if (!this.isValidScopedOnlyGuard(marker, channelId)) {
      throw new Error(
        "Project Listの移行保護状態が不正です。安全のため全repository同期を停止しました。",
      );
    }
    throw new Error(
      "このチャンネルはrepository限定のProject Listへ移行済みです。scope付き同期を実行してください。",
    );
  }

  private isValidScopedOnlyGuard(
    marker: unknown,
    channelId: string,
  ): marker is ProjectListLegacyGuard {
    if (!marker || typeof marker !== "object") return false;
    const candidate = marker as Partial<ProjectListLegacyGuard>;
    return (
      candidate.schemaVersion === 1 &&
      candidate.kind === "scoped-only" &&
      candidate.channelId === channelId &&
      typeof candidate.createdAt === "string" &&
      candidate.createdAt.length > 0
    );
  }

  private async acquireLease(stateKey: string): Promise<string> {
    const owner = randomUUID();
    const fresh: ProjectListSyncLease = {
      schemaVersion: 1,
      revision: 1,
      owner,
      expiresAt: new Date(Date.now() + LEASE_MILLISECONDS).toISOString(),
    };
    if (await this.store.create(LEASE_NAMESPACE, stateKey, fresh)) {
      return owner;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.store.get<ProjectListSyncLease>(LEASE_NAMESPACE, stateKey);
      if (!current || Date.parse(current.expiresAt) > Date.now()) {
        throw new RetryableWorkError(
          "project_list_sync_in_progress",
          "Slack Project Listの同期処理が進行中です。完了後にもう一度実行してください。",
        );
      }
      const next: ProjectListSyncLease = {
        ...fresh,
        revision: current.revision + 1,
      };
      if (await this.store.compareAndSet(LEASE_NAMESPACE, stateKey, current.revision, next)) {
        return owner;
      }
    }
    throw new RetryableWorkError(
      "project_list_sync_conflict",
      "Slack Project Listの同期処理が競合しました。少し待って再実行してください。",
    );
  }

  private async releaseLease(stateKey: string, owner: string): Promise<void> {
    const current = await this.store.get<ProjectListSyncLease>(LEASE_NAMESPACE, stateKey);
    if (!current || current.owner !== owner) return;
    await this.store.compareAndSet(LEASE_NAMESPACE, stateKey, current.revision, {
      ...current,
      revision: current.revision + 1,
      expiresAt: new Date(0).toISOString(),
    });
  }
}

function slackErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("data" in error)) return undefined;
  const data = error.data;
  if (!data || typeof data !== "object" || !("error" in data)) return undefined;
  return typeof data.error === "string" ? data.error : undefined;
}
