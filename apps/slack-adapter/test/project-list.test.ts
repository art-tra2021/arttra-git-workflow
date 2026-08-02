import { describe, expect, test } from "bun:test";
import {
  createProjectList,
  ensureProjectListDefinition,
  type ProjectListClient,
  type ProjectListColumns,
  type ProjectListItem,
  type ProjectListState,
  projectListSchema,
  syncProjectList,
} from "../src/project-list.ts";
import { toHumanWorkItem } from "../src/read-model.ts";
import { snapshot } from "./fixtures.ts";

const columns: ProjectListColumns = {
  task: "Col00000000",
  status: "Col00000001",
  github: "Col00000002",
  assignee: "Col00000004",
  target_date: "Col00000005",
};

const state: ProjectListState = { schemaVersion: 3, listId: "FPROJECTLIST", columns };

describe("Slack Project List", () => {
  test("Projects投影用Listをread権限でchannelへ共有する", async () => {
    const accessCalls: unknown[] = [];
    const client = clientStub({
      create: async (input) => {
        expect(input.todo_mode).toBe(true);
        expect(input.schema.map((column) => column.key)).toEqual(["task", "status", "github"]);
        return {
          list_id: "FPROJECTLIST",
          list_metadata: {
            schema: listMetadataSchema(input.schema).map((column, index) => ({
              ...column,
              id: `Col0000000${index}`,
            })),
          },
        };
      },
      accessSet: async (input) => void accessCalls.push(input),
    });

    expect(await createProjectList(client, "C123", "U123")).toEqual(state);
    expect(accessCalls).toEqual([
      { list_id: "FPROJECTLIST", access_level: "read", channel_ids: ["C123"] },
      { list_id: "FPROJECTLIST", access_level: "read", user_ids: ["U123"] },
    ]);
  });

  test("Issueをnative担当者とGitHubリンクを持つ行へ変換する", async () => {
    const createCalls: Array<{ initial_fields: Array<Record<string, unknown>> }> = [];
    const client = clientStub({
      itemCreate: async (input) => {
        createCalls.push(input);
        return { item: { id: "RecNEW" } };
      },
    });
    const result = await syncProjectList(
      client,
      state,
      [toHumanWorkItem(snapshot(), "reviewer")],
      async (login) => (login === "rozwer" ? "UROZWER" : null),
    );

    expect(result).toEqual({
      listId: "FPROJECTLIST",
      itemCount: 1,
      created: 1,
      updated: 0,
      deleted: 0,
    });
    const fields = createCalls[0]?.initial_fields ?? [];
    expect(fields).toContainEqual({ column_id: columns.assignee, user: ["UROZWER"] });
    expect(fields).toContainEqual({ column_id: columns.status, select: ["in-progress"] });
    expect(fields).toContainEqual({
      column_id: columns.github,
      link: [
        {
          original_url: "https://github.com/example/repo/issues/23",
          display_as_url: false,
          display_name: "Issueを開く",
        },
      ],
    });
  });

  test("既存Listをタスクモードへ揃える", async () => {
    const updateCalls: unknown[] = [];
    const client = clientStub({ listUpdate: async (input) => void updateCalls.push(input) });

    await ensureProjectListDefinition(client, "FPROJECTLIST");

    expect(updateCalls).toEqual([
      expect.objectContaining({ id: "FPROJECTLIST", name: "ART-TRA Work", todo_mode: true }),
    ]);
  });

  test("既存行を一括更新し、Projectから外れた投影行を削除する", async () => {
    const updateCalls: unknown[] = [];
    const deleteCalls: unknown[] = [];
    const existing: ProjectListItem[] = [
      row("RecKEEP", "https://github.com/example/repo/issues/23"),
      row("RecSTALE", "https://github.com/example/repo/issues/99"),
      { id: "RecMANUAL", fields: [] },
    ];
    const client = clientStub({
      items: existing,
      itemUpdate: async (input) => void updateCalls.push(input),
      itemDeleteMultiple: async (input) => void deleteCalls.push(input),
    });

    const result = await syncProjectList(
      client,
      state,
      [toHumanWorkItem(snapshot(), "reviewer")],
      async () => null,
    );

    expect(result.updated).toBe(1);
    expect(result.deleted).toBe(1);
    expect(updateCalls).toHaveLength(1);
    expect(deleteCalls).toEqual([{ list_id: "FPROJECTLIST", ids: ["RecSTALE"] }]);
  });

  test("完了済み項目は未完了一覧へ投影しない", async () => {
    let created = false;
    const client = clientStub({
      itemCreate: async () => {
        created = true;
        return { item: { id: "RecNEW" } };
      },
    });
    const completed = toHumanWorkItem(
      snapshot({
        project: { status: "done", priority: "P2", owner: "rozwer", targetDate: null },
      }),
      "reviewer",
    );

    expect((await syncProjectList(client, state, [completed], async () => null)).itemCount).toBe(0);
    expect(created).toBe(false);
  });

  test("大量更新を100cell単位に分割する", async () => {
    const updateCalls: Array<{ cells: unknown[] }> = [];
    const desired = Array.from({ length: 12 }, (_, index) =>
      toHumanWorkItem(
        snapshot({
          issue: {
            number: index + 1,
            title: `task-${index + 1}`,
            url: `https://github.com/example/repo/issues/${index + 1}`,
            type: "work",
          },
        }),
        "reviewer",
      ),
    );
    const client = clientStub({
      items: desired.map((item, index) => row(`Rec${index}`, item.url)),
      itemUpdate: async (input) => void updateCalls.push(input),
    });

    await syncProjectList(client, state, desired, async () => null);

    expect(updateCalls.map((call) => call.cells.length)).toEqual([60]);
  });

  test("大量削除を100件単位に分割する", async () => {
    const deleteCalls: Array<{ ids: string[] }> = [];
    const existing = Array.from({ length: 102 }, (_, index) =>
      row(`Rec${index}`, `https://github.com/example/repo/issues/${index + 1}`),
    );
    const client = clientStub({
      items: existing,
      itemDeleteMultiple: async (input) => void deleteCalls.push(input),
    });

    await syncProjectList(client, state, [], async () => null);

    expect(deleteCalls.map((call) => call.ids.length)).toEqual([100, 2]);
  });
});

interface ClientOverrides {
  create?: ProjectListClient["slackLists"]["create"];
  accessSet?: ProjectListClient["slackLists"]["access"]["set"];
  listUpdate?: ProjectListClient["slackLists"]["update"];
  items?: ProjectListItem[];
  itemCreate?: ProjectListClient["slackLists"]["items"]["create"];
  itemUpdate?: ProjectListClient["slackLists"]["items"]["update"];
  itemDeleteMultiple?: ProjectListClient["slackLists"]["items"]["deleteMultiple"];
}

function clientStub(overrides: ClientOverrides = {}): ProjectListClient {
  return {
    slackLists: {
      create:
        overrides.create ??
        (async () => ({
          list_id: "FPROJECTLIST",
          list_metadata: {
            schema: listMetadataSchema().map((column, index) => ({
              ...column,
              id: `Col0000000${index}`,
            })),
          },
        })),
      access: { set: overrides.accessSet ?? (async () => {}) },
      update: overrides.listUpdate ?? (async () => {}),
      items: {
        list: async () => ({ items: overrides.items ?? [] }),
        create: overrides.itemCreate ?? (async () => ({ item: { id: "RecNEW" } })),
        update: overrides.itemUpdate ?? (async () => {}),
        deleteMultiple: overrides.itemDeleteMultiple ?? (async () => {}),
      },
    },
  };
}

function row(id: string, url: string): ProjectListItem {
  return {
    id,
    fields: [{ column_id: columns.github, link: [{ originalUrl: url }] }],
  };
}

function listMetadataSchema(custom = projectListSchema) {
  return [
    ...custom,
    { key: "todo_completed", name: "完了済み", type: "todo_completed" },
    { key: "todo_assignee", name: "担当者", type: "todo_assignee" },
    { key: "todo_due_date", name: "期限日", type: "todo_due_date" },
  ];
}
