import {
  matchesRepositoryScope,
  type RepositoryScope,
  repositoryFromUrl,
} from "./project-scope.ts";
import type { Priority, WorkItemSnapshot, WorkStatus } from "./types.ts";

export const PROJECT_ISSUES_QUERY = `
query ArttraWorkItems($owner: String!, $name: String!, $limit: Int!, $assignee: String) {
  repository(owner: $owner, name: $name) {
    issues(first: $limit, states: OPEN, filterBy: {assignee: $assignee}, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        url
        repository { nameWithOwner }
        labels(first: 20) { nodes { name } }
        assignees(first: 10) { nodes { login } }
        blockedBy(first: 20) { nodes { number title url state } }
        closedByPullRequestsReferences(first: 10, includeClosedPrs: false) {
          nodes {
            number
            url
            state
            mergeable
            reviewRequests(first: 20) {
              nodes { requestedReviewer { ... on User { login } } }
            }
            commits(last: 1) {
              nodes { commit { statusCheckRollup { state } } }
            }
          }
        }
        projectItems(first: 10) {
          nodes {
            fieldValues(first: 30) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field { ... on ProjectV2FieldCommon { name } }
                }
                ... on ProjectV2ItemFieldDateValue {
                  date
                  field { ... on ProjectV2FieldCommon { name } }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

export const ORGANIZATION_PROJECT_ITEMS_QUERY = `
query ArttraOrganizationProjectItems($owner: String!, $number: Int!, $limit: Int!, $cursor: String) {
  organization(login: $owner) {
    projectV2(number: $number) {
      items(first: $limit, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          fieldValues(first: 30) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2FieldCommon { name } }
              }
              ... on ProjectV2ItemFieldDateValue {
                date
                field { ... on ProjectV2FieldCommon { name } }
              }
            }
          }
          content {
            ... on Issue {
              number
              title
              url
              repository { nameWithOwner }
              state
              labels(first: 20) { nodes { name } }
              assignees(first: 10) { nodes { login } }
              blockedBy(first: 20) { nodes { number title url state } }
              closedByPullRequestsReferences(first: 10, includeClosedPrs: false) {
                nodes {
                  number
                  url
                  state
                  mergeable
                  reviewRequests(first: 20) {
                    nodes { requestedReviewer { ... on User { login } } }
                  }
                  commits(last: 1) {
                    nodes { commit { statusCheckRollup { state } } }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

export interface ProjectIssueNode {
  number: number;
  title: string;
  url: string;
  repository?: { nameWithOwner?: string | null } | null;
  labels: { nodes: Array<{ name: string }> };
  assignees: { nodes: Array<{ login: string }> };
  blockedBy?: {
    nodes: Array<{ number: number; title: string; url: string; state?: string }>;
  };
  closedByPullRequestsReferences?: {
    nodes: Array<{
      number: number;
      url: string;
      state?: string;
      mergeable?: string;
      reviewRequests?: {
        nodes: Array<{ requestedReviewer?: { login?: string } | null }>;
      };
      commits?: {
        nodes: Array<{ commit?: { statusCheckRollup?: { state?: string } | null } }>;
      };
    }>;
  };
  projectItems: {
    nodes: Array<{
      fieldValues: {
        nodes: Array<{ name?: string; date?: string; field?: { name?: string } }>;
      };
    }>;
  };
}

export interface ProjectIssuesResponse {
  data?: { repository?: { issues?: { nodes?: ProjectIssueNode[] } } | null };
  errors?: Array<{ message?: string }>;
}

interface OrganizationProjectItemNode {
  content?: (Omit<ProjectIssueNode, "projectItems"> & { state?: string }) | null;
  fieldValues: ProjectIssueNode["projectItems"]["nodes"][number]["fieldValues"];
}

export interface OrganizationProjectItemsResponse {
  data?: {
    organization?: {
      projectV2?: {
        items?: {
          nodes?: OrganizationProjectItemNode[];
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        };
      } | null;
    } | null;
  };
  errors?: Array<{ message?: string }>;
}

export interface OrganizationProjectIssuePage {
  issues: ProjectIssueNode[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export function projectIssueNodes(response: ProjectIssuesResponse): ProjectIssueNode[] {
  throwGraphqlErrors(response.errors);
  return response.data?.repository?.issues?.nodes ?? [];
}

export function organizationProjectIssueNodes(
  response: OrganizationProjectItemsResponse,
  projectNumber: number,
  assignee: string | null = null,
  scope?: RepositoryScope,
): ProjectIssueNode[] {
  return organizationProjectIssuePage(response, projectNumber, assignee, scope).issues;
}

export function organizationProjectIssuePage(
  response: OrganizationProjectItemsResponse,
  projectNumber: number,
  assignee: string | null = null,
  scope?: RepositoryScope,
): OrganizationProjectIssuePage {
  throwGraphqlErrors(response.errors);
  const organization = response.data?.organization;
  if (!organization) {
    throw new Error("GitHub Organizationを読み取れませんでした。ownerと権限を確認してください。");
  }
  const project = organization.projectV2;
  if (!project) {
    throw new Error(`GitHub Project #${projectNumber}が見つかりません。`);
  }
  const normalizedAssignee = assignee?.trim().toLowerCase();
  const issues = (project.items?.nodes ?? []).flatMap((item) => {
    const content = item.content;
    if (content?.state?.toUpperCase() !== "OPEN") {
      return [];
    }
    if (
      normalizedAssignee &&
      !content.assignees.nodes.some(
        (candidate) => candidate.login.trim().toLowerCase() === normalizedAssignee,
      )
    ) {
      return [];
    }
    if (
      scope &&
      !matchesRepositoryScope(
        scope,
        content.repository?.nameWithOwner ?? repositoryFromUrl(content.url),
      )
    ) {
      return [];
    }
    return [{ ...content, projectItems: { nodes: [{ fieldValues: item.fieldValues }] } }];
  });
  return {
    issues,
    hasNextPage: project.items?.pageInfo?.hasNextPage ?? false,
    endCursor: project.items?.pageInfo?.endCursor ?? null,
  };
}

export function projectIssueSnapshot(issue: ProjectIssueNode): WorkItemSnapshot {
  const labels = issue.labels.nodes.map((label) => label.name);
  const fields = issue.projectItems.nodes.flatMap((item) => item.fieldValues.nodes);
  return {
    schemaVersion: 1,
    issue: {
      number: issue.number,
      title: issue.title,
      url: issue.url,
      type: issueType(labels),
    },
    repository: issue.repository?.nameWithOwner ?? repositoryFromUrl(issue.url),
    project: {
      status: projectStatus(fieldValue(fields, "Status")) ?? labelStatus(labels) ?? "todo",
      priority: projectPriority(fieldValue(fields, "Priority")) ?? labelPriority(labels) ?? "P2",
      owner: issue.assignees.nodes[0]?.login ?? null,
      targetDate: fieldDate(fields, "Target date"),
    },
    relationships: {
      blockedBy: (issue.blockedBy?.nodes ?? [])
        .filter((item) => !item.state || item.state.toUpperCase() === "OPEN")
        .map((item) => ({ number: item.number, title: item.title, url: item.url })),
    },
    pullRequest: pullRequestSnapshot(issue),
  };
}

function pullRequestSnapshot(issue: ProjectIssueNode): WorkItemSnapshot["pullRequest"] {
  const pullRequest = (issue.closedByPullRequestsReferences?.nodes ?? []).find(
    (candidate) => !candidate.state || candidate.state.toUpperCase() === "OPEN",
  );
  if (!pullRequest) return null;
  const checkState = pullRequest.commits?.nodes.at(-1)?.commit?.statusCheckRollup?.state;
  const checks: NonNullable<WorkItemSnapshot["pullRequest"]>["checks"] =
    checkState === "SUCCESS"
      ? "passed"
      : checkState === "FAILURE" || checkState === "ERROR"
        ? "failed"
        : checkState
          ? "pending"
          : "none";
  const mergeable = pullRequest.mergeable?.toUpperCase();
  return {
    number: pullRequest.number,
    url: pullRequest.url,
    checks,
    mergeState:
      mergeable === "CONFLICTING" ? "conflicting" : mergeable === "MERGEABLE" ? "clean" : "unknown",
    requestedReviewers: (pullRequest.reviewRequests?.nodes ?? []).flatMap((request) =>
      request.requestedReviewer?.login ? [request.requestedReviewer.login] : [],
    ),
  };
}

function issueType(labels: string[]): WorkItemSnapshot["issue"]["type"] {
  if (labels.includes("type/business")) return "business";
  if (labels.includes("type/intake")) return "intake";
  if (labels.includes("type/task")) return "task";
  return "work";
}

function fieldValue(
  fields: Array<{ name?: string; field?: { name?: string } }>,
  fieldName: string,
): string | undefined {
  return fields.find((field) => field.field?.name === fieldName && field.name)?.name;
}

function fieldDate(
  fields: Array<{ date?: string; field?: { name?: string } }>,
  fieldName: string,
): string | null {
  return fields.find((field) => field.field?.name === fieldName && field.date)?.date ?? null;
}

function projectStatus(value?: string): WorkStatus | undefined {
  const statuses: Record<string, WorkStatus> = {
    intake: "triage",
    ready: "todo",
    "urgent (unstarted)": "urgent-unstarted",
    "in progress": "in-progress",
    blocked: "blocked",
    "in review": "in-review",
    done: "done",
  };
  return value ? statuses[value.trim().toLowerCase()] : undefined;
}

function projectPriority(value?: string): Priority | undefined {
  const normalized = value?.trim().toUpperCase();
  return normalized === "P0" || normalized === "P1" || normalized === "P2" || normalized === "P3"
    ? normalized
    : undefined;
}

function labelStatus(labels: string[]): WorkStatus | undefined {
  const values: Record<string, WorkStatus> = {
    "status/triage": "triage",
    "status/todo": "todo",
    "status/urgent-unstarted": "urgent-unstarted",
    "status/in-progress": "in-progress",
    "status/blocked": "blocked",
    "status/in-review": "in-review",
    "status/done": "done",
  };
  return labels.map((label) => values[label]).find((value) => value !== undefined);
}

function labelPriority(labels: string[]): Priority | undefined {
  return labels
    .map((label) => projectPriority(label.startsWith("priority/") ? label.slice(9) : undefined))
    .find((value) => value !== undefined);
}

function throwGraphqlErrors(errors?: Array<{ message?: string }>): void {
  const error = errors
    ?.map((item) => item.message)
    .filter(Boolean)
    .join(" / ");
  if (error) {
    throw new Error(`GitHub Projectsを読み取れませんでした: ${error}`);
  }
}
