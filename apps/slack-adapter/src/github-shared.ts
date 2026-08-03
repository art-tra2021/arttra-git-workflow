import { parse } from "yaml";
import { ISSUE_RELATIONSHIP_FIELD_IDS } from "./issue-relationships.ts";
import { issueRequesterMarker } from "./issue-requester.ts";
import type { IssueFieldSchema, IssueTemplateSchema } from "./issue-schema.ts";
import type { CreateIssueCommand } from "./types.ts";

interface RawIssueForm {
  name?: string;
  title?: string;
  labels?: string[];
  body?: Array<{
    type?: string;
    id?: string;
    attributes?: { label?: string; options?: string[]; value?: string };
    validations?: { required?: boolean };
  }>;
}

export interface IssueCreateInput {
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
}

export function parseIssueForm(id: string, source: string): IssueTemplateSchema | null {
  const raw = parse(source) as RawIssueForm;
  if (!raw.name || !raw.body) {
    return null;
  }
  const fields = raw.body.flatMap<IssueFieldSchema>((item) => {
    if (!item.id || !item.attributes?.label) {
      return [];
    }
    const kind =
      item.type === "dropdown"
        ? "select"
        : item.type === "textarea"
          ? "textarea"
          : item.type === "input"
            ? "input"
            : null;
    if (!kind) {
      return [];
    }
    return [
      {
        id: item.id,
        label: item.attributes.label,
        kind,
        required: item.validations?.required ?? false,
        ...(item.attributes.options ? { options: item.attributes.options } : {}),
        ...(item.attributes.value ? { initialValue: item.attributes.value } : {}),
      },
    ];
  });
  return {
    id,
    name: raw.name,
    titlePrefix: raw.title ?? "",
    labels: raw.labels ?? [],
    fields,
  };
}

export function buildIssueCreateInput(
  command: CreateIssueCommand,
  schema: IssueTemplateSchema,
): IssueCreateInput {
  const body = [
    ...schema.fields
      .filter(
        (field) =>
          !ISSUE_RELATIONSHIP_FIELD_IDS.has(field.id) &&
          (field.id !== "merge" || command.template === "task"),
      )
      .flatMap((field) => [`## ${field.label}`, "", command.fields[field.id] || "未設定", ""]),
    "## 作成元",
    "",
    "Slack `/ar new`",
    "",
    ...(command.requesterGitHubUser ? [issueRequesterMarker(command.requesterGitHubUser), ""] : []),
    "## 予定レビュワー",
    "",
    `<!-- ar:reviewers:v1 ${JSON.stringify(command.reviewerGitHubUsers ?? [])} -->`,
    (command.reviewerGitHubLogins ?? []).map((login) => `@${login}`).join(" ") || "未設定",
  ].join("\n");
  const labels = schema.labels.filter((label) => !label.startsWith("merge/"));
  if (command.template === "task") {
    const mergeLabel: Record<string, string> = {
      "通常レビュー（既定）": "merge/review",
      自分でマージ可: "merge/self",
      "緊急マージ（事後レビュー必須）": "merge/emergency",
    };
    labels.push(mergeLabel[command.fields.merge ?? ""] ?? "merge/review");
  }
  return {
    title: `${schema.titlePrefix}${command.title}`,
    body,
    labels,
    assignees: command.assigneeGitHubLogins ?? [],
  };
}
