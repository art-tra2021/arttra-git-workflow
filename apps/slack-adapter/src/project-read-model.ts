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

export function projectIssueNodes(response: ProjectIssuesResponse): ProjectIssueNode[] {
  const error = response.errors
    ?.map((item) => item.message)
    .filter(Boolean)
    .join(" / ");
  if (error) {
    throw new Error(`GitHub Projectsを読み取れませんでした: ${error}`);
  }
  return response.data?.repository?.issues?.nodes ?? [];
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
