import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CanvasClient,
  CanvasProjectionService,
  type CanvasProjectionState,
  type CanvasProjectionStateEntry,
} from "../src/canvas-service.ts";
import {
  ProjectProjectionAccessError,
  parseProjectCanvasSyncCommand,
  syncExistingPersonalCanvases,
} from "../src/project-canvas-schedule.ts";
import {
  allAccessibleScope,
  type ProjectionBinding,
  projectionStateKey,
  repositoryScope,
} from "../src/project-scope.ts";
import { RetryableWorkError } from "../src/retryable-error.ts";
import { LocalStateStore } from "../src/state-store.ts";
import type { HumanWorkItem } from "../src/types.ts";

describe("scheduled Project Canvas sync", () => {
  test("version付きcommandだけを受け入れる", () => {
    expect(
      parseProjectCanvasSyncCommand('{"schemaVersion":1,"kind":"project-canvas.sync"}'),
    ).toEqual({ schemaVersion: 1, kind: "project-canvas.sync" });
    expect(() => parseProjectCanvasSyncCommand("not-json")).toThrow("JSON");
    expect(() =>
      parseProjectCanvasSyncCommand('{"schemaVersion":2,"kind":"project-canvas.sync"}'),
    ).toThrow("不正");
  });

  test("personal user bindingだけをstate key順に同期して結果を決定的に返す", async () => {
    const personalZ = entry(userBinding("T123", "U999", allAccessibleScope()), "F_Z");
    const personalA = entry(userBinding("T123", "U123", allAccessibleScope()), "F_A");
    const channel = entry(
      {
        teamId: "T123",
        viewerId: null,
        target: { kind: "channel", id: "C123" },
        kind: "canvas",
        scope: repositoryScope("art-tra2021/work"),
      },
      "F_CHANNEL",
    );
    const foreign = entry(userBinding("T999", "U456", allAccessibleScope()), "F_FOREIGN");
    const calls: string[] = [];

    const result = await syncExistingPersonalCanvases(
      [personalZ, channel, foreign, personalA],
      "T123",
      async (request) => {
        calls.push(request.slackUserId);
        expect(request.createIfMissing).toBe(false);
        return {
          kind: "canvas",
          resourceId: request.slackUserId === "U123" ? "F_A" : "F_Z",
          itemCount: 2,
          created: 0,
          updated: request.slackUserId === "U123" ? 0 : 1,
          deleted: 0,
          unchanged: request.slackUserId === "U123",
        };
      },
    );

    expect(calls).toEqual(
      [personalA, personalZ]
        .sort((left, right) => left.stateKey.localeCompare(right.stateKey))
        .map((candidate) => candidate.state.binding.target.id),
    );
    expect(
      result.results.map(({ stateKey, status, reasonCode }) => ({ stateKey, status, reasonCode })),
    ).toEqual(
      [...result.results]
        .sort((left, right) => left.stateKey.localeCompare(right.stateKey))
        .map(({ stateKey, status, reasonCode }) => ({ stateKey, status, reasonCode })),
    );
    expect(result.totals).toEqual({ total: 4, success: 1, unchanged: 1, skipped: 2, error: 0 });
    expect(result.results.find((item) => item.canvasId === "F_CHANNEL")).toMatchObject({
      status: "skipped",
      reasonCode: "not_personal_user_binding",
    });
    expect(result.results.find((item) => item.canvasId === "F_FOREIGN")).toMatchObject({
      status: "skipped",
      reasonCode: "foreign_team_binding",
    });
  });

  test("access喪失はskipped、lease競合はretryable errorとして区別する", async () => {
    const accessLost = entry(userBinding("T123", "U123", allAccessibleScope()), "F_ACCESS");
    const retryable = entry(userBinding("T123", "U456", allAccessibleScope()), "F_RETRY");
    const result = await syncExistingPersonalCanvases(
      [retryable, accessLost],
      "T123",
      async (request) => {
        if (request.slackUserId === "U123") {
          throw new ProjectProjectionAccessError("repository accessを失いました");
        }
        throw new RetryableWorkError("project_canvas_sync_in_progress", "同期中です");
      },
    );

    expect(result.results.find((item) => item.canvasId === "F_ACCESS")).toMatchObject({
      status: "skipped",
      reasonCode: "repository_access_lost",
      retryable: false,
    });
    expect(result.results.find((item) => item.canvasId === "F_RETRY")).toMatchObject({
      status: "error",
      reasonCode: "project_canvas_sync_in_progress",
      retryable: true,
    });
    expect(result.totals).toEqual({ total: 2, success: 0, unchanged: 0, skipped: 1, error: 1 });
  });

  test("既存Canvasの同一内容はcreate/edit/access.setを再実行しない", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-canvas-schedule-")));
    let createCount = 0;
    let editCount = 0;
    let accessCount = 0;
    const client: CanvasClient = {
      canvases: {
        create: async () => {
          createCount += 1;
          return { canvas_id: "F_EXISTING" };
        },
        edit: async () => {
          editCount += 1;
        },
        access: {
          set: async () => {
            accessCount += 1;
          },
        },
      },
    };
    const service = new CanvasProjectionService(client, store);
    const items = [item("https://github.com/art-tra2021/work/issues/1")];
    await service.sync({
      teamId: "T123",
      viewerId: "U123",
      target: { kind: "user", id: "U123" },
      scope: allAccessibleScope(),
      accessibleRepositories: ["art-tra2021/work"],
      items,
    });

    const result = await syncExistingPersonalCanvases(
      await service.listExistingStates(),
      "T123",
      async (request) => {
        const synced = await service.sync({
          teamId: request.slackTeamId,
          viewerId: request.slackUserId,
          target: { kind: "user", id: request.slackUserId },
          scope: request.scope,
          accessibleRepositories: ["art-tra2021/work"],
          items,
          createIfMissing: request.createIfMissing,
        });
        return {
          kind: "canvas",
          resourceId: synced.canvasId,
          itemCount: synced.itemCount,
          created: synced.created ? 1 : 0,
          updated: synced.updated ? 1 : 0,
          deleted: 0,
          unchanged: synced.unchanged,
        };
      },
    );

    expect(result.totals).toEqual({ total: 1, success: 0, unchanged: 1, skipped: 0, error: 0 });
    expect(createCount).toBe(1);
    expect(editCount).toBe(0);
    expect(accessCount).toBe(1);
  });

  test("列挙後にstateが消えても新しいCanvasを作らずskippedにする", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-canvas-race-")));
    let createCount = 0;
    const service = new CanvasProjectionService(
      {
        canvases: {
          create: async () => {
            createCount += 1;
            return { canvas_id: `F_${createCount}` };
          },
          edit: async () => {},
          access: { set: async () => {} },
        },
      },
      store,
    );
    const input = {
      teamId: "T123",
      viewerId: "U123",
      target: { kind: "user" as const, id: "U123" },
      scope: allAccessibleScope(),
      accessibleRepositories: ["art-tra2021/work"],
      items: [item("https://github.com/art-tra2021/work/issues/1")],
    };
    const first = await service.sync(input);
    const entries = await service.listExistingStates();
    await store.remove("project-canvas", first.stateKey);

    const result = await syncExistingPersonalCanvases(entries, "T123", async (request) => {
      const synced = await service.sync({ ...input, createIfMissing: request.createIfMissing });
      return {
        kind: "canvas",
        resourceId: synced.canvasId,
        itemCount: synced.itemCount,
        created: synced.created ? 1 : 0,
        updated: synced.updated ? 1 : 0,
        deleted: 0,
        unchanged: synced.unchanged,
      };
    });

    expect(result.results[0]).toMatchObject({
      canvasId: "F_1",
      status: "skipped",
      reasonCode: "canvas_projection_missing",
    });
    expect(createCount).toBe(1);
  });
});

function userBinding(
  teamId: string,
  viewerId: string,
  scope: ProjectionBinding["scope"],
): ProjectionBinding {
  return {
    teamId,
    viewerId,
    target: { kind: "user", id: viewerId },
    kind: "canvas",
    scope,
  };
}

function entry(binding: ProjectionBinding, canvasId: string): CanvasProjectionStateEntry {
  const stateKey = projectionStateKey(binding);
  const state: CanvasProjectionState = {
    schemaVersion: 1,
    canvasId,
    contentHash: "hash",
    title: "ART-TRA Work",
    accessKey: JSON.stringify({ target: binding.target, accessLevel: "read" }),
    binding,
    stateKey,
  };
  return { stateKey, state };
}

function item(url: string): HumanWorkItem {
  return {
    schemaVersion: 1,
    issueNumber: 1,
    title: "作業項目",
    url,
    status: "in-progress",
    priority: "P2",
    owner: "rozwer",
    targetDate: null,
    delivery: "digest",
    reasonCode: "ACTIVE_WORK",
    nextActor: "rozwer",
    nextAction: "着手する",
    reason: "日次一覧で確認する",
    actions: ["open-github"],
  };
}
