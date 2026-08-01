import type { CreateIssueCommand } from "./types.ts";

export interface CreateIssueInput {
  issueType: CreateIssueCommand["issueType"];
  title: string;
  purpose: string;
  completionConditions: string;
  actor: string;
}

export function buildCreateIssueCommand(input: CreateIssueInput): CreateIssueCommand {
  const title = input.title.trim();
  const purpose = input.purpose.trim();
  if (title.length === 0) {
    throw new Error("Issueのタイトルを入力してください");
  }
  if (purpose.length === 0) {
    throw new Error("Issueの目的を入力してください");
  }

  return {
    schemaVersion: 1,
    kind: "issue.create",
    issueType: input.issueType,
    title,
    purpose,
    completionConditions: input.completionConditions
      .split("\n")
      .map((line) => line.trim().replace(/^[-*]\s*/, ""))
      .filter(Boolean),
    actor: input.actor,
  };
}
