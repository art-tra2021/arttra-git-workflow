import { randomUUID } from "node:crypto";
import {
  createProjectList,
  ensureProjectListDefinition,
  markLegacyProjectList,
  type ProjectListClient,
  type ProjectListState,
  type ProjectListSyncResult,
  type ResolveSlackUserId,
  syncProjectList,
} from "./project-list.ts";
import type { StateStore } from "./state-store.ts";
import type { HumanWorkItem } from "./types.ts";

const STATE_NAMESPACE = "project-list";
const LEASE_NAMESPACE = "project-list-sync";
const LEASE_MILLISECONDS = 15 * 60_000;

interface ProjectListSyncLease {
  schemaVersion: 1;
  revision: number;
  owner: string;
  expiresAt: string;
}

export interface ProjectListWorkSource {
  loadProjectItems(): Promise<HumanWorkItem[]>;
}

export interface ProjectListSyncCommand {
  schemaVersion: 1;
  kind: "project-list.sync";
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

  async sync(channelId: string, requesterUserId?: string): Promise<ProjectListSyncResult> {
    const leaseOwner = await this.acquireLease(channelId);
    try {
      return await this.syncWithLease(channelId, requesterUserId);
    } finally {
      await this.releaseLease(channelId, leaseOwner);
    }
  }

  private async syncWithLease(
    channelId: string,
    requesterUserId?: string,
  ): Promise<ProjectListSyncResult> {
    let state = await this.store.get<ProjectListState>(STATE_NAMESPACE, channelId);
    try {
      if (state?.schemaVersion !== 2) {
        const legacyListId = state?.listId;
        state = await createProjectList(this.client, channelId);
        await this.store.set(STATE_NAMESPACE, channelId, state);
        if (legacyListId) {
          await markLegacyProjectList(this.client, legacyListId);
        }
      } else {
        await this.client.slackLists.access.set({
          list_id: state.listId,
          access_level: "read",
          channel_ids: [channelId],
        });
      }
      if (requesterUserId && state) {
        await this.client.slackLists.access.set({
          list_id: state.listId,
          access_level: "read",
          user_ids: [requesterUserId],
        });
      }
      await ensureProjectListDefinition(this.client, state.listId);
      const items = await this.source.loadProjectItems();
      return await syncProjectList(this.client, state, items, this.resolveSlackUserId);
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

  private async acquireLease(channelId: string): Promise<string> {
    const owner = randomUUID();
    const fresh: ProjectListSyncLease = {
      schemaVersion: 1,
      revision: 1,
      owner,
      expiresAt: new Date(Date.now() + LEASE_MILLISECONDS).toISOString(),
    };
    if (await this.store.create(LEASE_NAMESPACE, channelId, fresh)) {
      return owner;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.store.get<ProjectListSyncLease>(LEASE_NAMESPACE, channelId);
      if (!current || Date.parse(current.expiresAt) > Date.now()) {
        throw new Error(
          "Slack Project Listの同期処理が進行中です。完了後にもう一度実行してください。",
        );
      }
      const next: ProjectListSyncLease = {
        ...fresh,
        revision: current.revision + 1,
      };
      if (await this.store.compareAndSet(LEASE_NAMESPACE, channelId, current.revision, next)) {
        return owner;
      }
    }
    throw new Error("Slack Project Listの同期処理が競合しました。少し待って再実行してください。");
  }

  private async releaseLease(channelId: string, owner: string): Promise<void> {
    const current = await this.store.get<ProjectListSyncLease>(LEASE_NAMESPACE, channelId);
    if (!current || current.owner !== owner) return;
    await this.store.compareAndSet(LEASE_NAMESPACE, channelId, current.revision, {
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
