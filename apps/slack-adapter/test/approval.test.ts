import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canApproveIssue,
  canBypassIssueApproval,
  decidePrivilegedMerge,
  IssueApprovalService,
  requiresIssueApproval,
} from "../src/approval.ts";
import { LocalStateStore } from "../src/state-store.ts";
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

  test("自己承認可能者は直通できるが承認待ちを自己承認しない", () => {
    const selfApprovers = new Set(["U_PL"]);
    expect(canBypassIssueApproval("U_PL", selfApprovers)).toBe(true);
    expect(canApproveIssue("U_PL", "U_PL", new Set(), selfApprovers)).toBe(false);
    expect(canApproveIssue("U_MEMBER", "U_PL", new Set(), selfApprovers)).toBe(true);
  });

  test("本人マージはSlack設定とGitHub write権限の両方がある場合だけ直通する", () => {
    const selfApprovers = new Set(["U_PL"]);
    expect(decidePrivilegedMerge("U_PL", selfApprovers, "pl", "write")).toMatchObject({
      direct: true,
    });
    expect(decidePrivilegedMerge("U_MEMBER", selfApprovers, "member", "write")).toMatchObject({
      direct: false,
      reason: expect.stringContaining("直接指定する権限"),
    });
    expect(decidePrivilegedMerge("U_PL", selfApprovers, "pl", "read")).toMatchObject({
      direct: false,
      reason: expect.stringContaining("read"),
    });
    expect(decidePrivilegedMerge("U_PL", selfApprovers, null, "none")).toMatchObject({
      direct: false,
      reason: expect.stringContaining("/ar connect github"),
    });
  });
});

describe("IssueApprovalService", () => {
  test("再起動相当の別serviceから承認待ちを復元して完了する", async () => {
    const root = await mkdtemp(join(tmpdir(), "arttra-approval-"));
    const first = service(root);
    const requested = await first.request(privilegedCommand(), "U_REQUESTER");
    const second = service(root);
    expect((await second.status(requested.id))?.status).toBe("pending");

    const approved = await second.approve(
      requested.id,
      "U_APPROVER",
      policy(),
      async () => {},
      async () => ({ number: 27, title: "永続化", url: "https://example.test/issues/27" }),
    );
    expect(approved.status).toBe("approved");
    expect(approved.issue?.number).toBe(27);
    const auditDirectory = join(root, Buffer.from("issue-approval-audit").toString("base64url"));
    expect(await readdir(auditDirectory)).toHaveLength(3);
  });

  test("明示されていない申請者本人の承認を拒否する", async () => {
    const root = await mkdtemp(join(tmpdir(), "arttra-approval-"));
    const approvals = service(root);
    const requested = await approvals.request(privilegedCommand(), "U_APPROVER");
    expect(
      approvals.approve(
        requested.id,
        "U_APPROVER",
        policy(),
        async () => {},
        async () => ({ number: 1, title: "nope", url: "https://example.test/1" }),
      ),
    ).rejects.toThrow("権限がありません");
  });

  test("申請後に自己承認設定へ変わっても本人承認を拒否する", async () => {
    const root = await mkdtemp(join(tmpdir(), "arttra-approval-"));
    const approvals = service(root);
    const requested = await approvals.request(privilegedCommand(), "U_PL");
    expect(
      approvals.approve(
        requested.id,
        "U_PL",
        { approvers: new Set(), selfApprovers: new Set(["U_PL"]) },
        async () => {},
        async () => ({ number: 1, title: "nope", url: "https://example.test/1" }),
      ),
    ).rejects.toThrow("権限がありません");
    expect((await approvals.status(requested.id))?.status).toBe("pending");
  });

  test("期限を過ぎた申請を永続的にexpiredへ遷移する", async () => {
    const root = await mkdtemp(join(tmpdir(), "arttra-approval-"));
    let now = Date.parse("2026-08-01T00:00:00Z");
    const approvals = new IssueApprovalService(new LocalStateStore(root), {
      ttlMilliseconds: 60_000,
      now: () => now,
      id: () => "A-EXPIRE",
    });
    await approvals.request(privilegedCommand(), "U_REQUESTER");
    now += 60_001;
    expect((await approvals.status("A-EXPIRE"))?.status).toBe("expired");
    expect((await service(root).status("A-EXPIRE"))?.status).toBe("expired");
  });

  test("同時承認でもIssueを一度だけ作成する", async () => {
    const root = await mkdtemp(join(tmpdir(), "arttra-approval-"));
    const approvals = service(root);
    const requested = await approvals.request(privilegedCommand(), "U_REQUESTER");
    let creates = 0;
    const attempt = () =>
      approvals.approve(
        requested.id,
        "U_APPROVER",
        policy(),
        async () => {},
        async () => {
          creates += 1;
          return { number: 27, title: "永続化", url: "https://example.test/issues/27" };
        },
      );
    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(creates).toBe(1);
  });
});

function service(root: string): IssueApprovalService {
  return new IssueApprovalService(new LocalStateStore(root), {
    now: () => Date.parse("2026-08-01T00:00:00Z"),
    id: () => "A-PERSIST",
  });
}

function policy() {
  return {
    approvers: new Set(["U_APPROVER"]),
    selfApprovers: new Set<string>(),
  };
}

function privilegedCommand(): CreateIssueCommand {
  return command("自分でマージ可");
}
