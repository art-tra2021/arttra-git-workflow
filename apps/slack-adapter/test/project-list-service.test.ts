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

  test("作成直後のACL失敗を再試行してもListを重複作成しない", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arttra-project-list-"));
    const store = new LocalStateStore(directory);
    let createCount = 0;
    let accessCount = 0;
    let loadCount = 0;
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
        access: {
          set: async () => {
            accessCount += 1;
            if (accessCount === 1) throw new Error("temporary_acl_failure");
          },
        },
        update: async () => {},
        items: {
          list: async () => ({ items: [] }),
          create: async () => ({ item: { id: "RecNEW" } }),
          update: async () => {},
          deleteMultiple: async () => {},
        },
      },
    };
    const service = new ProjectListSyncService(
      client,
      {
        loadProjectItems: async () => {
          loadCount += 1;
          return [];
        },
      },
      store,
    );

    await expect(service.sync("C123")).rejects.toThrow("temporary_acl_failure");
    expect(loadCount).toBe(0);
    expect(await store.get<ProjectListState>("project-list", "C123")).toMatchObject({
      schemaVersion: 3,
      listId: "FPROJECTLIST",
    });

    expect((await service.sync("C123")).listId).toBe("FPROJECTLIST");
    expect(createCount).toBe(1);
    expect(accessCount).toBe(2);
    expect(loadCount).toBe(1);
  });

  test("旧Listを持つ初回ACL失敗では旧IDを保持してmarkまで再試行する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arttra-project-list-"));
    const store = new LocalStateStore(directory);
    await store.set("project-list", "C123", {
      schemaVersion: 1,
      listId: "FLEGACY",
      columns: {},
    });
    let createCount = 0;
    let accessCount = 0;
    let loadCount = 0;
    const marked: string[] = [];
    const client: ProjectListClient = {
      slackLists: {
        create: async () => {
          createCount += 1;
          return {
            list_id: "FNEWLIST",
            list_metadata: {
              schema: listMetadataSchema().map((column, index) => ({
                ...column,
                id: `Col0000000${index}`,
              })),
            },
          };
        },
        access: {
          set: async () => {
            accessCount += 1;
            if (accessCount === 1) throw new Error("temporary_legacy_acl_failure");
          },
        },
        update: async (input: { id: string }) => {
          marked.push(input.id);
        },
        items: {
          list: async () => ({ items: [] }),
          create: async () => ({ item: { id: "RecNEW" } }),
          update: async () => {},
          deleteMultiple: async () => {},
        },
      },
    };
    const service = new ProjectListSyncService(
      client,
      {
        loadProjectItems: async () => {
          loadCount += 1;
          return [];
        },
      },
      store,
    );

    await expect(service.sync("C123")).rejects.toThrow("temporary_legacy_acl_failure");
    expect(loadCount).toBe(0);
    expect(marked).toEqual([]);
    expect(await store.get<ProjectListState>("project-list", "C123")).toMatchObject({
      listId: "FNEWLIST",
      accessPending: true,
      pendingLegacyListId: "FLEGACY",
    });

    await service.sync("C123");
    expect(createCount).toBe(1);
    expect(accessCount).toBe(2);
    expect(marked).toEqual(["FLEGACY"]);
    expect(loadCount).toBe(1);
    expect(await store.get<ProjectListState>("project-list", "C123")).not.toMatchObject({
      accessPending: true,
      pendingLegacyListId: "FLEGACY",
    });
  });

  test("旧Listのmark失敗ではpending IDを残して行同期を保留する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arttra-project-list-"));
    const store = new LocalStateStore(directory);
    await store.set("project-list", "C123", {
      schemaVersion: 1,
      listId: "FLEGACY",
      columns: {},
    });
    let createCount = 0;
    let accessCount = 0;
    let updateCount = 0;
    let loadCount = 0;
    const client: ProjectListClient = {
      slackLists: {
        create: async () => {
          createCount += 1;
          return {
            list_id: "FNEWLIST",
            list_metadata: {
              schema: listMetadataSchema().map((column, index) => ({
                ...column,
                id: `Col0000000${index}`,
              })),
            },
          };
        },
        access: {
          set: async () => {
            accessCount += 1;
          },
        },
        update: async (input: { id: string }) => {
          updateCount += 1;
          if (updateCount === 1) throw new Error(`temporary_mark_failure:${input.id}`);
        },
        items: {
          list: async () => ({ items: [] }),
          create: async () => ({ item: { id: "RecNEW" } }),
          update: async () => {},
          deleteMultiple: async () => {},
        },
      },
    };
    const service = new ProjectListSyncService(
      client,
      {
        loadProjectItems: async () => {
          loadCount += 1;
          return [];
        },
      },
      store,
    );

    await expect(service.sync("C123")).rejects.toThrow("temporary_mark_failure:FLEGACY");
    expect(loadCount).toBe(0);
    expect(await store.get<ProjectListState>("project-list", "C123")).toMatchObject({
      listId: "FNEWLIST",
      pendingLegacyListId: "FLEGACY",
    });

    await service.sync("C123");
    expect(createCount).toBe(1);
    expect(accessCount).toBe(1);
    expect(updateCount).toBe(2);
    expect(loadCount).toBe(1);
    expect(await store.get<ProjectListState>("project-list", "C123")).not.toMatchObject({
      pendingLegacyListId: "FLEGACY",
    });
  });

  test("repository-scoped channel bindingはACL失敗後も同じListを再利用する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arttra-project-list-"));
    const store = new LocalStateStore(directory);
    let createCount = 0;
    let accessCount = 0;
    let loadCount = 0;
    const accessCalls: unknown[] = [];
    const client: ProjectListClient = {
      slackLists: {
        create: async () => {
          createCount += 1;
          return {
            list_id: "FCHANNELPROJECT",
            list_metadata: {
              schema: listMetadataSchema().map((column, index) => ({
                ...column,
                id: `Col0000000${index}`,
              })),
            },
          };
        },
        access: {
          set: async (input: unknown) => {
            accessCalls.push(input);
            accessCount += 1;
            if (accessCount === 1) throw new Error("temporary_channel_acl_failure");
          },
        },
        update: async () => {},
        items: {
          list: async () => ({ items: [] }),
          create: async () => ({ item: { id: "RecNEW" } }),
          update: async () => {},
          deleteMultiple: async () => {},
        },
      },
    };
    const service = new ProjectListSyncService(
      client,
      {
        loadProjectItems: async () => {
          loadCount += 1;
          return [];
        },
      },
      store,
    );
    const options = {
      teamId: "T123",
      viewerId: null,
      scope: { kind: "repo" as const, repository: "art-tra2021/work" },
      target: { kind: "channel" as const, id: "C123" },
      accessibleRepositories: ["art-tra2021/work"],
    };

    await expect(service.sync("C123", undefined, options)).rejects.toThrow(
      "temporary_channel_acl_failure",
    );
    expect(loadCount).toBe(0);
    expect((await store.list<ProjectListState>("project-list"))[0]).toMatchObject({
      listId: "FCHANNELPROJECT",
      accessPending: true,
      binding: { target: { kind: "channel", id: "C123" } },
    });
    const initialGuard = await store.get<{ createdAt?: string }>(
      "project-list-legacy-guard",
      "C123",
    );
    const initialGuardCreatedAt = initialGuard?.createdAt;

    await service.sync("C123", undefined, options);
    expect(createCount).toBe(1);
    expect(loadCount).toBe(1);
    expect(accessCalls).toEqual([
      { list_id: "FCHANNELPROJECT", access_level: "read", channel_ids: ["C123"] },
      { list_id: "FCHANNELPROJECT", access_level: "read", channel_ids: ["C123"] },
    ]);
    expect((await store.list<ProjectListState>("project-list"))[0]?.accessPending).toBe(false);
    expect(
      (await store.get<{ createdAt?: string }>("project-list-legacy-guard", "C123"))?.createdAt,
    ).toBe(initialGuardCreatedAt);
    expect(await store.get("project-list-legacy-guard", "C123")).toMatchObject({
      schemaVersion: 1,
      kind: "scoped-only",
      channelId: "C123",
    });
    await expect(service.sync("C123")).rejects.toThrow("repository限定のProject Listへ移行済み");
  });

  test("all-accessible user bindingはACL失敗後も同じListを再利用する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arttra-project-list-"));
    const store = new LocalStateStore(directory);
    let createCount = 0;
    let accessCount = 0;
    let loadCount = 0;
    const accessCalls: unknown[] = [];
    const client: ProjectListClient = {
      slackLists: {
        create: async () => {
          createCount += 1;
          return {
            list_id: "FUSERPROJECT",
            list_metadata: {
              schema: listMetadataSchema().map((column, index) => ({
                ...column,
                id: `Col0000000${index}`,
              })),
            },
          };
        },
        access: {
          set: async (input: unknown) => {
            accessCalls.push(input);
            accessCount += 1;
            if (accessCount === 1) throw new Error("temporary_user_acl_failure");
          },
        },
        update: async () => {},
        items: {
          list: async () => ({ items: [] }),
          create: async () => ({ item: { id: "RecNEW" } }),
          update: async () => {},
          deleteMultiple: async () => {},
        },
      },
    };
    const service = new ProjectListSyncService(
      client,
      {
        loadProjectItems: async () => {
          loadCount += 1;
          return [];
        },
      },
      store,
    );
    const options = {
      teamId: "T123",
      viewerId: "U123",
      scope: { kind: "all-accessible" as const },
      target: { kind: "user" as const, id: "U123" },
      accessibleRepositories: ["art-tra2021/work"],
    };

    await expect(service.sync("D123", "U123", options)).rejects.toThrow(
      "temporary_user_acl_failure",
    );
    expect(loadCount).toBe(0);
    expect((await store.list<ProjectListState>("project-list"))[0]).toMatchObject({
      listId: "FUSERPROJECT",
      accessPending: true,
      binding: { target: { kind: "user", id: "U123" } },
    });

    await service.sync("D123", "U123", options);
    expect(createCount).toBe(1);
    expect(loadCount).toBe(1);
    expect(accessCalls).toEqual([
      { list_id: "FUSERPROJECT", access_level: "read", user_ids: ["U123"] },
      { list_id: "FUSERPROJECT", access_level: "read", user_ids: ["U123"] },
    ]);
    expect((await store.list<ProjectListState>("project-list"))[0]?.accessPending).toBe(false);
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

  test("旧ListとACL待ちの新Listをまとめて移行しscope Listを重複作成しない", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arttra-project-list-"));
    const store = new LocalStateStore(directory);
    await store.set("project-list", "C123", {
      schemaVersion: 1,
      listId: "FOLD",
      columns: {},
    });
    let createCount = 0;
    let accessSetCount = 0;
    let loadCount = 0;
    const createdListIds: string[] = [];
    const deletedAccess: unknown[] = [];
    const deletedRows: unknown[] = [];
    const renamed: string[] = [];
    const client: ProjectListClient = {
      slackLists: {
        create: async () => {
          createCount += 1;
          const listId = createCount === 1 ? "FNEW" : "FSCOPED";
          createdListIds.push(listId);
          return {
            list_id: listId,
            list_metadata: {
              schema: listMetadataSchema().map((column, index) => ({
                ...column,
                id: `Col0000000${index}`,
              })),
            },
          };
        },
        access: {
          set: async () => {
            accessSetCount += 1;
            if (accessSetCount === 1) throw new Error("temporary_unscoped_acl_failure");
          },
          delete: async (input: unknown) => void deletedAccess.push(input),
        },
        update: async (input: { id: string }) => void renamed.push(input.id),
        items: {
          list: async ({ list_id }: { list_id: string }) => ({
            items:
              list_id === "FOLD"
                ? [{ id: "RowFOLD" }]
                : list_id === "FNEW"
                  ? [{ id: "RowFNEW" }]
                  : [],
          }),
          create: async () => ({ item: { id: "RecNEW" } }),
          update: async () => {},
          deleteMultiple: async (input: unknown) => void deletedRows.push(input),
        },
      },
    };
    const service = new ProjectListSyncService(
      client,
      {
        loadProjectItems: async () => {
          loadCount += 1;
          return [];
        },
      },
      store,
    );

    await expect(service.sync("C123")).rejects.toThrow("temporary_unscoped_acl_failure");
    expect(await store.get<ProjectListState>("project-list", "C123")).toMatchObject({
      listId: "FNEW",
      accessPending: true,
      pendingLegacyListId: "FOLD",
    });

    const result = await service.sync("C123", undefined, {
      teamId: "T123",
      scope: { kind: "repo", repository: "art-tra2021/work" },
      target: { kind: "channel", id: "C123" },
      accessibleRepositories: ["art-tra2021/work"],
    });

    expect(result.listId).toBe("FSCOPED");
    expect(createdListIds).toEqual(["FNEW", "FSCOPED"]);
    expect(accessSetCount).toBe(2);
    expect(deletedAccess).toEqual([
      { list_id: "FOLD", channel_ids: ["C123"] },
      { list_id: "FNEW", channel_ids: ["C123"] },
    ]);
    expect(deletedRows).toEqual([
      { list_id: "FOLD", ids: ["RowFOLD"] },
      { list_id: "FNEW", ids: ["RowFNEW"] },
    ]);
    expect(renamed).toEqual(["FOLD", "FNEW"]);
    expect(loadCount).toBe(1);
    expect(await store.get("project-list", "C123")).toBeNull();
    expect((await store.list<ProjectListState>("project-list"))[0]).toMatchObject({
      listId: "FSCOPED",
      binding: {
        scope: { kind: "repo", repository: "art-tra2021/work" },
        target: { kind: "channel", id: "C123" },
      },
    });

    await expect(service.sync("C123")).rejects.toThrow("repository限定のProject Listへ移行済み");
    expect(createdListIds).toEqual(["FNEW", "FSCOPED"]);
    expect((await store.list<ProjectListState>("project-list"))[0]?.listId).toBe("FSCOPED");
    expect(await store.get("project-list-legacy-guard", "C123")).toMatchObject({
      schemaVersion: 1,
      kind: "scoped-only",
      channelId: "C123",
    });
  });

  test("起動時の旧List移行でもguardを保存して全repository同期を拒否する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arttra-project-list-"));
    const store = new LocalStateStore(directory);
    await store.set("project-list", "C123", {
      schemaVersion: 1,
      listId: "FLEGACY",
      columns: {},
    });
    const deletedAccess: unknown[] = [];
    const client: ProjectListClient = {
      slackLists: {
        create: async () => {
          throw new Error("unscoped_create_must_be_blocked");
        },
        access: {
          set: async () => {},
          delete: async (input: unknown) => void deletedAccess.push(input),
        },
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

    await service.migrateLegacyChannelState("C123");

    expect(deletedAccess).toEqual([{ list_id: "FLEGACY", channel_ids: ["C123"] }]);
    expect(await store.get("project-list", "C123")).toBeNull();
    expect(await store.get("project-list-legacy-guard", "C123")).toMatchObject({
      schemaVersion: 1,
      kind: "scoped-only",
      channelId: "C123",
    });
    await expect(service.sync("C123")).rejects.toThrow("repository限定のProject Listへ移行済み");
  });

  test("旧Listがない起動時移行でもguardを保存する", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-project-list-")));
    const service = new ProjectListSyncService(
      {} as ProjectListClient,
      { loadProjectItems: async () => [] },
      store,
    );

    await service.migrateLegacyChannelState("C123");

    expect(await store.get("project-list-legacy-guard", "C123")).toMatchObject({
      schemaVersion: 1,
      kind: "scoped-only",
      channelId: "C123",
    });
    await expect(service.sync("C123")).rejects.toThrow("repository限定のProject Listへ移行済み");
  });

  test("falseyまたは不正なguardを未存在として扱わず同期を拒否する", async () => {
    for (const invalidGuard of [false, 0, "", {}, { schemaVersion: 2 }]) {
      const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-project-list-")));
      await store.set("project-list-legacy-guard", "C123", invalidGuard);
      let createCount = 0;
      const client = {
        slackLists: {
          create: async () => {
            createCount += 1;
            throw new Error("create_must_be_blocked");
          },
        },
      } as unknown as ProjectListClient;
      const service = new ProjectListSyncService(
        client,
        { loadProjectItems: async () => [] },
        store,
      );

      await expect(service.sync("C123")).rejects.toThrow("移行保護状態が不正");
      expect(createCount).toBe(0);
    }
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
