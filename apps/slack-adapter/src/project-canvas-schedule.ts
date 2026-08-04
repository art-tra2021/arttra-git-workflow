import type { ProjectProjectionResult } from "./app.ts";
import type { CanvasProjectionState, CanvasProjectionStateEntry } from "./canvas-service.ts";
import { CanvasProjectionMissingError } from "./canvas-service.ts";
import { MissingGitHubIdentityError } from "./identity-service.ts";
import {
  type ProjectionBinding,
  projectionStateKey,
  type RepositoryScope,
  validateProjectionBinding,
} from "./project-scope.ts";
import { isRetryableWorkError } from "./retryable-error.ts";

export interface ProjectCanvasSyncCommand {
  schemaVersion: 1;
  kind: "project-canvas.sync";
}

export interface ScheduledCanvasProjectionRequest {
  kind: "canvas";
  scope: RepositoryScope;
  channelId: string;
  slackTeamId: string;
  slackUserId: string;
  createIfMissing: false;
}

export interface ProjectCanvasSyncItemResult {
  stateKey: string;
  canvasId: string | null;
  status: "success" | "unchanged" | "skipped" | "error";
  reasonCode: string;
  retryable: boolean;
  itemCount: number | null;
}

export interface ProjectCanvasSyncBatchResult {
  schemaVersion: 1;
  kind: "project-canvas.sync.result";
  totals: {
    total: number;
    success: number;
    unchanged: number;
    skipped: number;
    error: number;
  };
  results: ProjectCanvasSyncItemResult[];
}

export class ProjectProjectionAccessError extends Error {
  readonly code = "repository_access_lost";

  constructor(message: string) {
    super(message);
    this.name = "ProjectProjectionAccessError";
  }
}

export function parseProjectCanvasSyncCommand(body: string): ProjectCanvasSyncCommand {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("Project Canvas同期commandのJSONを読み取れませんでした。");
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("kind" in value) ||
    value.kind !== "project-canvas.sync"
  ) {
    throw new Error("Project Canvas同期commandが不正です。");
  }
  return { schemaVersion: 1, kind: "project-canvas.sync" };
}

export async function syncExistingPersonalCanvases(
  entries: ReadonlyArray<CanvasProjectionStateEntry>,
  configuredTeamId: string,
  syncProjection: (request: ScheduledCanvasProjectionRequest) => Promise<ProjectProjectionResult>,
): Promise<ProjectCanvasSyncBatchResult> {
  const results: ProjectCanvasSyncItemResult[] = [];
  const sorted = [...entries].sort((left, right) => left.stateKey.localeCompare(right.stateKey));
  for (const entry of sorted) {
    const candidate = personalCanvasCandidate(entry, configuredTeamId);
    if (!candidate.ok) {
      results.push(candidate.result);
      continue;
    }
    try {
      const result = await syncProjection({
        kind: "canvas",
        scope: candidate.state.binding.scope,
        channelId: candidate.state.binding.target.id,
        slackTeamId: candidate.state.binding.teamId,
        slackUserId: candidate.state.binding.target.id,
        createIfMissing: false,
      });
      if (result.kind !== "canvas") {
        throw new Error("Canvas同期経路がCanvas以外の結果を返しました。");
      }
      results.push({
        stateKey: entry.stateKey,
        canvasId: candidate.state.canvasId,
        status: result.unchanged ? "unchanged" : "success",
        reasonCode: result.unchanged ? "content_unchanged" : "canvas_synced",
        retryable: false,
        itemCount: result.itemCount,
      });
    } catch (error) {
      if (
        error instanceof MissingGitHubIdentityError ||
        error instanceof ProjectProjectionAccessError ||
        error instanceof CanvasProjectionMissingError
      ) {
        results.push({
          stateKey: entry.stateKey,
          canvasId: candidate.state.canvasId,
          status: "skipped",
          reasonCode:
            error instanceof MissingGitHubIdentityError
              ? "identity_missing"
              : error instanceof CanvasProjectionMissingError
                ? error.code
                : error.code,
          retryable: false,
          itemCount: null,
        });
        continue;
      }
      results.push({
        stateKey: entry.stateKey,
        canvasId: candidate.state.canvasId,
        status: "error",
        reasonCode: isRetryableWorkError(error) ? error.code : "project_canvas_sync_failed",
        retryable: isRetryableWorkError(error),
        itemCount: null,
      });
    }
  }
  return {
    schemaVersion: 1,
    kind: "project-canvas.sync.result",
    totals: {
      total: results.length,
      success: results.filter((result) => result.status === "success").length,
      unchanged: results.filter((result) => result.status === "unchanged").length,
      skipped: results.filter((result) => result.status === "skipped").length,
      error: results.filter((result) => result.status === "error").length,
    },
    results,
  };
}

function personalCanvasCandidate(
  entry: CanvasProjectionStateEntry,
  configuredTeamId: string,
): { ok: true; state: CanvasProjectionState } | { ok: false; result: ProjectCanvasSyncItemResult } {
  const state = entry.state as CanvasProjectionState | undefined;
  const canvasId = typeof state?.canvasId === "string" ? state.canvasId : null;
  const skipped = (reasonCode: string): { ok: false; result: ProjectCanvasSyncItemResult } => ({
    ok: false,
    result: {
      stateKey: entry.stateKey,
      canvasId,
      status: "skipped",
      reasonCode,
      retryable: false,
      itemCount: null,
    },
  });
  if (state?.schemaVersion !== 1 || !state.binding || !canvasId) {
    return skipped("invalid_canvas_state");
  }
  let binding: ProjectionBinding;
  try {
    binding = validateProjectionBinding(state.binding);
  } catch {
    return skipped("invalid_canvas_binding");
  }
  if (binding.kind !== "canvas") return skipped("not_canvas_binding");
  if (
    binding.target.kind !== "user" ||
    !binding.viewerId ||
    binding.viewerId !== binding.target.id
  ) {
    return skipped("not_personal_user_binding");
  }
  if (binding.teamId !== configuredTeamId) return skipped("foreign_team_binding");
  if (state.stateKey !== entry.stateKey || projectionStateKey(binding) !== entry.stateKey) {
    return skipped("canvas_state_key_mismatch");
  }
  return { ok: true, state: { ...state, binding } };
}
