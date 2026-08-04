import {
  hasIssueRelationships,
  ISSUE_RELATIONSHIP_FIELD_IDS,
  type IssueRelationshipInput,
  parseIssueRelationships,
} from "./issue-relationships.ts";
import type { IssueTemplateId, IssueTemplateSchema } from "./issue-schema.ts";
import { normalizeProjectFieldInput, type ProjectFieldInput } from "./project-field-sync.ts";
import type { CreateIssueCommand } from "./types.ts";

export const MERGE_MODES = [
  "通常レビュー（既定）",
  "自分でマージ可",
  "緊急マージ（事後レビュー必須）",
] as const;

export type MergeMode = (typeof MERGE_MODES)[number];

export interface CreateIssueInput {
  repository: string;
  template: IssueTemplateId;
  title: string;
  fields: Record<string, string>;
  actor: string;
  slackTeamId?: string;
  assigneeSlackUserIds?: string[];
  reviewerSlackUserIds?: string[];
  mergeMode?: string;
  relationships?: IssueRelationshipInput;
  projectFields?: ProjectFieldInput;
  schema: IssueTemplateSchema;
}

export function buildCreateIssueCommand(input: CreateIssueInput): CreateIssueCommand {
  const repository = input.repository.trim();
  const title = input.title.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("repositoryを選択してください");
  }
  if (title.length === 0) {
    throw new Error("Issueのタイトルを入力してください");
  }
  const schema = input.schema;
  if (schema.id !== input.template) {
    throw new Error("Issue templateの指定が一致しません");
  }
  const fields: Record<string, string> = Object.fromEntries(
    schema.fields.map((field) => [field.id, input.fields[field.id]?.trim() ?? ""]),
  );
  if (input.template === "task") {
    const mergeMode = (input.mergeMode ?? input.fields.merge ?? MERGE_MODES[0]).trim();
    if (!MERGE_MODES.includes(mergeMode as MergeMode)) {
      throw new Error("PRのマージ方針を選択してください");
    }
    fields.merge = mergeMode;
  } else {
    // 古いrepository templateにmerge項目が残っていても、成果Issueへ方針を持ち込まない。
    delete fields.merge;
  }
  const relationships = parseIssueRelationships(input.relationships, fields, repository);
  if (input.template === "work" || input.template === "business") {
    delete fields.hierarchy;
    if (!relationships.parent) throw new Error("Work / Businessには親Intakeを指定してください");
  }
  for (const field of schema.fields) {
    if (
      ISSUE_RELATIONSHIP_FIELD_IDS.has(field.id) ||
      (field.id === "merge" && input.template !== "task")
    ) {
      continue;
    }
    const value = fields[field.id] ?? "";
    if (field.required && value.length === 0) {
      throw new Error(`${field.label}を入力してください`);
    }
    if (field.kind === "select" && !field.options?.includes(value)) {
      throw new Error(`${field.label}を選択してください`);
    }
  }
  if (input.template === "task" && !relationships.parent) {
    throw new Error("Taskには親Work / Businessを指定してください");
  }

  const command: CreateIssueCommand = {
    schemaVersion: 1,
    kind: "issue.create",
    repository,
    template: input.template,
    title,
    fields,
    actor: input.actor,
    ...(input.slackTeamId ? { slackTeamId: input.slackTeamId } : {}),
    assigneeSlackUserIds: uniqueSlackUserIds(input.assigneeSlackUserIds ?? []),
    reviewerSlackUserIds: uniqueSlackUserIds(input.reviewerSlackUserIds ?? []),
  };
  if (hasIssueRelationships(relationships)) {
    command.relationships = relationships;
  }
  if (input.projectFields) {
    command.projectFields = normalizeProjectFieldInput(input.projectFields);
  }
  return command;
}

function uniqueSlackUserIds(values: string[]): string[] {
  return [
    ...new Set(values.map((value) => value.trim()).filter((value) => /^U[A-Z0-9]+$/.test(value))),
  ];
}
