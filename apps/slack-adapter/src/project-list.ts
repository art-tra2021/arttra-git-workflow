import {
  filterItemsByRepositoryScope,
  type ProjectionBinding,
  type ProjectionTarget,
  projectionStateKey,
  type RepositoryScope,
  validateProjectionBinding,
} from "./project-scope.ts";
import type { HumanWorkItem } from "./types.ts";

export type ProjectListColumnKey = "task" | "status" | "assignee" | "target_date" | "github";

export type ProjectListColumns = Record<ProjectListColumnKey, string>;

export interface ProjectListState {
  schemaVersion: 3;
  listId: string;
  columns: ProjectListColumns;
  /** Optional on legacy state; present for repository/viewer-scoped state. */
  binding?: ProjectionBinding;
  stateKey?: string;
}

export interface ProjectListProjectionOptions {
  teamId: string;
  viewerId?: string | null;
  scope: RepositoryScope;
  target?: ProjectionTarget;
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
    text?: string;
    rich_text?: unknown[];
    user?: string[];
    date?: string[];
    select?: string[];
    link?: Array<{
      original_url?: string;
      originalUrl?: string;
      display_as_url?: boolean;
      displayAsUrl?: boolean;
      display_name?: string;
      displayName?: string;
    }>;
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
      delete?(input: {
        list_id: string;
        channel_ids?: string[];
        user_ids?: string[];
      }): Promise<unknown>;
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

const projectListColumnKeys: Record<ProjectListColumnKey, string> = {
  task: "task",
  assignee: "todo_assignee",
  target_date: "todo_due_date",
  status: "status",
  github: "github",
};

export const projectListSchema: ProjectListSchemaColumn[] = [
  { key: "task", name: "タスク", type: "text", is_primary_column: true },
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
  options?: ProjectListProjectionOptions,
): Promise<ProjectListState> {
  const binding = options
    ? validateProjectionBinding({
        teamId: options.teamId,
        viewerId: options.viewerId ?? requesterUserId ?? null,
        target: options.target ?? { kind: "channel", id: channelId },
        kind: "list",
        scope: options.scope,
      })
    : undefined;
  if (!binding || binding.target.kind === "channel") {
    assertChannelId(channelId);
  }
  if (binding?.target.kind === "channel" && binding.target.id !== channelId) {
    throw new Error("Project Listのchannel投影先が同期channelと一致しません。");
  }
  const response = await client.slackLists.create({
    name: "仕事一覧",
    description_blocks: projectListDescription(),
    schema: projectListSchema,
    todo_mode: true,
  });
  const listId = response.list_id;
  if (!listId || !/^F[A-Z0-9]+$/.test(listId)) {
    throw new Error("Slack Listの作成結果に有効なlist_idがありません。");
  }
  const columns = columnsFromSchema(response.list_metadata?.schema ?? []);
  if (binding?.target.kind === "user") {
    await client.slackLists.access.set({
      list_id: listId,
      access_level: "read",
      user_ids: [binding.target.id],
    });
  } else {
    await client.slackLists.access.set({
      list_id: listId,
      access_level: "read",
      channel_ids: [channelId],
    });
    // Preserve the legacy one-off sharing behavior.  Scoped user projections
    // use the binding above and do not need a duplicate ACL call.
    if (requesterUserId && !binding) {
      await client.slackLists.access.set({
        list_id: listId,
        access_level: "read",
        user_ids: [requesterUserId],
      });
    }
  }
  return {
    schemaVersion: 3,
    listId,
    columns,
    ...(binding ? { binding, stateKey: projectionStateKey(binding) } : {}),
  };
}

export async function ensureProjectListDefinition(
  client: ProjectListClient,
  listId: string,
): Promise<void> {
  await client.slackLists.update({
    id: listId,
    name: "仕事一覧",
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
    description_blocks: richText(
      "新しい読みやすいListへ移行済みです。このListは履歴確認のため残しています。",
    ),
    todo_mode: true,
  });
}

/**
 * 旧共有Listから、現在のscopeでは公開できない行が残り続けることを防ぐ。
 * List本体は監査用に残し、行だけを空にする。
 */
export async function clearProjectListItems(
  client: ProjectListClient,
  listId: string,
): Promise<number> {
  const ids = (await listAllItems(client, listId)).map((item) => item.id);
  for (const batch of chunks(ids, 100)) {
    await client.slackLists.items.deleteMultiple({ list_id: listId, ids: batch });
  }
  return ids.length;
}

export async function syncProjectList(
  client: ProjectListClient,
  state: ProjectListState,
  items: HumanWorkItem[],
  resolveSlackUserId: ResolveSlackUserId,
  scope?: RepositoryScope,
): Promise<ProjectListSyncResult> {
  assertState(state);
  const effectiveScope = scope ?? state.binding?.scope;
  const active = (
    effectiveScope ? filterItemsByRepositoryScope(items, effectiveScope) : items
  ).filter((item) => item.delivery !== "silent");
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
      const changedFields = fields.filter((field) => !sameFieldValue(existingRow, field));
      if (changedFields.length > 0) {
        cells.push(...changedFields.map((field) => ({ ...field, row_id: existingRow.id })));
        updated += 1;
      }
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

function sameFieldValue(row: ProjectListItem, desired: Record<string, unknown>): boolean {
  const columnId = desired.column_id;
  if (typeof columnId !== "string") return false;
  const current = row.fields?.find((field) => field.column_id === columnId);
  if (!current) return false;

  if ("rich_text" in desired) {
    return current.text === richTextPlainText(desired.rich_text);
  }
  if ("user" in desired) {
    return sameStringArray(current.user, desired.user);
  }
  if ("date" in desired) {
    return sameStringArray(current.date, desired.date);
  }
  if ("select" in desired) {
    return sameStringArray(current.select, desired.select);
  }
  if ("link" in desired) {
    const currentLink = current.link?.[0];
    const desiredLink = Array.isArray(desired.link) ? desired.link[0] : undefined;
    if (!currentLink || !desiredLink || typeof desiredLink !== "object") return false;
    const value = desiredLink as Record<string, unknown>;
    return (
      (currentLink.original_url ?? currentLink.originalUrl) ===
        (value.original_url ?? value.originalUrl) &&
      (currentLink.display_as_url ?? currentLink.displayAsUrl ?? false) ===
        (value.display_as_url ?? value.displayAsUrl ?? false) &&
      (currentLink.display_name ?? currentLink.displayName ?? "") ===
        (value.display_name ?? value.displayName ?? "")
    );
  }
  return false;
}

function sameStringArray(current: string[] | undefined, desired: unknown): boolean {
  if (!Array.isArray(desired) || !desired.every((value) => typeof value === "string")) {
    return false;
  }
  const left = [...(current ?? [])].sort();
  const right = [...desired].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function richTextPlainText(value: unknown): string {
  if (Array.isArray(value)) return value.map(richTextPlainText).join("");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  return richTextPlainText(record.elements);
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
  const entries = Object.entries(projectListColumnKeys).map(([stateKey, slackKey]) => {
    const id = schema.find((column) => column.key === slackKey)?.id;
    if (!id || !/^Col[A-Z0-9]+$/i.test(id)) {
      throw new Error(`Slack Listの列IDを取得できません: ${slackKey}`);
    }
    return [stateKey, id] as const;
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
  if (state.schemaVersion !== 3 || !/^F[A-Z0-9]+$/.test(state.listId)) {
    throw new Error("Slack Listの保存状態が不正です。");
  }
  columnsFromSchema(
    Object.entries(state.columns).map(([key, id]) => ({
      key: projectListColumnKeys[key as ProjectListColumnKey],
      id,
      name: key,
      type: "text",
    })),
  );
  if (state.binding) {
    const key = projectionStateKey(state.binding);
    if (state.stateKey && state.stateKey !== key) {
      throw new Error("Slack Listの保存state keyが投影bindingと一致しません。");
    }
  }
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
