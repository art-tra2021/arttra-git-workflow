import { createHash, randomUUID } from "node:crypto";
import {
  filterItemsByAccessibleRepositories,
  filterItemsByRepositoryScope,
  normalizeRepositoryScope,
  type ProjectionBinding,
  type ProjectionTarget,
  projectionStateKey,
  type RepositoryScope,
  validateProjectionBinding,
} from "./project-scope.ts";
import { RetryableWorkError } from "./retryable-error.ts";
import type { StateStore } from "./state-store.ts";
import type { HumanWorkItem } from "./types.ts";

const STATE_NAMESPACE = "project-canvas";
const LEASE_NAMESPACE = "project-canvas-sync";
const LEASE_MILLISECONDS = 15 * 60_000;

interface CanvasProjectionLease {
  schemaVersion: 1;
  revision: number;
  owner: string;
  expiresAt: string;
}

export interface CanvasDocumentContent {
  type: "markdown";
  markdown: string;
}

export interface CanvasClient {
  canvases: {
    create(input: {
      title?: string;
      document_content: CanvasDocumentContent;
      channel_id?: string;
    }): Promise<{ canvas_id?: string | null }>;
    edit(input: {
      canvas_id: string;
      changes: Array<{
        operation: "replace" | "rename";
        document_content?: CanvasDocumentContent;
        title_content?: CanvasDocumentContent;
      }>;
    }): Promise<unknown>;
    access: {
      delete?(input: {
        canvas_id: string;
        channel_ids?: string[];
        user_ids?: string[];
      }): Promise<unknown>;
      set(input: {
        canvas_id: string;
        access_level: "read" | "write";
        channel_ids?: [string, ...string[]];
        user_ids?: [string, ...string[]];
      }): Promise<unknown>;
    };
  };
}

export interface CanvasProjectionInput {
  teamId: string;
  viewerId: string | null;
  target: ProjectionTarget;
  scope: RepositoryScope;
  items: HumanWorkItem[];
  /** viewerのGitHub権限で確認済みのrepository集合。 */
  accessibleRepositories?: string[];
  title?: string;
  /** Existing ID can be supplied when adopting a manually-created Canvas. */
  canvasId?: string;
  /** 定期同期ではfalseにし、state消失時の新規Canvas作成を禁止する。 */
  createIfMissing?: boolean;
}

export interface CanvasProjectionState {
  schemaVersion: 1;
  canvasId: string;
  contentHash: string;
  title: string;
  accessKey: string;
  binding: ProjectionBinding;
  stateKey: string;
}

export interface CanvasProjectionStateEntry {
  stateKey: string;
  state: CanvasProjectionState;
}

export class CanvasProjectionMissingError extends Error {
  readonly code = "canvas_projection_missing";

  constructor() {
    super("既存のSlack Canvas stateが見つからないため、定期同期では新規作成しません。");
    this.name = "CanvasProjectionMissingError";
  }
}

export interface CanvasProjectionResult {
  canvasId: string;
  stateKey: string;
  itemCount: number;
  created: boolean;
  updated: boolean;
  unchanged: boolean;
  accessUpdated: boolean;
  contentHash: string;
}

/**
 * Idempotently project GitHub work items into a Slack Canvas.
 *
 * Content is compared by a stable SHA-256 hash before calling canvases.edit.
 * This prevents a periodic webhook/schedule from rewriting an unchanged
 * Canvas and consequently avoids noisy Slack notifications/history entries.
 */
export class CanvasProjectionService {
  private readonly client: CanvasClient;
  private readonly store: StateStore;

  constructor(client: CanvasClient, store: StateStore) {
    this.client = client;
    this.store = store;
  }

  /** 保存済みstateを変更せず、state storeのkey順に列挙する。 */
  async listExistingStates(): Promise<ReadonlyArray<CanvasProjectionStateEntry>> {
    const entries = await this.store.listEntries<CanvasProjectionState>(STATE_NAMESPACE);
    return entries
      .map((entry) => ({ stateKey: entry.key, state: entry.value }))
      .sort((left, right) => left.stateKey.localeCompare(right.stateKey));
  }

  async revokeViewerAccess(teamId: string, viewerId: string): Promise<number> {
    if (!this.client.canvases.access.delete) {
      throw new Error("Slack Canvasのaccess.deleteが利用できません。");
    }
    const states = await this.store.list<CanvasProjectionState>(STATE_NAMESPACE);
    const targets = states.filter(
      (state) =>
        state.binding.teamId === teamId &&
        state.binding.viewerId === viewerId &&
        state.binding.target.kind === "user" &&
        state.binding.target.id === viewerId,
    );
    for (const state of targets) {
      await this.client.canvases.access.delete({
        canvas_id: state.canvasId,
        user_ids: [viewerId],
      });
      await this.store.remove(STATE_NAMESPACE, state.stateKey);
    }
    return targets.length;
  }

  async sync(input: CanvasProjectionInput): Promise<CanvasProjectionResult> {
    const binding = validateProjectionBinding({
      teamId: input.teamId,
      viewerId: input.viewerId,
      target: input.target,
      kind: "canvas",
      scope: input.scope,
    });
    if (input.accessibleRepositories === undefined) {
      throw new Error(
        `${normalizeRepositoryScope(binding.scope).kind}投影にはGitHubで確認済みのrepository集合が必要です。`,
      );
    }
    const stateKey = projectionStateKey(binding);
    const leaseOwner = await this.acquireLease(stateKey);
    try {
      return await this.syncWithLease(input, binding, stateKey);
    } finally {
      await this.releaseLease(stateKey, leaseOwner);
    }
  }

  private async syncWithLease(
    input: CanvasProjectionInput,
    binding: ProjectionBinding,
    stateKey: string,
  ): Promise<CanvasProjectionResult> {
    const title = input.title?.trim() || defaultCanvasTitle(binding);
    const items = filterItemsByRepositoryScope(
      filterItemsByAccessibleRepositories(input.items, input.accessibleRepositories ?? []),
      binding.scope,
    ).filter((item) => item.delivery !== "silent");
    const markdown = canvasMarkdown(items, binding.scope);
    const contentHash = hash(markdown);
    const accessKey = JSON.stringify({ target: binding.target, accessLevel: "read" });
    let state = await this.store.get<CanvasProjectionState>(STATE_NAMESPACE, stateKey);
    let canvasId = state?.canvasId ?? input.canvasId;
    let created = false;
    let updated = false;
    let unchanged = false;

    if (!canvasId) {
      if (input.createIfMissing === false) {
        throw new CanvasProjectionMissingError();
      }
      const response = await this.client.canvases.create({
        title,
        document_content: { type: "markdown", markdown },
        ...(binding.target.kind === "channel" ? { channel_id: binding.target.id } : {}),
      });
      canvasId = response.canvas_id ?? undefined;
      if (!canvasId || !/^[A-Za-z0-9:_-]+$/.test(canvasId)) {
        throw new Error("Slack Canvasの作成結果に有効なcanvas_idがありません。");
      }
      created = true;
      // Canvas作成後のACL設定が一時失敗しても、再試行時に別Canvasを増やさない。
      // accessKeyを空にした暫定stateを先に保存し、次回必ずaccess.setだけを再実行する。
      state = {
        schemaVersion: 1,
        canvasId,
        contentHash,
        title,
        accessKey: "",
        binding,
        stateKey,
      };
      await this.store.set(STATE_NAMESPACE, stateKey, state);
    } else {
      if (!state || state.contentHash !== contentHash || state.title !== title) {
        if (!state || state.contentHash !== contentHash) {
          await this.client.canvases.edit({
            canvas_id: canvasId,
            changes: [
              {
                operation: "replace",
                document_content: { type: "markdown", markdown },
              },
            ],
          });
        }
        if (state && state.title !== title) {
          await this.client.canvases.edit({
            canvas_id: canvasId,
            changes: [
              {
                operation: "rename",
                title_content: { type: "markdown", markdown: title },
              },
            ],
          });
        }
        updated = true;
      } else {
        unchanged = true;
      }
    }

    const accessUpdated = !state || state.accessKey !== accessKey;
    if (accessUpdated) {
      await this.client.canvases.access.set({
        canvas_id: canvasId,
        access_level: "read",
        ...(binding.target.kind === "channel"
          ? { channel_ids: [binding.target.id] }
          : { user_ids: [binding.target.id] }),
      });
    }

    state = {
      schemaVersion: 1,
      canvasId,
      contentHash,
      title,
      accessKey,
      binding,
      stateKey,
    };
    await this.store.set(STATE_NAMESPACE, stateKey, state);
    return {
      canvasId,
      stateKey,
      itemCount: items.length,
      created,
      updated,
      unchanged,
      accessUpdated,
      contentHash,
    };
  }

  private async acquireLease(stateKey: string): Promise<string> {
    const owner = randomUUID();
    const fresh: CanvasProjectionLease = {
      schemaVersion: 1,
      revision: 1,
      owner,
      expiresAt: new Date(Date.now() + LEASE_MILLISECONDS).toISOString(),
    };
    if (await this.store.create(LEASE_NAMESPACE, stateKey, fresh)) return owner;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.store.get<CanvasProjectionLease>(LEASE_NAMESPACE, stateKey);
      if (!current || Date.parse(current.expiresAt) > Date.now()) {
        throw new RetryableWorkError(
          "project_canvas_sync_in_progress",
          "Slack Canvasの同期処理が進行中です。完了後にもう一度実行してください。",
        );
      }
      const next = { ...fresh, revision: current.revision + 1 };
      if (await this.store.compareAndSet(LEASE_NAMESPACE, stateKey, current.revision, next)) {
        return owner;
      }
    }
    throw new RetryableWorkError(
      "project_canvas_sync_conflict",
      "Slack Canvasの同期処理が競合しました。少し待って再実行してください。",
    );
  }

  private async releaseLease(stateKey: string, owner: string): Promise<void> {
    const current = await this.store.get<CanvasProjectionLease>(LEASE_NAMESPACE, stateKey);
    if (!current || current.owner !== owner) return;
    await this.store.compareAndSet(LEASE_NAMESPACE, stateKey, current.revision, {
      ...current,
      revision: current.revision + 1,
      expiresAt: new Date(0).toISOString(),
    });
  }
}

export async function syncCanvasProjection(
  client: CanvasClient,
  store: StateStore,
  input: CanvasProjectionInput,
): Promise<CanvasProjectionResult> {
  return new CanvasProjectionService(client, store).sync(input);
}

export function canvasMarkdown(items: HumanWorkItem[], scope?: RepositoryScope): string {
  const sorted = [...items].sort((left, right) =>
    `${left.url}\u0000${left.issueNumber}`.localeCompare(`${right.url}\u0000${right.issueNumber}`),
  );
  const scopeLabel = scope ? scopeLabelForMarkdown(scope) : "指定範囲";
  const lines = [
    "# ART-TRA Work",
    "",
    `> GitHub Projectsの閲覧用投影（${scopeLabel}）です。更新はGitHubで行います。`,
    "",
    "| 状態 | 優先度 | 期限 | Issue | 担当 |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const item of sorted) {
    const repository = repositoryLabel(item.url);
    const due = item.targetDate ?? "—";
    const owner = item.owner ? `@${item.owner}` : "未定";
    const title = escapeMarkdown(item.title);
    lines.push(
      `| ${item.status} | ${item.priority} | ${due} | [${repository}#${item.issueNumber} ${title}](${item.url}) | ${owner} |`,
    );
  }
  if (sorted.length === 0) lines.push("| — | — | — | 対象の未完了Issueはありません | — |");
  return `${lines.join("\n")}\n`;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function defaultCanvasTitle(binding: ProjectionBinding): string {
  if (binding.scope.kind === "all-accessible") return "ART-TRA Work（アクセス可能な全リポ）";
  const repository =
    binding.scope.kind === "repo" ? binding.scope.repository : binding.scope.fullName;
  return `ART-TRA Work（${repository}）`;
}

function scopeLabelForMarkdown(scope: RepositoryScope): string {
  if (scope.kind === "all-accessible") return "自分がアクセスできるrepository";
  return scope.kind === "repo" ? scope.repository : scope.fullName;
}

function repositoryLabel(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : "repository";
  } catch {
    return "repository";
  }
}

function escapeMarkdown(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("[", "［")
    .replaceAll("]", "］")
    .replaceAll("(", "（")
    .replaceAll(")", "）")
    .replaceAll("\n", " ");
}
