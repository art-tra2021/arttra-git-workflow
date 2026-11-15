import type { ReqaddProjectItem } from "./reqadd.ts";

/**
 * `/ar reqadd`の入力画面用に、Project #8の未完了Issueを読む。
 * 既存の通知用queryと分け、更新に要るIssue node IDだけを足す（既存queryの形と通知の挙動を変えない）。
 */
export const REQADD_PROJECT_ITEMS_QUERY = `
query ArttraReqaddProjectItems($owner: String!, $number: Int!, $cursor: String) {
  organization(login: $owner) {
    projectV2(number: $number) {
      items(first: 100, after: $cursor) {
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
              id
              number
              title
              url
              state
              repository { nameWithOwner }
              labels(first: 20) { nodes { name } }
              assignees(first: 20) { nodes { login } }
            }
          }
        }
      }
    }
  }
}`;

export interface ReqaddProjectItemsResponse {
  data?: {
    organization?: {
      projectV2?: {
        items?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: Array<{
            fieldValues?: {
              nodes?: Array<{
                name?: string | null;
                date?: string | null;
                field?: { name?: string | null } | null;
              } | null>;
            } | null;
            content?: {
              id?: string;
              number?: number;
              title?: string;
              url?: string;
              state?: string;
              repository?: { nameWithOwner?: string | null } | null;
              labels?: { nodes?: Array<{ name?: string } | null> } | null;
              assignees?: { nodes?: Array<{ login?: string } | null> } | null;
            } | null;
          } | null>;
        } | null;
      } | null;
    } | null;
  };
  errors?: Array<{ message?: string }>;
}

export interface ReqaddProjectItemsPage {
  items: ReqaddProjectItem[];
  hasNextPage: boolean;
  endCursor: string | null;
}

/** 1ページ分の応答から、openのIssueだけを取り出す。 */
export function reqaddProjectItemsPage(
  response: ReqaddProjectItemsResponse,
  projectNumber: number,
): ReqaddProjectItemsPage {
  const error = response.errors
    ?.map((item) => item.message)
    .filter(Boolean)
    .join(" / ");
  if (error) throw new Error(`GitHub Projectsを読み取れませんでした: ${error}`);
  const organization = response.data?.organization;
  if (!organization) {
    throw new Error("GitHub Organizationを読み取れませんでした。ownerと権限を確認してください。");
  }
  const project = organization.projectV2;
  if (!project) throw new Error(`GitHub Project #${projectNumber}が見つかりません。`);
  const items = (project.items?.nodes ?? []).flatMap((node): ReqaddProjectItem[] => {
    const content = node?.content;
    if (
      !content?.id ||
      !content.url ||
      !Number.isSafeInteger(content.number) ||
      content.state?.toUpperCase() !== "OPEN"
    ) {
      return [];
    }
    const fields = node?.fieldValues?.nodes ?? [];
    const labels = (content.labels?.nodes ?? []).flatMap((label) =>
      label?.name ? [label.name] : [],
    );
    return [
      {
        issueNodeId: content.id,
        repository: content.repository?.nameWithOwner ?? repositoryFromIssueUrl(content.url),
        number: content.number as number,
        title: content.title ?? "",
        url: content.url,
        type: issueType(labels),
        assignees: (content.assignees?.nodes ?? []).flatMap((assignee) =>
          assignee?.login ? [assignee.login] : [],
        ),
        status: fields.find((field) => field?.field?.name === "Status" && field.name)?.name ?? null,
        targetDate:
          fields.find((field) => field?.field?.name === "Target date" && field.date)?.date ?? null,
      },
    ];
  });
  return {
    items,
    hasNextPage: project.items?.pageInfo?.hasNextPage ?? false,
    endCursor: project.items?.pageInfo?.endCursor ?? null,
  };
}

function issueType(labels: string[]): ReqaddProjectItem["type"] {
  if (labels.includes("type/business")) return "business";
  if (labels.includes("type/intake")) return "intake";
  if (labels.includes("type/task")) return "task";
  // 親の選択肢を誤らないよう、type/workが無いIssueはWorkとみなさない（Task作成側の検査でも拒否される）。
  if (labels.includes("type/work")) return "work";
  return "other";
}

function repositoryFromIssueUrl(url: string): string {
  return url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\//)?.[1] ?? "";
}
