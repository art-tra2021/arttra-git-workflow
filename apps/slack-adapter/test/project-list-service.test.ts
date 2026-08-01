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
              schema: projectListSchema.map((column, index) => ({
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

  test("既存Listを同期実行者へ共有する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arttra-project-list-"));
    const store = new LocalStateStore(directory);
    await store.set("project-list", "C123", {
      schemaVersion: 1,
      listId: "FPROJECTLIST",
      columns: Object.fromEntries(
        projectListSchema.map((column, index) => [column.key, `Col0000000${index}`]),
      ),
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
      { list_id: "FPROJECTLIST", access_level: "read", channel_ids: ["C123"] },
      { list_id: "FPROJECTLIST", access_level: "read", user_ids: ["U123"] },
    ]);
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
            schema: projectListSchema.map((column, index) => ({
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
    await expect(service.sync("C123")).rejects.toThrow("同期処理が進行中");
    release();
    await first;
    expect((await service.sync("C123")).listId).toBe("FPROJECTLIST");
  });
});
