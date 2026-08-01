import type { CreateIssueCommand } from "./types.ts";

const PRIVILEGED_MERGE_MODES = new Set(["自分でマージ可", "緊急マージ（事後レビュー必須）"]);

export function requiresIssueApproval(command: CreateIssueCommand): boolean {
  return command.template === "work" && PRIVILEGED_MERGE_MODES.has(command.fields.merge ?? "");
}

export function canApproveIssue(
  requester: string,
  actor: string,
  approvers: ReadonlySet<string>,
  selfApprovers: ReadonlySet<string>,
): boolean {
  if (!approvers.has(actor) && !selfApprovers.has(actor)) {
    return false;
  }
  return requester !== actor || selfApprovers.has(actor);
}

export function canBypassIssueApproval(
  requester: string,
  selfApprovers: ReadonlySet<string>,
): boolean {
  return selfApprovers.has(requester);
}
