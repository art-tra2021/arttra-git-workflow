import type { HumanWorkItem } from "./types.ts";

export type ProjectListColumnKey = "task" | "status" | "assignee" | "target_date" | "github";

export type ProjectListColumns = Record<ProjectListColumnKey, string>;

export interface ProjectListState {
  schemaVersion: 2;
  listId: string;
  columns: ProjectListColumns;
}

interface ProjectListSchemaColumn {
  key: string;
  name: string;
  type: string;
  is_primary_column?: boolean;
  options?: Record<string, unknown>;
  id?: string;
}

export interface ProjectListItem {
  id: string;
  fields?: Array<{
    column_id?: string;
    link?: Array<{ original_url?: string; originalUrl?: string }>;
  }>;
}

export interface ProjectListClient {
  slackLists: {
    create(input: {
      name: string;
      description_blocks: unknown[];
      schema: ProjectListSchemaColumn[];
      todo_mode: boolean;
    }): Promise<{
      list_id?: string;
      list_metadata?: { schema?: ProjectListSchemaColumn[] };
    }>;
    update(input: {
      id: string;
      name: string;
      description_blocks: unknown[];
      todo_mode: boolean;
    }): Promise<unknown>;
    access: {
      set(input: {
        list_id: string;
        access_level: "read";
        channel_ids?: string[];
        user_ids?: string[];
      }): Promise<unknown>;
    };
    items: {
      list(input: { list_id: string; limit: number; cursor?: string }): Promise<{
        items?: ProjectListItem[];
        response_metadata?: { next_cursor?: string };
      }>;
      create(input: {
        list_id: string;
        initial_fields: Array<Record<string, unknown>>;
      }): Promise<{ item?: { id?: string } }>;
      update(input: { list_id: string; cells: Array<Record<string, unknown>> }): Promise<unknown>;
      deleteMultiple(input: { list_id: string; ids: string[] }): Promise<unknown>;
    };
  };
}

export interface ProjectListSyncResult {
  listId: string;
  itemCount: number;
  created: number;
  updated: number;
  deleted: number;
}

export type ResolveSlackUserId = (githubLogin: string) => Promise<string | null>;

const projectListColumnKeys: ProjectListColumnKey[] = [
  "task",
  "assignee",
  "target_date",
  "status",
  "github",
];

export const projectListSchema: ProjectListSchemaColumn[] = [
  { key: "task", name: "タスク", type: "text", is_primary_column: true },
  {
    key: "assignee",
    name: "担当者",
    type: "user",
    options: { format: "single_entity", show_member_name: true, notify_users: false },
  },
  { key: "target_date", name: "期限", type: "date", options: { date_format: "YYYY/MM/DD" } },
  {
    key: "status",
    name: "状態",
    type: "select",
    options: {
      format: "single_select",
      choices: [
        { value: "blocked", label: "ブロック中", color: "red" },
        { value: "urgent-unstarted", label: "未着手・緊急", color: "orange" },
        { value: "in-review", label: "レビュー中", color: "purple" },
        { value: "in-progress", label: "進行中", color: "blue" },
        { value: "todo", label: "着手待ち", color: "yellow" },
        { value: "triage", label: "受付", color: "gray" },
        { value: "done", label: "完了", color: "green" },
      ],
    },
  },
  { key: "github", name: "詳細", type: "link" },
];

export async function createProjectList(
  client: ProjectListClient,
  channelId: string,
  requesterUserId?: string,
): Promise<ProjectListState> {
  assertChannelId(channelId);
  const response = await client.slackLists.create({
    name: "ART-TRA Work",
    description_blocks: projectListDescription(),
    schema: projectListSchema,
    todo_mode: true,
  });
  const listId = response.list_id;
  if (!listId || !/^F[A-Z0-9]+$/.test(listId)) {
    throw new Error("Slack Listの作成結果に有効なlist_idがありません。");
  }
  const columns = columnsFromSchema(response.list_metadata?.schema ?? []);
  await client.slackLists.access.set({
    list_id: listId,
    access_level: "read",
    channel_ids: [channelId],
  });
  if (requesterUserId) {
    await client.slackLists.access.set({
      list_id: listId,
      access_level: "read",
      user_ids: [requesterUserId],
    });
  }
  return { schemaVersion: 2, listId, columns };
}

export async function ensureProjectListDefinition(
  client: ProjectListClient,
  listId: string,
): Promise<void> {
  await client.slackLists.update({
    id: listId,
    name: "ART-TRA Work",
    description_blocks: projectListDescription(),
    todo_mode: true,
  });
}

export async function markLegacyProjectList(
  client: ProjectListClient,
  listId: string,
): Promise<void> {
  await client.slackLists.update({
    id: listId,
    name: "ART-TRA Work（旧表示）",
    description_blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "新しい読みやすいListへ移行済みです。このListは履歴確認のため残しています。",
        },
      },
    ],
    todo_mode: true,
  });
}

export async function syncProjectList(
  client: ProjectListClient,
  state: ProjectListState,
  items: HumanWorkItem[],
  resolveSlackUserId: ResolveSlackUserId,
): Promise<ProjectListSyncResult> {
  assertState(state);
  const active = items.filter((item) => item.delivery !== "silent");
  const existing = await listAllItems(client, state.listId);
  const rowsByUrl = new Map<string, ProjectListItem>();
  const rowsToDelete: string[] = [];
  for (const row of existing) {
    const url = githubUrl(row, state.columns.github);
    if (!url) continue;
    if (rowsByUrl.has(url)) {
      rowsToDelete.push(row.id);
    } else {
      rowsByUrl.set(url, row);
    }
  }

  const desiredUrls = new Set(active.map((item) => item.url));
  for (const [url, row] of rowsByUrl) {
    if (!desiredUrls.has(url)) rowsToDelete.push(row.id);
  }

  const cells: Array<Record<string, unknown>> = [];
  let created = 0;
  let updated = 0;
  for (const item of active) {
    const fields = await projectListFields(item, state.columns, resolveSlackUserId);
    const existingRow = rowsByUrl.get(item.url);
    if (existingRow && !rowsToDelete.includes(existingRow.id)) {
      cells.push(...fields.map((field) => ({ ...field, row_id: existingRow.id })));
      updated += 1;
    } else {
      const response = await client.slackLists.items.create({
        list_id: state.listId,
        initial_fields: fields,
      });
      if (!response.item?.id) {
        throw new Error(`Slack ListへIssue #${item.issueNumber}を追加できませんでした。`);
      }
      created += 1;
    }
  }
  for (const batch of chunks(cells, 100)) {
    await client.slackLists.items.update({ list_id: state.listId, cells: batch });
  }
  for (const batch of chunks(rowsToDelete, 100)) {
    await client.slackLists.items.deleteMultiple({ list_id: state.listId, ids: batch });
  }
  return {
    listId: state.listId,
    itemCount: active.length,
    created,
    updated,
    deleted: rowsToDelete.length,
  };
}

async function projectListFields(
  item: HumanWorkItem,
  columns: ProjectListColumns,
  resolveSlackUserId: ResolveSlackUserId,
): Promise<Array<Record<string, unknown>>> {
  const slackUserId = item.owner ? await resolveSlackUserId(item.owner) : null;
  return [
    textField(
      columns.task,
      `${item.priority === "P2" ? "" : `[${item.priority}] `}${repositoryLabel(item.url)}#${item.issueNumber} ${item.title}`,
    ),
    { column_id: columns.assignee, user: slackUserId ? [slackUserId] : [] },
    { column_id: columns.target_date, date: item.targetDate ? [item.targetDate] : [] },
    { column_id: columns.status, select: [item.status] },
    {
      column_id: columns.github,
      link: [{ original_url: item.url, display_as_url: false, display_name: "Issueを開く" }],
    },
  ];
}

function textField(columnId: string, value: string): Record<string, unknown> {
  return { column_id: columnId, rich_text: richText(value) };
}

function richText(value: string): unknown[] {
  return [
    {
      type: "rich_text",
      elements: [{ type: "rich_text_section", elements: [{ type: "text", text: value }] }],
    },
  ];
}

function projectListDescription(): unknown[] {
  return richText(
    "GitHub Projectsの閲覧用投影です。状態・担当・優先度・期限はProjectsで更新します。",
  );
}

async function listAllItems(client: ProjectListClient, listId: string): Promise<ProjectListItem[]> {
  const items: ProjectListItem[] = [];
  let cursor: string | undefined;
  do {
    const response = await client.slackLists.items.list({
      list_id: listId,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    items.push(...(response.items ?? []));
    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return items;
}

function githubUrl(item: ProjectListItem, githubColumnId: string): string | null {
  const field = item.fields?.find((candidate) => candidate.column_id === githubColumnId);
  return field?.link?.[0]?.original_url ?? field?.link?.[0]?.originalUrl ?? null;
}

function columnsFromSchema(schema: ProjectListSchemaColumn[]): ProjectListColumns {
  const entries = projectListColumnKeys.map((key) => {
    const id = schema.find((column) => column.key === key)?.id;
    if (!id || !/^Col[A-Z0-9]+$/i.test(id)) {
      throw new Error(`Slack Listの列IDを取得できません: ${key}`);
    }
    return [key, id] as const;
  });
  return Object.fromEntries(entries) as ProjectListColumns;
}

function repositoryLabel(url: string): string {
  try {
    return new URL(url).pathname.split("/")[2] || "repository";
  } catch {
    return "repository";
  }
}

function assertChannelId(channelId: string): void {
  if (!/^[CG][A-Z0-9]+$/.test(channelId)) {
    throw new Error("Slack channel IDが不正です。");
  }
}

function assertState(state: ProjectListState): void {
  if (state.schemaVersion !== 2 || !/^F[A-Z0-9]+$/.test(state.listId)) {
    throw new Error("Slack Listの保存状態が不正です。");
  }
  columnsFromSchema(
    Object.entries(state.columns).map(([key, id]) => ({ key, id, name: key, type: "text" })),
  );
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
