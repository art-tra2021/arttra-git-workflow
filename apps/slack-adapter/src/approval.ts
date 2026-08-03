import { randomUUID } from "node:crypto";
import type { StateStore } from "./state-store.ts";
import type { CreatedIssue, CreateIssueCommand, RepositoryPermission } from "./types.ts";

const APPROVAL_REQUIRED_MERGE_MODES = new Set(["緊急マージ（事後レビュー必須）"]);
const APPROVAL_NAMESPACE = "issue-approval";
const AUDIT_NAMESPACE = "issue-approval-audit";

export type IssueApprovalStatus = "pending" | "processing" | "approved" | "rejected" | "expired";

export interface IssueApproval {
  schemaVersion: 1;
  id: string;
  revision: number;
  status: IssueApprovalStatus;
  command: CreateIssueCommand;
  requester: string;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  issue: CreatedIssue | null;
}

export interface IssueApprovalAuditEvent {
  schemaVersion: 1;
  approvalId: string;
  action: "requested" | "processing" | "approved" | "rejected" | "expired" | "failed";
  actor: string;
  at: string;
  repository: string;
  detail: string | null;
}

export interface ApprovalPolicy {
  approvers: ReadonlySet<string>;
  selfApprovers: ReadonlySet<string>;
}

export interface IssueApprovalServiceOptions {
  ttlMilliseconds?: number;
  now?: () => number;
  id?: () => string;
}

export class IssueApprovalService {
  private readonly store: StateStore;
  private readonly ttlMilliseconds: number;
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(store: StateStore, options: IssueApprovalServiceOptions = {}) {
    this.store = store;
    this.ttlMilliseconds = options.ttlMilliseconds ?? 24 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
    if (!Number.isSafeInteger(this.ttlMilliseconds) || this.ttlMilliseconds < 60_000) {
      throw new Error("Issue承認の有効期限は1分以上で指定してください。");
    }
  }

  async request(command: CreateIssueCommand, requester: string): Promise<IssueApproval> {
    const createdAt = new Date(this.now()).toISOString();
    const approval: IssueApproval = {
      schemaVersion: 1,
      id: this.id(),
      revision: 1,
      status: "pending",
      command,
      requester,
      createdAt,
      expiresAt: new Date(this.now() + this.ttlMilliseconds).toISOString(),
      resolvedAt: null,
      resolvedBy: null,
      issue: null,
    };
    if (!(await this.store.create(APPROVAL_NAMESPACE, approval.id, approval))) {
      throw new Error("Issue承認IDが重複しました。もう一度申請してください。");
    }
    await this.audit(approval, "requested", requester, null);
    return approval;
  }

  async status(id: string): Promise<IssueApproval | null> {
    const approval = await this.store.get<IssueApproval>(APPROVAL_NAMESPACE, id);
    if (approval === null) {
      return null;
    }
    if (approval.status !== "pending" || !this.isExpired(approval)) {
      return approval;
    }
    const expired = this.transition(approval, "expired", "system");
    if (await this.store.compareAndSet(APPROVAL_NAMESPACE, id, approval.revision, expired)) {
      await this.audit(expired, "expired", "system", null);
      return expired;
    }
    return this.store.get<IssueApproval>(APPROVAL_NAMESPACE, id);
  }

  async reject(id: string, actor: string, policy: ApprovalPolicy): Promise<IssueApproval> {
    const approval = await this.pending(id);
    this.assertCanDecide(approval, actor, policy);
    const rejected = this.transition(approval, "rejected", actor);
    if (!(await this.store.compareAndSet(APPROVAL_NAMESPACE, id, approval.revision, rejected))) {
      throw new Error("この承認申請は他の操作で更新されました。状態を再確認してください。");
    }
    await this.audit(rejected, "rejected", actor, null);
    return rejected;
  }

  async approve(
    id: string,
    actor: string,
    policy: ApprovalPolicy,
    revalidate: (command: CreateIssueCommand) => Promise<void>,
    createIssue: (command: CreateIssueCommand) => Promise<CreatedIssue>,
  ): Promise<IssueApproval> {
    const approval = await this.pending(id);
    this.assertCanDecide(approval, actor, policy);
    await revalidate(approval.command);
    const processing: IssueApproval = {
      ...approval,
      revision: approval.revision + 1,
      status: "processing",
      resolvedBy: actor,
    };
    if (!(await this.store.compareAndSet(APPROVAL_NAMESPACE, id, approval.revision, processing))) {
      throw new Error("この承認申請は他の操作で更新されました。状態を再確認してください。");
    }
    await this.audit(processing, "processing", actor, null);
    try {
      const issue = await createIssue(processing.command);
      const approved: IssueApproval = {
        ...processing,
        revision: processing.revision + 1,
        status: "approved",
        resolvedAt: new Date(this.now()).toISOString(),
        issue,
      };
      if (
        !(await this.store.compareAndSet(APPROVAL_NAMESPACE, id, processing.revision, approved))
      ) {
        throw new Error("Issue作成後の承認状態を確定できませんでした。管理者へ連絡してください。");
      }
      await this.audit(approved, "approved", actor, `issue:${issue.number}`);
      return approved;
    } catch (error) {
      const retryable: IssueApproval = {
        ...processing,
        revision: processing.revision + 1,
        status: "pending",
        resolvedBy: null,
      };
      await this.store.compareAndSet(APPROVAL_NAMESPACE, id, processing.revision, retryable);
      await this.audit(
        retryable,
        "failed",
        actor,
        error instanceof Error ? error.message : "Issue作成失敗",
      );
      throw error;
    }
  }

  private async pending(id: string): Promise<IssueApproval> {
    const approval = await this.status(id);
    if (!approval) {
      throw new Error("この承認申請は見つかりません。再申請してください。");
    }
    if (approval.status !== "pending") {
      throw new Error(`この承認申請は${approvalStatusLabel(approval.status)}です。`);
    }
    return approval;
  }

  private assertCanDecide(approval: IssueApproval, actor: string, policy: ApprovalPolicy): void {
    if (!canApproveIssue(approval.requester, actor, policy.approvers, policy.selfApprovers)) {
      throw new Error("この申請を承認・却下する権限がありません。");
    }
  }

  private transition(
    approval: IssueApproval,
    status: "rejected" | "expired",
    actor: string,
  ): IssueApproval {
    return {
      ...approval,
      revision: approval.revision + 1,
      status,
      resolvedAt: new Date(this.now()).toISOString(),
      resolvedBy: actor,
    };
  }

  private isExpired(approval: IssueApproval): boolean {
    return Date.parse(approval.expiresAt) <= this.now();
  }

  private async audit(
    approval: IssueApproval,
    action: IssueApprovalAuditEvent["action"],
    actor: string,
    detail: string | null,
  ): Promise<void> {
    await this.store.append<IssueApprovalAuditEvent>(AUDIT_NAMESPACE, {
      schemaVersion: 1,
      approvalId: approval.id,
      action,
      actor,
      at: new Date(this.now()).toISOString(),
      repository: approval.command.repository,
      detail,
    });
  }
}

export function requiresIssueApproval(command: CreateIssueCommand): boolean {
  return (
    (command.template === "work" || command.template === "business") &&
    APPROVAL_REQUIRED_MERGE_MODES.has(command.fields.merge ?? "")
  );
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
  return requester !== actor;
}

export function canBypassIssueApproval(
  requester: string,
  selfApprovers: ReadonlySet<string>,
): boolean {
  return selfApprovers.has(requester);
}

export interface PrivilegedMergeDecision {
  direct: boolean;
  reason: string;
}

export function decidePrivilegedMerge(
  requester: string,
  selfApprovers: ReadonlySet<string>,
  githubLogin: string | null,
  permission: RepositoryPermission,
): PrivilegedMergeDecision {
  if (!canBypassIssueApproval(requester, selfApprovers)) {
    return {
      direct: false,
      reason: "この利用者には本人・緊急マージを直接指定する権限が設定されていません。",
    };
  }
  if (!githubLogin) {
    return {
      direct: false,
      reason: "GitHub本人確認が未完了です。`/ar connect github`で連携すると権限を確認できます。",
    };
  }
  if (!["admin", "maintain", "write"].includes(permission)) {
    return {
      direct: false,
      reason: `GitHub @${githubLogin} のrepository権限は ${permission} で、本人・緊急マージの直通条件を満たしません。`,
    };
  }
  return {
    direct: true,
    reason: `GitHub @${githubLogin} の ${permission} 権限とSlackの直通設定を確認しました。`,
  };
}

function approvalStatusLabel(status: IssueApprovalStatus): string {
  const labels: Record<IssueApprovalStatus, string> = {
    pending: "承認待ち",
    processing: "処理中",
    approved: "承認済み",
    rejected: "却下済み",
    expired: "期限切れ",
  };
  return labels[status];
}
