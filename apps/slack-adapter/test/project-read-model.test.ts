import { describe, expect, test } from "bun:test";
import { projectIssueNodes, projectIssueSnapshot } from "../src/project-read-model.ts";

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
                labels: { nodes: [{ name: "type/work" }, { name: "priority/P3" }] },
                assignees: { nodes: [{ login: "alice" }] },
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
      project: {
        status: "in-progress",
        priority: "P1",
        owner: "alice",
        targetDate: "2026-08-10",
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

  test("GraphQL errorを日本語の運用エラーへ変換する", () => {
    expect(() =>
      projectIssueNodes({ errors: [{ message: "Projects permission denied" }] }),
    ).toThrow("GitHub Projectsを読み取れませんでした: Projects permission denied");
  });
});
