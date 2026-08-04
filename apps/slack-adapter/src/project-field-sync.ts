export const PROJECT_FIELD_NAMES = [
  "Priority",
  "Size",
  "Start date",
  "Target date",
  "Status",
] as const;

export type ProjectFieldName = (typeof PROJECT_FIELD_NAMES)[number] | "Assignees";
export type ProjectPriority = "P0" | "P1" | "P2" | "P3";
export type ProjectSize = "S" | "M" | "L" | "XL";
export type ProjectStatus =
  | "Intake"
  | "Ready"
  | "Urgent (unstarted)"
  | "In progress"
  | "Blocked"
  | "In review"
  | "Done";

export interface ProjectFieldInput {
  priority?: ProjectPriority;
  size?: ProjectSize;
  startDate?: string;
  targetDate?: string;
  status?: ProjectStatus;
}

export interface ProjectFieldResult {
  field: ProjectFieldName;
  requested: string | string[];
  actual: string | string[] | null;
  status: "unchanged" | "updated" | "failed";
  message?: string;
}

export interface ProjectFieldSyncResult {
  schemaVersion: 1;
  status: "synced" | "partial" | "failed";
  project: { owner: string; number: number; id: string | null; itemId: string | null };
  issue: { id: string; url: string };
  itemCreated: boolean;
  fields: ProjectFieldResult[];
  recovery: {
    retryable: true;
    operation: "project-field-sync";
    issueUrl: string;
    instructions: string[];
  };
}

export type GraphqlRequest = <T>(query: string, variables: Record<string, unknown>) => Promise<T>;

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

interface ProjectSchemaResponse {
  organization?: {
    projectV2?: {
      id: string;
      fields: {
        totalCount: number;
        nodes: Array<{
          id: string;
          name: string;
          dataType?: string;
          options?: Array<{ id: string; name: string }>;
        } | null>;
      };
    } | null;
  } | null;
  node?: {
    id: string;
    assignees: { nodes: Array<{ login: string } | null> };
    projectItems: {
      totalCount: number;
      nodes: Array<{
        id: string;
        project: { id: string };
        fieldValues: {
          totalCount: number;
          nodes: Array<{
            name?: string | null;
            optionId?: string | null;
            date?: string | null;
            field?: { name?: string | null } | null;
          } | null>;
        };
      } | null>;
    };
  } | null;
}

export const PROJECT_FIELD_STATE_QUERY = `
  query ArttraProjectFieldState($owner: String!, $number: Int!, $issueId: ID!) {
    organization(login: $owner) {
      projectV2(number: $number) {
        id
        fields(first: 100) {
          totalCount
          nodes {
            ... on ProjectV2Field { id name dataType }
            ... on ProjectV2SingleSelectField { id name dataType options { id name } }
          }
        }
      }
    }
    node(id: $issueId) {
      ... on Issue {
        id
        assignees(first: 100) { nodes { login } }
        projectItems(first: 100) {
          totalCount
          nodes {
            id
            project { id }
            fieldValues(first: 100) {
              totalCount
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  optionId
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
`;

const ADD_PROJECT_ITEM_MUTATION = `
  mutation ArttraAddProjectItem($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
      item { id }
    }
  }
`;

const UPDATE_PROJECT_FIELD_MUTATION = `
  mutation ArttraUpdateProjectField(
    $projectId: ID!,
    $itemId: ID!,
    $fieldId: ID!,
    $value: ProjectV2FieldValue!
  ) {
    updateProjectV2ItemFieldValue(
      input: {projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value}
    ) { projectV2Item { id } }
  }
`;

interface SyncProjectFieldsInput {
  request: GraphqlRequest;
  project: { owner: string; number: number };
  issue: { id: string; url: string };
  values: ProjectFieldInput;
  assignees: string[];
}

export function normalizeProjectFieldInput(input: ProjectFieldInput): ProjectFieldInput {
  const normalized: ProjectFieldInput = {};
  if (input.priority !== undefined) {
    if (!["P0", "P1", "P2", "P3"].includes(input.priority)) {
      throw new Error("PriorityはP0、P1、P2、P3から選択してください。");
    }
    normalized.priority = input.priority;
  }
  if (input.size !== undefined) {
    if (!["S", "M", "L", "XL"].includes(input.size)) {
      throw new Error("SizeはS、M、L、XLから選択してください。");
    }
    normalized.size = input.size;
  }
  if (input.status !== undefined) {
    if (
      ![
        "Intake",
        "Ready",
        "Urgent (unstarted)",
        "In progress",
        "Blocked",
        "In review",
        "Done",
      ].includes(input.status)
    ) {
      throw new Error("StatusがProject #8の選択肢と一致しません。");
    }
    normalized.status = input.status;
  }
  if (input.startDate) normalized.startDate = validDate(input.startDate, "Start date");
  if (input.targetDate) normalized.targetDate = validDate(input.targetDate, "Target date");
  return normalized;
}

export function projectFieldEntries(
  values: ProjectFieldInput,
): Array<{ field: (typeof PROJECT_FIELD_NAMES)[number]; value: string; kind: "select" | "date" }> {
  return [
    ...(values.priority
      ? [{ field: "Priority" as const, value: values.priority, kind: "select" as const }]
      : []),
    ...(values.size
      ? [{ field: "Size" as const, value: values.size, kind: "select" as const }]
      : []),
    ...(values.startDate
      ? [{ field: "Start date" as const, value: values.startDate, kind: "date" as const }]
      : []),
    ...(values.targetDate
      ? [{ field: "Target date" as const, value: values.targetDate, kind: "date" as const }]
      : []),
    ...(values.status
      ? [{ field: "Status" as const, value: values.status, kind: "select" as const }]
      : []),
  ];
}

export async function syncProjectFields(
  input: SyncProjectFieldsInput,
): Promise<ProjectFieldSyncResult> {
  const values = normalizeProjectFieldInput(input.values);
  const requested = projectFieldEntries(values);
  const assignees = uniqueLogins(input.assignees);
  const base = {
    schemaVersion: 1 as const,
    project: { ...input.project, id: null, itemId: null },
    issue: input.issue,
    itemCreated: false,
    recovery: recovery(input.issue.url),
  };
  let initial: ProjectSchemaResponse;
  try {
    initial = await state(input);
  } catch (error) {
    return {
      ...base,
      status: "failed",
      fields: failedFields(requested, assignees, message(error)),
    };
  }
  const project = initial.organization?.projectV2;
  const issue = initial.node;
  if (!project || !issue) {
    const reason = !project
      ? `Organization Project ${input.project.owner}#${input.project.number}を読み取れませんでした。Projects read権限と設定を確認してください。`
      : "作成したIssueをGraphQLで読み取れませんでした。";
    return { ...base, status: "failed", fields: failedFields(requested, assignees, reason) };
  }
  const projectBase = { ...base, project: { ...input.project, id: project.id, itemId: null } };
  if (project.fields.totalCount > project.fields.nodes.length) {
    const reason = "Project fieldが100件を超えており、安全にfieldを特定できませんでした。";
    return { ...projectBase, status: "failed", fields: failedFields(requested, assignees, reason) };
  }
  if (issue.projectItems.totalCount > issue.projectItems.nodes.length) {
    const reason =
      "IssueのProject itemが100件を超えており、重複なく対象itemを特定できませんでした。";
    return { ...projectBase, status: "failed", fields: failedFields(requested, assignees, reason) };
  }
  let item =
    issue.projectItems.nodes.find((candidate) => candidate?.project.id === project.id) ?? null;
  let itemCreated = false;
  if (!item) {
    try {
      const added = await unwrap(
        input.request<
          GraphqlEnvelope<{ addProjectV2ItemById?: { item?: { id?: string } | null } | null }>
        >(ADD_PROJECT_ITEM_MUTATION, { projectId: project.id, contentId: input.issue.id }),
      );
      const itemId = added.addProjectV2ItemById?.item?.id;
      if (!itemId) throw new Error("Project item IDを追加応答から読み取れませんでした。");
      item = { id: itemId, project: { id: project.id }, fieldValues: { totalCount: 0, nodes: [] } };
      itemCreated = true;
    } catch (error) {
      return {
        ...projectBase,
        status: "failed",
        fields: failedFields(requested, assignees, message(error)),
      };
    }
  }
  const current = itemValues(item);
  const fieldsByName = new Map(
    project.fields.nodes.flatMap((field) => (field ? [[field.name, field] as const] : [])),
  );
  const results: ProjectFieldResult[] = [];
  for (const entry of requested) {
    if (current.get(entry.field) === entry.value) {
      results.push({
        field: entry.field,
        requested: entry.value,
        actual: entry.value,
        status: "unchanged",
      });
      continue;
    }
    const field = fieldsByName.get(entry.field);
    if (!field) {
      results.push({
        field: entry.field,
        requested: entry.value,
        actual: current.get(entry.field) ?? null,
        status: "failed",
        message: `Project field ${entry.field}が見つかりません。schemaを変更せず管理者へ確認してください。`,
      });
      continue;
    }
    const option =
      entry.kind === "select"
        ? field.options?.find((candidate) => candidate.name === entry.value)
        : null;
    if (entry.kind === "select" && !option) {
      results.push({
        field: entry.field,
        requested: entry.value,
        actual: current.get(entry.field) ?? null,
        status: "failed",
        message: `${entry.field}の選択肢 ${entry.value} がProject schemaにありません。`,
      });
      continue;
    }
    try {
      await unwrap(
        input.request<GraphqlEnvelope<{ updateProjectV2ItemFieldValue?: unknown }>>(
          UPDATE_PROJECT_FIELD_MUTATION,
          {
            projectId: project.id,
            itemId: item.id,
            fieldId: field.id,
            value:
              entry.kind === "select"
                ? { singleSelectOptionId: option?.id }
                : { date: entry.value },
          },
        ),
      );
      results.push({ field: entry.field, requested: entry.value, actual: null, status: "updated" });
    } catch (error) {
      results.push({
        field: entry.field,
        requested: entry.value,
        actual: current.get(entry.field) ?? null,
        status: "failed",
        message: message(error),
      });
    }
  }
  const expectedAssignees = sortedLogins(assignees);
  const initialAssignees = sortedLogins(
    issue.assignees.nodes.flatMap((value) => (value?.login ? [value.login] : [])),
  );
  results.push({
    field: "Assignees",
    requested: expectedAssignees,
    actual: initialAssignees,
    status: sameValues(expectedAssignees, initialAssignees) ? "unchanged" : "failed",
    ...(!sameValues(expectedAssignees, initialAssignees)
      ? {
          message:
            "Issue Assigneeのwrite後read-backが一致しませんでした。Issue権限と入力を確認してください。",
        }
      : {}),
  });

  let verified: ProjectSchemaResponse | null = null;
  try {
    verified = await state(input);
  } catch (error) {
    for (const result of results) {
      if (result.status === "updated") {
        result.status = "failed";
        result.message = `更新後のread-backに失敗しました: ${message(error)}`;
      }
    }
  }
  const verifiedItem = verified?.node?.projectItems.nodes.find(
    (candidate) => candidate?.project.id === project.id,
  );
  const verifiedValues = verifiedItem ? itemValues(verifiedItem) : new Map<string, string>();
  for (const result of results) {
    if (result.field === "Assignees" || result.status === "failed") continue;
    const actual = verifiedValues.get(result.field) ?? null;
    result.actual = actual;
    if (actual !== result.requested) {
      result.status = "failed";
      result.message = "更新後のProject field read-backが入力値と一致しませんでした。";
    }
  }
  const verifiedAssignees = verified?.node
    ? sortedLogins(
        verified.node.assignees.nodes.flatMap((value) => (value?.login ? [value.login] : [])),
      )
    : null;
  const assigneeResult = results.find((result) => result.field === "Assignees");
  if (assigneeResult && verifiedAssignees) {
    assigneeResult.actual = verifiedAssignees;
    if (!sameValues(expectedAssignees, verifiedAssignees)) {
      assigneeResult.status = "failed";
      assigneeResult.message = "Issue Assigneeのwrite後read-backが一致しませんでした。";
    }
  }
  const failures = results.filter((result) => result.status === "failed").length;
  return {
    ...projectBase,
    status: failures === 0 ? "synced" : failures === results.length ? "failed" : "partial",
    project: { ...projectBase.project, itemId: item.id },
    itemCreated,
    fields: results,
  };
}

export function projectFieldSyncFailure(input: {
  project: { owner: string; number: number };
  issue: { id: string; url: string };
  values: ProjectFieldInput;
  assignees: string[];
  message: string;
}): ProjectFieldSyncResult {
  return {
    schemaVersion: 1,
    status: "failed",
    project: { ...input.project, id: null, itemId: null },
    issue: input.issue,
    itemCreated: false,
    fields: failedFields(
      projectFieldEntries(normalizeProjectFieldInput(input.values)),
      uniqueLogins(input.assignees),
      input.message,
    ),
    recovery: recovery(input.issue.url),
  };
}

async function state(input: SyncProjectFieldsInput): Promise<ProjectSchemaResponse> {
  return unwrap(
    input.request<GraphqlEnvelope<ProjectSchemaResponse>>(PROJECT_FIELD_STATE_QUERY, {
      owner: input.project.owner,
      number: input.project.number,
      issueId: input.issue.id,
    }),
  );
}

async function unwrap<T>(response: Promise<GraphqlEnvelope<T>>): Promise<T> {
  const envelope = await response;
  if (envelope.errors?.length) {
    throw new Error(envelope.errors.map((error) => error.message ?? "GraphQL error").join("; "));
  }
  if (!envelope.data) throw new Error("GitHub GraphQL応答にdataがありません。");
  return envelope.data;
}

function itemValues(
  item: NonNullable<ProjectSchemaResponse["node"]>["projectItems"]["nodes"][number],
): Map<string, string> {
  const values = new Map<string, string>();
  if (!item) return values;
  for (const value of item.fieldValues.nodes) {
    const name = value?.field?.name;
    const current = value?.name ?? value?.date;
    if (name && current) values.set(name, current);
  }
  return values;
}

function failedFields(
  requested: ReturnType<typeof projectFieldEntries>,
  assignees: string[],
  reason: string,
): ProjectFieldResult[] {
  return [
    ...requested.map((entry) => ({
      field: entry.field,
      requested: entry.value,
      actual: null,
      status: "failed" as const,
      message: reason,
    })),
    {
      field: "Assignees" as const,
      requested: sortedLogins(assignees),
      actual: null,
      status: "failed" as const,
      message: reason,
    },
  ];
}

function recovery(issueUrl: string): ProjectFieldSyncResult["recovery"] {
  return {
    retryable: true,
    operation: "project-field-sync",
    issueUrl,
    instructions: [
      "Issueは作成済みです。新しいIssueを作らないでください。",
      "Projects write権限とAR_GITHUB_PROJECT_OWNER / AR_GITHUB_PROJECT_NUMBERを確認してください。",
      "同じIssue IDへproject-field-syncを再実行してください。既存itemと同値fieldは再利用されます。",
    ],
  };
}

function validDate(value: string, field: string): string {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized))
    throw new Error(`${field}はYYYY-MM-DD形式で指定してください。`);
  const [year, month, day] = normalized.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 0));
  if (date.toISOString().slice(0, 10) !== normalized)
    throw new Error(`${field}に実在する日付を指定してください。`);
  return normalized;
}

function uniqueLogins(values: string[]): string[] {
  const result = new Map<string, string>();
  for (const value of values) {
    const normalized = value.trim();
    if (normalized) result.set(normalized.toLowerCase(), normalized);
  }
  return [...result.values()];
}

function sortedLogins(values: string[]): string[] {
  return uniqueLogins(values).sort((left, right) =>
    left.toLowerCase().localeCompare(right.toLowerCase()),
  );
}

function sameValues(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value.toLowerCase() === right[index]?.toLowerCase())
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "GitHub Project field同期に失敗しました。";
}
