import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CanvasClient,
  CanvasProjectionService,
  type CanvasProjectionState,
  canvasMarkdown,
} from "../src/canvas-service.ts";
import { allAccessibleScope, repositoryScope } from "../src/project-scope.ts";
import { LocalStateStore } from "../src/state-store.ts";
import type { HumanWorkItem } from "../src/types.ts";

describe("Slack Canvas projection", () => {
  test("作成・user ACL設定を行い、同じ内容を再同期しても書換えない", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-canvas-")));
    const creates: unknown[] = [];
    const edits: unknown[] = [];
    const access: unknown[] = [];
    const client: CanvasClient = {
      canvases: {
        create: async (input) => {
          creates.push(input);
          return { canvas_id: "F_CANVAS_1" };
        },
        edit: async (input) => void edits.push(input),
        access: { set: async (input) => void access.push(input) },
      },
    };
    const service = new CanvasProjectionService(client, store);
    const input = {
      teamId: "T123",
      viewerId: "U123",
      target: { kind: "user" as const, id: "U123" },
      scope: allAccessibleScope(),
      accessibleRepositories: ["art-tra2021/work"],
      items: [item("https://github.com/art-tra2021/work/issues/1")],
    };

    const first = await service.sync(input);
    const second = await service.sync(input);
    expect(first).toMatchObject({ created: true, updated: false, unchanged: false, itemCount: 1 });
    expect(second).toMatchObject({ created: false, updated: false, unchanged: true, itemCount: 1 });
    expect(creates).toHaveLength(1);
    expect(edits).toHaveLength(0);
    expect(access).toEqual([{ canvas_id: "F_CANVAS_1", access_level: "read", user_ids: ["U123"] }]);
    const states = await service.listExistingStates();
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      stateKey: first.stateKey,
      state: { canvasId: "F_CANVAS_1", contentHash: first.contentHash },
    });
  });

  test("Project内容が変わった時刻だけを表示し、定期同期では時刻を進めない", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-canvas-")));
    const creates: Array<{ document_content: { markdown: string } }> = [];
    const edits: Array<{ changes: Array<{ document_content?: { markdown: string } }> }> = [];
    let now = Date.parse("2026-08-05T05:00:00Z");
    const service = new CanvasProjectionService(
      {
        canvases: {
          create: async (input) => {
            creates.push(input);
            return { canvas_id: "F_CANVAS_TIMESTAMP" };
          },
          edit: async (input) => void edits.push(input),
          access: { set: async () => {} },
        },
      },
      store,
      () => now,
    );
    const workItem = item("https://github.com/art-tra2021/work/issues/1");
    const input = {
      teamId: "T123",
      viewerId: "U123",
      target: { kind: "user" as const, id: "U123" },
      scope: allAccessibleScope(),
      accessibleRepositories: ["art-tra2021/work"],
      items: [workItem],
    };

    await service.sync(input);
    expect(creates[0]?.document_content.markdown).toContain(
      "データ最終更新: 2026-08-05 14:00:00 JST",
    );

    now += 15 * 60_000;
    expect(await service.sync(input)).toMatchObject({ unchanged: true, updated: false });
    expect(edits).toHaveLength(0);

    workItem.priority = "P1";
    now += 15 * 60_000;
    expect(await service.sync(input)).toMatchObject({ unchanged: false, updated: true });
    expect(edits).toHaveLength(1);
    expect(edits[0]?.changes[0]?.document_content?.markdown).toContain(
      "データ最終更新: 2026-08-05 14:30:00 JST",
    );
  });

  test("最終更新時刻のない旧stateを一度だけ移行する", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-canvas-")));
    const edits: Array<{ changes: Array<{ document_content?: { markdown: string } }> }> = [];
    let now = Date.parse("2026-08-05T05:00:00Z");
    const service = new CanvasProjectionService(
      {
        canvases: {
          create: async () => ({ canvas_id: "F_CANVAS_LEGACY_TIMESTAMP" }),
          edit: async (input) => void edits.push(input),
          access: { set: async () => {} },
        },
      },
      store,
      () => now,
    );
    const input = {
      teamId: "T123",
      viewerId: "U123",
      target: { kind: "user" as const, id: "U123" },
      scope: allAccessibleScope(),
      accessibleRepositories: ["art-tra2021/work"],
      items: [item("https://github.com/art-tra2021/work/issues/1")],
    };
    const created = await service.sync(input);
    const legacy = await store.get<CanvasProjectionState>("project-canvas", created.stateKey);
    if (!legacy) throw new Error("Canvas stateがありません");
    delete legacy.lastUpdatedAt;
    await store.set("project-canvas", created.stateKey, legacy);

    now += 15 * 60_000;
    expect(await service.sync(input)).toMatchObject({ updated: true, unchanged: false });
    expect(edits[0]?.changes[0]?.document_content?.markdown).toContain(
      "データ最終更新: 2026-08-05 14:15:00 JST",
    );

    now += 15 * 60_000;
    expect(await service.sync(input)).toMatchObject({ updated: false, unchanged: true });
    expect(edits).toHaveLength(1);
  });

  test("定期同期用のexisting-only指定ではstate消失時にCanvasを新規作成しない", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-canvas-")));
    let createCount = 0;
    const service = new CanvasProjectionService(
      {
        canvases: {
          create: async () => {
            createCount += 1;
            return { canvas_id: "F_NEVER" };
          },
          edit: async () => {},
          access: { set: async () => {} },
        },
      },
      store,
    );

    await expect(
      service.sync({
        teamId: "T123",
        viewerId: "U123",
        target: { kind: "user", id: "U123" },
        scope: allAccessibleScope(),
        accessibleRepositories: ["art-tra2021/work"],
        items: [item("https://github.com/art-tra2021/work/issues/1")],
        createIfMissing: false,
      }),
    ).rejects.toMatchObject({ code: "canvas_projection_missing" });
    expect(createCount).toBe(0);
    expect(await service.listExistingStates()).toEqual([]);
  });

  test("repository scopeは対象repository以外をCanvasへ投影しない", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-canvas-")));
    const created: Array<{ document_content: { markdown: string } }> = [];
    const client: CanvasClient = {
      canvases: {
        create: async (input) => {
          created.push(input);
          return { canvas_id: "F_CANVAS_2" };
        },
        edit: async () => {},
        access: { set: async () => {} },
      },
    };
    await new CanvasProjectionService(client, store).sync({
      teamId: "T123",
      viewerId: "U123",
      target: { kind: "channel", id: "C123" },
      scope: repositoryScope("art-tra2021/work"),
      accessibleRepositories: ["art-tra2021/work"],
      items: [
        item("https://github.com/art-tra2021/work/issues/1"),
        item("https://github.com/art-tra2021/other/issues/2"),
      ],
    });
    expect(created[0]?.document_content.markdown).toContain("work#1");
    expect(created[0]?.document_content.markdown).not.toContain("other#2");
  });

  test("GitHubで確認済みのrepository集合がない投影をfail-closedにする", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-canvas-")));
    const service = new CanvasProjectionService(
      {
        canvases: {
          create: async () => ({ canvas_id: "F_NEVER" }),
          edit: async () => {},
          access: { set: async () => {} },
        },
      },
      store,
    );

    await expect(
      service.sync({
        teamId: "T123",
        viewerId: "U123",
        target: { kind: "user", id: "U123" },
        scope: allAccessibleScope(),
        items: [item("https://github.com/art-tra2021/private/issues/1")],
      }),
    ).rejects.toThrow("確認済みのrepository集合が必要");
  });

  test("作成後のACL設定失敗を再試行してもCanvasを重複作成しない", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-canvas-")));
    let createCount = 0;
    let accessCount = 0;
    const client: CanvasClient = {
      canvases: {
        create: async () => {
          createCount += 1;
          return { canvas_id: "F_CANVAS_RETRY" };
        },
        edit: async () => {},
        access: {
          set: async () => {
            accessCount += 1;
            if (accessCount === 1) throw new Error("一時的なSlack API障害");
          },
        },
      },
    };
    const service = new CanvasProjectionService(client, store);
    const input = {
      teamId: "T123",
      viewerId: "U123",
      target: { kind: "user" as const, id: "U123" },
      scope: allAccessibleScope(),
      accessibleRepositories: ["art-tra2021/work"],
      items: [item("https://github.com/art-tra2021/work/issues/1")],
    };

    await expect(service.sync(input)).rejects.toThrow("一時的なSlack API障害");
    const retried = await service.sync(input);

    expect(retried).toMatchObject({
      canvasId: "F_CANVAS_RETRY",
      created: false,
      updated: false,
      unchanged: true,
      accessUpdated: true,
    });
    expect(createCount).toBe(1);
    expect(accessCount).toBe(2);
  });

  test("同じscopeの並列同期をleaseで拒否してCanvasを重複作成しない", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-canvas-")));
    let releaseCreate: (() => void) | undefined;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let createCount = 0;
    const client: CanvasClient = {
      canvases: {
        create: async () => {
          createCount += 1;
          await createGate;
          return { canvas_id: "F_CANVAS_LEASE" };
        },
        edit: async () => {},
        access: { set: async () => {} },
      },
    };
    const service = new CanvasProjectionService(client, store);
    const input = {
      teamId: "T123",
      viewerId: "U123",
      target: { kind: "user" as const, id: "U123" },
      scope: allAccessibleScope(),
      accessibleRepositories: ["art-tra2021/work"],
      items: [item("https://github.com/art-tra2021/work/issues/1")],
    };

    const first = service.sync(input);
    while (createCount === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(service.sync(input)).rejects.toThrow("同期処理が進行中です");
    releaseCreate?.();
    await first;

    expect(createCount).toBe(1);
  });

  test("GitHub連携解除時に個人Canvasのread ACLを失効させる", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-canvas-")));
    const deleted: unknown[] = [];
    const client: CanvasClient = {
      canvases: {
        create: async () => ({ canvas_id: "F_CANVAS_REVOKE" }),
        edit: async () => {},
        access: {
          set: async () => {},
          delete: async (input) => void deleted.push(input),
        },
      },
    };
    const service = new CanvasProjectionService(client, store);
    const input = {
      teamId: "T123",
      viewerId: "U123",
      target: { kind: "user" as const, id: "U123" },
      scope: allAccessibleScope(),
      accessibleRepositories: ["art-tra2021/work"],
      items: [item("https://github.com/art-tra2021/work/issues/1")],
    };
    const projection = await service.sync(input);

    expect(await service.revokeViewerAccess("T123", "U123")).toBe(1);
    expect(deleted).toEqual([{ canvas_id: "F_CANVAS_REVOKE", user_ids: ["U123"] }]);
    expect(await store.get("project-canvas", projection.stateKey)).toBeNull();
  });

  test("Issue titleでMarkdown linkから脱出できない", () => {
    const malicious = item("https://github.com/art-tra2021/work/issues/1");
    malicious.title = "](https://evil.example)[確認";
    const markdown = canvasMarkdown([malicious]);

    expect(markdown).not.toContain("](https://evil.example)");
    expect(markdown).toContain("］（https://evil.example）［確認");
  });
});

function item(url: string): HumanWorkItem {
  return {
    schemaVersion: 1,
    issueNumber: Number(url.match(/issues\/(\d+)/)?.[1] ?? 1),
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
