import { describe, expect, test } from "bun:test";
import { canApproveIssue, canBypassIssueApproval, requiresIssueApproval } from "../src/approval.ts";
import type { CreateIssueCommand } from "../src/types.ts";

function command(merge: string): CreateIssueCommand {
  return {
    schemaVersion: 1,
    kind: "issue.create",
    repository: "example/repo",
    template: "work",
    title: "test",
    fields: { merge },
    actor: "U_REQUESTER",
  };
}

describe("Issue approval policy", () => {
  test("通常レビューは承認を要求しない", () => {
    expect(requiresIssueApproval(command("通常レビュー（既定）"))).toBe(false);
  });

  test("自己マージと緊急マージは承認を要求する", () => {
    expect(requiresIssueApproval(command("自分でマージ可"))).toBe(true);
    expect(requiresIssueApproval(command("緊急マージ（事後レビュー必須）"))).toBe(true);
  });

  test("承認者でも自分の申請は通常承認できない", () => {
    expect(canApproveIssue("U_APPROVER", "U_APPROVER", new Set(["U_APPROVER"]), new Set())).toBe(
      false,
    );
  });

  test("明示された自己承認可能者だけは直通できる", () => {
    const selfApprovers = new Set(["U_PL"]);
    expect(canBypassIssueApproval("U_PL", selfApprovers)).toBe(true);
    expect(canApproveIssue("U_PL", "U_PL", new Set(), selfApprovers)).toBe(true);
  });
});
