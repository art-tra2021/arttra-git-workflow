export type WorkStatus =
  | "triage"
  | "todo"
  | "urgent-unstarted"
  | "in-progress"
  | "blocked"
  | "in-review"
  | "done";

export type Priority = "P0" | "P1" | "P2" | "P3";

export type RepositoryPermission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

export interface WorkItemSnapshot {
  schemaVersion: 1;
  issue: {
    number: number;
    title: string;
    url: string;
    type: "intake" | "work" | "task" | "business";
  };
  project: {
    status: WorkStatus;
    priority: Priority;
    owner: string | null;
    targetDate: string | null;
  };
  relationships: {
    blockedBy: Array<{ number: number; title: string; url: string }>;
  };
  pullRequest: {
    number: number;
    url: string;
    checks: "none" | "pending" | "passed" | "failed";
    mergeState: "unknown" | "clean" | "behind" | "conflicting";
    requestedReviewers: string[];
  } | null;
}

export type Delivery = "immediate" | "digest" | "silent";

export interface HumanWorkItem {
  schemaVersion: 1;
  issueNumber: number;
  title: string;
  url: string;
  status: WorkStatus;
  priority: Priority;
  owner: string | null;
  targetDate: string | null;
  delivery: Delivery;
  reasonCode:
    | "BLOCKED"
    | "URGENT_UNASSIGNED"
    | "CHECKS_FAILED"
    | "CONFLICTING"
    | "REVIEW_REQUESTED"
    | "DUE_SOON"
    | "DUE_TODAY"
    | "OVERDUE"
    | "ACTIVE_WORK"
    | "COMPLETED";
  nextActor: string;
  nextAction: string;
  reason: string;
  actions: Array<"claim" | "open-github">;
}

export interface CreateIssueCommand {
  schemaVersion: 1;
  kind: "issue.create";
  repository: string;
  template: string;
  title: string;
  fields: Record<string, string>;
  actor: string;
  slackTeamId?: string;
  assigneeSlackUserIds?: string[];
  reviewerSlackUserIds?: string[];
  assigneeGitHubLogins?: string[];
  reviewerGitHubLogins?: string[];
  reviewerGitHubUsers?: Array<{ id: number; login: string }>;
}

export interface CreatedIssue {
  number: number;
  title: string;
  url: string;
}
