import type { IssueTemplateId, IssueTemplateSchema } from "./issue-schema.ts";
import type { CreateIssueCommand } from "./types.ts";

export interface CreateIssueInput {
  repository: string;
  template: IssueTemplateId;
  title: string;
  fields: Record<string, string>;
  actor: string;
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
  const fields = Object.fromEntries(
    schema.fields.map((field) => [field.id, input.fields[field.id]?.trim() ?? ""]),
  );
  for (const field of schema.fields) {
    const value = fields[field.id] ?? "";
    if (field.required && value.length === 0) {
      throw new Error(`${field.label}を入力してください`);
    }
    if (field.kind === "select" && !field.options?.includes(value)) {
      throw new Error(`${field.label}を選択してください`);
    }
  }

  return {
    schemaVersion: 1,
    kind: "issue.create",
    repository,
    template: input.template,
    title,
    fields,
    actor: input.actor,
  };
}
