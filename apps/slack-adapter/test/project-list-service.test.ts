import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectListClient, ProjectListState } from "../src/project-list.ts";
import { projectListSchema } from "../src/project-list.ts";
import {
  ProjectListSyncService,
  parseProjectListSyncCommand,
} from "../src/project-list-service.ts";
import { RetryableWorkError } from "../src/retryable-error.ts";
import { LocalStateStore } from "../src/state-store.ts";

describe("ProjectListSyncService", () => {
  test("定期同期commandをversion付きJSONとして検証する", () => {
    expect(parseProjectListSyncCommand('{"schemaVersion":1,"kind":"project-list.sync"}')).toEqual({
      schemaVersion: 1,
      kind: "project-list.sync",
    });
    expect(() => parseProjectListSyncCommand('{"schemaVersion":2}')).toThrow("同期commandが不正");
    expect(() => parseProjectListSyncCommand("not-json")).toThrow("JSONを読み取れません");
  });

  test("初回作成したListをstateへ保存して次回も使う", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arttra-project-list-"));
    const store = new LocalStateStore(directory);
    let createCount = 0;
    const client: ProjectListClient = {
      slackLists: {
        create: async () => {
          createCount += 1;
          return {
            list_id: "FPROJECTLIST",
            list_metadata: {
              schema: listMetadataSchema().map((column, index) => ({
                ...column,
                id: `Col0000000${index}`,
              })),
            },
          };
        },
        access: { set: async () => {} },
        update: async () => {},
        items: {
          list: async () => ({ items: [] }),
          create: async () => ({ item: { id: "RecNEW" } }),
          update: async () => {},
          deleteMultiple: async () => {},
        },
      },
    };
    const service = new ProjectListSyncService(client, { loadProjectItems: async () => [] }, store);

    expect((await service.sync("C123")).listId).toBe("FPROJECTLIST");
    expect((await service.sync("C123")).listId).toBe("FPROJECTLIST");
    expect(createCount).toBe(1);
    expect((await store.get<ProjectListState>("project-list", "C123"))?.listId).toBe(
      "FPROJECTLIST",
    );
  });

  test("scope不足を日本語で案内する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arttra-project-list-"));
    const client = {
      slackLists: {
        create: async () => {
          throw { data: { error: "missing_scope" } };
        },
      },
    } as unknown as ProjectListClient;
    const service = new ProjectListSyncService(
      client,
      { loadProjectItems: async () => [] },
      new LocalStateStore(directory),
    );

    await expect(service.sync("C123")).rejects.toThrow("lists:readとlists:write");
  });

  test("GitHubで確認済みのrepository集合がないscope投影をfail-closedにする", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arttra-project-list-"));
    const service = new ProjectListSyncService(
      {} as ProjectListClient,
      { loadProjectItems: async () => [] },
      new LocalStateStore(directory),
    );

    await expect(
      service.sync("D123", "U123", {
        teamId: "T123",
        viewerId: "U123",
        scope: { kind: "all-accessible" },
        target: { kind: "user", id: "U123" },
      }),
    ).rejects.toThrow("確認済みのrepository集合が必要");
  });

  test("既存Listを同期実行者へ共有する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arttra-project-list-"));
    const store = new LocalStateStore(directory);
    await store.set("project-list", "C123", {
      schemaVersion: 3,
      listId: "FPROJECTLIST",
      columns: {
        task: "Col00000000",
        status: "Col00000001",
        github: "Col00000002",
        assignee: "Col00000004",
        target_date: "Col00000005",
      },
    });
    const accessCalls: unknown[] = [];
    const client = {
      slackLists: {
        access: { set: async (input: unknown) => void accessCalls.push(input) },
        update: async () => {},
        items: {
          list: async () => ({ items: [] }),
          create: async () => ({ item: { id: "RecNEW" } }),
          update: async () => {},
          deleteMultiple: async () => {},
        },
      },
    } as unknown as ProjectListClient;
    const service = new ProjectListSyncService(client, { loadProjectItems: async () => [] }, store);

    await service.sync("C123", "U123");

    expect(accessCalls).toEqual([
      { list_id: "FPROJECTLIST", access_level: "read", user_ids: ["U123"] },
    ]);
  });

  test("独自の担当者・期限列を持つ版を残して標準5列版へ移行する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arttra-project-list-"));
    const store = new LocalStateStore(directory);
    await store.set("project-list", "C123", {
      schemaVersion: 1,
      listId: "FLEGACY",
      columns: {},
    });
    const updateCalls: Array<{ id: string; name: string }> = [];
    const client = {
      slackLists: {
        create: async () => ({
          list_id: "FPROJECTLIST",
          list_metadata: {
            schema: listMetadataSchema().map((column, index) => ({
              ...column,
              id: `Col0000000${index}`,
            })),
          },
        }),
        access: { set: async () => {} },
        update: async (input: { id: string; name: string }) => void updateCalls.push(input),
        items: {
          list: async () => ({ items: [] }),
          create: async () => ({ item: { id: "RecNEW" } }),
          update: async () => {},
          deleteMultiple: async () => {},
        },
      },
    } as unknown as ProjectListClient;
    const service = new ProjectListSyncService(client, { loadProjectItems: async () => [] }, store);

    expect((await service.sync("C123")).listId).toBe("FPROJECTLIST");
    expect(updateCalls).toContainEqual(
      expect.objectContaining({ id: "FLEGACY", name: "ART-TRA Work（旧表示）" }),
    );
    expect((await store.get<ProjectListState>("project-list", "C123"))?.schemaVersion).toBe(3);
  });

  test("scope導入前の共有ListはACLと全行を除去してからrepository限定版へ移行する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arttra-project-list-"));
    const store = new LocalStateStore(directory);
    await store.set("project-list", "C123", {
      schemaVersion: 3,
      listId: "FLEGACY",
      columns: {
        task: "Col00000000",
        status: "Col00000001",
        github: "Col00000002",
        assignee: "Col00000004",
        target_date: "Col00000005",
      },
    });
    const deletedAccess: unknown[] = [];
    const deletedRows: unknown[] = [];
    const renamed: string[] = [];
    const client = {
      slackLists: {
        create: async () => ({
          list_id: "FSCOPED",
          list_metadata: {
            schema: listMetadataSchema().map((column, index) => ({
              ...column,
              id: `Col0000000${index}`,
            })),
          },
        }),
        access: {
          set: async () => {},
          delete: async (input: unknown) => void deletedAccess.push(input),
        },
        update: async (input: { id: string }) => void renamed.push(input.id),
        items: {
          list: async ({ list_id }: { list_id: string }) => ({
            items: list_id === "FLEGACY" ? [{ id: "RecPRIVATE" }] : [],
          }),
          create: async () => ({ item: { id: "RecNEW" } }),
          update: async () => {},
          deleteMultiple: async (input: unknown) => void deletedRows.push(input),
        },
      },
    } as unknown as ProjectListClient;
    const service = new ProjectListSyncService(client, { loadProjectItems: async () => [] }, store);

    const result = await service.sync("C123", undefined, {
      teamId: "T123",
      scope: { kind: "repo", repository: "art-tra2021/work" },
      target: { kind: "channel", id: "C123" },
      accessibleRepositories: ["art-tra2021/work"],
    });

    expect(result.listId).toBe("FSCOPED");
    expect(deletedAccess).toEqual([{ list_id: "FLEGACY", channel_ids: ["C123"] }]);
    expect(deletedRows).toEqual([{ list_id: "FLEGACY", ids: ["RecPRIVATE"] }]);
    expect(renamed).toContain("FLEGACY");
    expect(await store.get("project-list", "C123")).toBeNull();
  });

  test("同じchannelへの同期を同時実行しない", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arttra-project-list-"));
    const store = new LocalStateStore(directory);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = {
      slackLists: {
        create: async () => ({
          list_id: "FPROJECTLIST",
          list_metadata: {
            schema: listMetadataSchema().map((column, index) => ({
              ...column,
              id: `Col0000000${index}`,
            })),
          },
        }),
        access: { set: async () => {} },
        update: async () => {},
        items: {
          list: async () => {
            await gate;
            return { items: [] };
          },
          create: async () => ({ item: { id: "RecNEW" } }),
          update: async () => {},
          deleteMultiple: async () => {},
        },
      },
    } as ProjectListClient;
    const service = new ProjectListSyncService(client, { loadProjectItems: async () => [] }, store);

    const first = service.sync("C123");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(service.sync("C123")).rejects.toBeInstanceOf(RetryableWorkError);
    await expect(service.sync("C123")).rejects.toMatchObject({
      code: "project_list_sync_in_progress",
      message: expect.stringContaining("同期処理が進行中"),
    });
    release();
    await first;
    expect((await service.sync("C123")).listId).toBe("FPROJECTLIST");
  });

  test("GitHub連携解除時に個人Listのread ACLとstateを失効させる", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-project-list-")));
    await store.set<ProjectListState>("project-list", "viewer-state", {
      schemaVersion: 3,
      listId: "FPROJECTPRIVATE",
      columns: {
        task: "Col00000000",
        status: "Col00000001",
        github: "Col00000002",
        assignee: "Col00000004",
        target_date: "Col00000005",
      },
      binding: {
        teamId: "T123",
        viewerId: "U123",
        target: { kind: "user", id: "U123" },
        kind: "list",
        scope: { kind: "all-accessible" },
      },
      stateKey: "viewer-state",
    });
    const deleted: unknown[] = [];
    const client = {
      slackLists: {
        access: { delete: async (input: unknown) => void deleted.push(input) },
      },
    } as unknown as ProjectListClient;
    const service = new ProjectListSyncService(client, { loadProjectItems: async () => [] }, store);

    expect(await service.revokeViewerAccess("T123", "U123")).toBe(1);
    expect(deleted).toEqual([{ list_id: "FPROJECTPRIVATE", user_ids: ["U123"] }]);
    expect(await store.get("project-list", "viewer-state")).toBeNull();
  });
});

function listMetadataSchema() {
  return [
    ...projectListSchema,
    { key: "todo_completed", name: "完了済み", type: "todo_completed" },
    { key: "todo_assignee", name: "担当者", type: "todo_assignee" },
    { key: "todo_due_date", name: "期限日", type: "todo_due_date" },
  ];
}
