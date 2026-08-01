import type { Priority, WorkItemSnapshot, WorkStatus } from "./types.ts";

export const PROJECT_ISSUES_QUERY = `
query ArttraWorkItems($owner: String!, $name: String!, $limit: Int!, $assignee: String) {
  repository(owner: $owner, name: $name) {
    issues(first: $limit, states: OPEN, filterBy: {assignee: $assignee}, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        url
        labels(first: 20) { nodes { name } }
        assignees(first: 10) { nodes { login } }
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
              state
              labels(first: 20) { nodes { name } }
              assignees(first: 10) { nodes { login } }
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
  labels: { nodes: Array<{ name: string }> };
  assignees: { nodes: Array<{ login: string }> };
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
): ProjectIssueNode[] {
  return organizationProjectIssuePage(response, projectNumber, assignee).issues;
}

export function organizationProjectIssuePage(
  response: OrganizationProjectItemsResponse,
  projectNumber: number,
  assignee: string | null = null,
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
    project: {
      status: projectStatus(fieldValue(fields, "Status")) ?? labelStatus(labels) ?? "todo",
      priority: projectPriority(fieldValue(fields, "Priority")) ?? labelPriority(labels) ?? "P2",
      owner: issue.assignees.nodes[0]?.login ?? null,
      targetDate: fieldDate(fields, "Target date"),
    },
    relationships: { blockedBy: [] },
    pullRequest: null,
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
