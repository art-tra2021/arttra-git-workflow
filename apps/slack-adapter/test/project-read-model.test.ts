import { describe, expect, test } from "bun:test";
import {
  organizationProjectIssueNodes,
  organizationProjectIssuePage,
  projectIssueNodes,
  projectIssueSnapshot,
} from "../src/project-read-model.ts";

describe("GitHub Projects read model", () => {
  test("Projects V2の正本fieldを内部schemaへ変換する", () => {
    const [issue] = projectIssueNodes({
      data: {
        repository: {
          issues: {
            nodes: [
              {
                number: 42,
                title: "Projectsを読む",
                url: "https://github.example/issues/42",
                repository: { nameWithOwner: "art-tra2021/work" },
                labels: { nodes: [{ name: "type/work" }, { name: "priority/P3" }] },
                assignees: { nodes: [{ login: "alice" }] },
                blockedBy: {
                  nodes: [
                    {
                      number: 40,
                      title: "API契約を決める",
                      url: "https://github.example/issues/40",
                      state: "OPEN",
                    },
                    {
                      number: 39,
                      title: "完了済み",
                      url: "https://github.example/issues/39",
                      state: "CLOSED",
                    },
                  ],
                },
                closedByPullRequestsReferences: {
                  nodes: [
                    {
                      number: 51,
                      url: "https://github.example/pull/51",
                      state: "OPEN",
                      mergeable: "CONFLICTING",
                      reviewRequests: {
                        nodes: [{ requestedReviewer: { login: "bob" } }],
                      },
                      commits: {
                        nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }],
                      },
                    },
                  ],
                },
                projectItems: {
                  nodes: [
                    {
                      fieldValues: {
                        nodes: [
                          { name: "In progress", field: { name: "Status" } },
                          { name: "P1", field: { name: "Priority" } },
                          { date: "2026-08-10", field: { name: "Target date" } },
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    if (!issue) throw new Error("test fixtureからIssueを読み取れませんでした");
    expect(projectIssueSnapshot(issue)).toMatchObject({
      issue: { number: 42, type: "work" },
      repository: "art-tra2021/work",
      project: {
        status: "in-progress",
        priority: "P1",
        owner: "alice",
        targetDate: "2026-08-10",
      },
      relationships: {
        blockedBy: [{ number: 40, title: "API契約を決める" }],
      },
      pullRequest: {
        number: 51,
        checks: "failed",
        mergeState: "conflicting",
        requestedReviewers: ["bob"],
      },
    });
  });

  test("Project未追加時はlabelと安全な既定値へfallbackする", () => {
    const issue = {
      number: 7,
      title: "受付",
      url: "https://github.example/issues/7",
      labels: { nodes: [{ name: "type/intake" }, { name: "status/triage" }] },
      assignees: { nodes: [] },
      projectItems: { nodes: [] },
    };
    expect(projectIssueSnapshot(issue)).toMatchObject({
      issue: { type: "intake" },
      project: { status: "triage", priority: "P2", owner: null, targetDate: null },
    });
  });

  test("Organization ProjectのIssueだけを担当者で絞り込む", () => {
    const issues = organizationProjectIssueNodes(
      {
        data: {
          organization: {
            projectV2: {
              items: {
                nodes: [
                  projectItem(42, "alice", "OPEN", "In progress", "P1"),
                  projectItem(43, "bob", "OPEN", "Ready", "P2"),
                  projectItem(44, "alice", "CLOSED", "Done", "P3"),
                  { content: null, fieldValues: { nodes: [] } },
                ],
              },
            },
          },
        },
      },
      8,
      "ALICE",
    );

    expect(issues).toHaveLength(1);
    const [issue] = issues;
    if (!issue) throw new Error("担当者で絞り込んだIssueがありません");
    expect(projectIssueSnapshot(issue)).toMatchObject({
      issue: { number: 42 },
      project: { status: "in-progress", priority: "P1", owner: "alice" },
    });
  });

  test("Organization Projectが存在しない場合は番号付きで案内する", () => {
    expect(() =>
      organizationProjectIssueNodes({ data: { organization: { projectV2: null } } }, 8),
    ).toThrow("GitHub Project #8が見つかりません");
  });

  test("Organization Projectの次ページ位置を返す", () => {
    const page = organizationProjectIssuePage(
      {
        data: {
          organization: {
            projectV2: {
              items: {
                nodes: [projectItem(42, "alice", "OPEN", "In progress", "P1")],
                pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
              },
            },
          },
        },
      },
      8,
    );

    expect(page.issues).toHaveLength(1);
    expect(page).toMatchObject({ hasNextPage: true, endCursor: "cursor-2" });
  });

  test("GraphQL errorを日本語の運用エラーへ変換する", () => {
    expect(() =>
      projectIssueNodes({ errors: [{ message: "Projects permission denied" }] }),
    ).toThrow("GitHub Projectsを読み取れませんでした: Projects permission denied");
  });
});

function projectItem(
  number: number,
  assignee: string,
  state: string,
  status: string,
  priority: string,
) {
  return {
    content: {
      number,
      title: `Issue ${number}`,
      url: `https://github.com/art-tra2021/service/issues/${number}`,
      state,
      labels: { nodes: [{ name: "type/work" }] },
      assignees: { nodes: [{ login: assignee }] },
    },
    fieldValues: {
      nodes: [
        { name: status, field: { name: "Status" } },
        { name: priority, field: { name: "Priority" } },
      ],
    },
  };
}
