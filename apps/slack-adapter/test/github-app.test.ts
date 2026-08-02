import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createAppJwt, GitHubAppDependencies, type GitHubFetch } from "../src/github-app.ts";
import type { CreateIssueCommand } from "../src/types.ts";

const NOW = Date.parse("2026-08-01T00:00:00Z");
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;

describe("GitHub App adapter", () => {
  test("RS256 JWTへ短い有効期限とApp IDを埋め込む", () => {
    const jwt = createAppJwt("12345", privateKey, NOW);
    const [encodedHeader, encodedPayload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(encodedHeader ?? "", "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(encodedPayload ?? "", "base64url").toString())).toEqual({
      iat: Math.floor(NOW / 1000) - 60,
      exp: Math.floor(NOW / 1000) + 540,
      iss: "12345",
    });
    expect(signature).toBeTruthy();
  });

  test("installation tokenを再利用してrepositoryとIssue templateを取得する", async () => {
    const calls: string[] = [];
    const client = dependencies(async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/app/installations/99/access_tokens")) {
        expect(new Headers(init?.headers).get("authorization")).toStartWith("Bearer eyJ");
        return json({ token: "installation-token", expires_at: "2026-08-01T01:00:00Z" });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer installation-token");
      if (url.includes("/installation/repositories")) {
        return json({
          total_count: 3,
          repositories: [
            { full_name: "art-tra2021/service", archived: false },
            { full_name: "outside/nope", archived: false },
            { full_name: "art-tra2021/old", archived: true },
          ],
        });
      }
      if (url.endsWith("/contents/.github/ISSUE_TEMPLATE")) {
        return json([{ name: "work.yml", path: ".github/ISSUE_TEMPLATE/work.yml", type: "file" }]);
      }
      if (url.endsWith("/contents/.github/ISSUE_TEMPLATE/work.yml")) {
        return new Response(issueForm(), { status: 200 });
      }
      throw new Error(`予期しないrequest: ${url}`);
    });

    expect(await client.listRepositories()).toEqual([
      "art-tra2021/arttra-git-workflow",
      "art-tra2021/service",
    ]);
    expect((await client.listIssueTemplates("art-tra2021/arttra-git-workflow"))[0]?.id).toBe(
      "work",
    );
    expect(calls.filter((url) => url.includes("access_tokens"))).toHaveLength(1);
  });

  test("共有commandをGitHub Issue APIへ送る", async () => {
    let createdBody: unknown;
    const client = dependencies(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/app/installations/99/access_tokens")) {
        return json({
          token: "installation-token",
          expires_at: "2026-08-01T01:00:00Z",
          permissions: { issues: "write", contents: "read" },
        });
      }
      if (url.endsWith("/contents/.github/ISSUE_TEMPLATE")) {
        return json([{ name: "work.yml", path: ".github/ISSUE_TEMPLATE/work.yml", type: "file" }]);
      }
      if (url.endsWith("/contents/.github/ISSUE_TEMPLATE/work.yml")) {
        return new Response(issueForm(), { status: 200 });
      }
      if (url.endsWith("/repos/art-tra2021/arttra-git-workflow")) {
        return json({ full_name: "art-tra2021/arttra-git-workflow" });
      }
      if (url.endsWith("/collaborators/octocat/permission")) {
        return json({ permission: "maintain" });
      }
      if (url.endsWith("/repos/art-tra2021/arttra-git-workflow/issues")) {
        createdBody = JSON.parse(String(init?.body));
        return json({
          number: 42,
          title: "[作業] API接続",
          html_url: "https://github.com/art-tra2021/arttra-git-workflow/issues/42",
          labels: [],
          assignees: [],
        });
      }
      throw new Error(`予期しないrequest: ${url}`);
    });
    const command: CreateIssueCommand = {
      schemaVersion: 1,
      kind: "issue.create",
      repository: "art-tra2021/arttra-git-workflow",
      template: "work",
      title: "API接続",
      fields: { outcome: "Cloud Runから作成できる", merge: "自分でマージ可" },
      actor: "U123",
      assigneeGitHubLogins: ["octocat"],
      reviewerGitHubLogins: ["reviewer"],
      reviewerGitHubUsers: [{ id: 456, login: "reviewer" }],
    };

    await client.validateIssueAuthorization(command);
    expect(await client.repositoryPermission("art-tra2021/arttra-git-workflow", "octocat")).toBe(
      "maintain",
    );
    expect(await client.createIssue(command)).toEqual({
      number: 42,
      title: "[作業] API接続",
      url: "https://github.com/art-tra2021/arttra-git-workflow/issues/42",
    });
    expect(createdBody).toMatchObject({
      title: "[作業] API接続",
      labels: ["type/work", "merge/self"],
      assignees: ["octocat"],
    });
    expect(createdBody).toHaveProperty("body");
    expect((createdBody as { body: string }).body).toContain(
      '<!-- ar:reviewers:v1 [{"id":456,"login":"reviewer"}] -->',
    );
  });

  test("検証済みGitHub loginでProjectsの自分の仕事を絞り込む", async () => {
    const graphqlBodies: unknown[] = [];
    const client = new GitHubAppDependencies({
      appId: "12345",
      installationId: "99",
      privateKey,
      repository: "art-tra2021/arttra-git-workflow",
      githubLogin: "service-account",
      owners: ["rozwer"],
      project: { owner: "art-tra2021", number: 8 },
      apiBaseUrl: "https://github.example/api/v3",
      fetch: async (input, init) => {
        if (input.endsWith("/app/installations/99/access_tokens")) {
          return json({ token: "installation-token", expires_at: "2026-08-01T01:00:00Z" });
        }
        if (input.endsWith("/graphql")) {
          const graphqlBody = JSON.parse(String(init?.body)) as {
            variables: { cursor?: string | null };
          };
          graphqlBodies.push(graphqlBody);
          return json({
            data: {
              organization: {
                projectV2: {
                  items: {
                    nodes:
                      graphqlBody.variables.cursor === "cursor-2"
                        ? [projectItem(43, "alice", "Ready", "P2")]
                        : [projectItem(42, "alice", "In progress", "P1")],
                    pageInfo:
                      graphqlBody.variables.cursor === "cursor-2"
                        ? { hasNextPage: false, endCursor: null }
                        : { hasNextPage: true, endCursor: "cursor-2" },
                  },
                },
              },
            },
          });
        }
        throw new Error(`予期しないrequest: ${input}`);
      },
      now: () => NOW,
      resolveGitHubLogin: async (slackUserId) => {
        expect(slackUserId).toBe("U_ALICE");
        return "alice";
      },
    });

    expect(await client.loadWorkItems("U_ALICE")).toEqual([
      expect.objectContaining({ issueNumber: 42, status: "in-progress", priority: "P1" }),
      expect.objectContaining({ issueNumber: 43, status: "todo", priority: "P2" }),
    ]);
    expect(graphqlBodies).toEqual([
      expect.objectContaining({
        variables: { owner: "art-tra2021", number: 8, limit: 100, cursor: null },
      }),
      expect.objectContaining({
        variables: { owner: "art-tra2021", number: 8, limit: 100, cursor: "cursor-2" },
      }),
    ]);
    expect(graphqlBodies).toHaveLength(2);
    expect(graphqlBodies[0]).toMatchObject({
      variables: { owner: "art-tra2021", number: 8, limit: 100, cursor: null },
    });
  });

  test("PR、linked Issue、CODEOWNERS、Rulesetを再取得してreviewerをrequestする", async () => {
    let requested: unknown;
    const client = dependencies(async (input, init) => {
      if (input.endsWith("/app/installations/99/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2026-08-01T01:00:00Z" });
      }
      if (input.endsWith("/repos/art-tra2021/arttra-git-workflow/pulls/28")) {
        return json({
          number: 28,
          title: "review automation",
          html_url: "https://github.example/pull/28",
          body: "Closes #29",
          draft: false,
          state: "open",
          user: { login: "author" },
          head: { sha: "abc123" },
          requested_reviewers: [],
          requested_teams: [],
        });
      }
      if (input.includes("/pulls/28/files?")) return json([{ filename: "src/app.ts" }]);
      if (input.includes("/pulls/28/reviews?")) {
        return json([{ state: "APPROVED", user: { login: "finished" } }]);
      }
      if (input.endsWith("/issues/29")) {
        return json({
          number: 29,
          body: "issue body",
          html_url: "https://github.example/issues/29",
        });
      }
      if (input.endsWith("/contents/.github/CODEOWNERS")) return new Response("* @alice");
      if (input.includes("/rulesets?")) return json([{ id: 7, enforcement: "active" }]);
      if (input.endsWith("/rulesets/7")) {
        return json({
          rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2 } }],
        });
      }
      if (input.endsWith("/users/alice")) return json({ id: 101, login: "alice" });
      if (input.endsWith("/pulls/28/requested_reviewers")) {
        requested = JSON.parse(String(init?.body));
        return json({});
      }
      throw new Error(`予期しないrequest: ${input}`);
    });

    const context = await client.loadPullRequestReviewContext(
      "art-tra2021/arttra-git-workflow",
      28,
    );
    expect(context).toMatchObject({
      number: 28,
      files: ["src/app.ts"],
      requiredApprovals: 2,
      approvedReviewerLogins: ["finished"],
      linkedIssues: [{ number: 29, body: "issue body" }],
      codeowners: "* @alice",
    });
    expect(await client.resolveGitHubUsers(["alice"])).toEqual([{ id: 101, login: "alice" }]);
    await client.requestPullRequestReviewers(
      "art-tra2021/arttra-git-workflow",
      28,
      ["alice"],
      ["frontend"],
    );
    expect(requested).toEqual({ reviewers: ["alice"], team_reviewers: ["frontend"] });
  });
});

function dependencies(fetchImpl: GitHubFetch): GitHubAppDependencies {
  return new GitHubAppDependencies({
    appId: "12345",
    installationId: "99",
    privateKey,
    repository: "art-tra2021/arttra-git-workflow",
    githubLogin: "rozwer",
    owners: ["rozwer", "art-tra2021"],
    apiBaseUrl: "https://github.example/api/v3",
    fetch: fetchImpl,
    now: () => NOW,
  });
}

function json(value: unknown): Response {
  return Response.json(value, { status: 200 });
}

function issueForm(): string {
  return `
name: 作業
title: "[作業] "
labels: [type/work]
body:
  - type: textarea
    id: outcome
    attributes:
      label: 完了後にどうなるか
    validations:
      required: true
  - type: dropdown
    id: merge
    attributes:
      label: マージ方式
      options:
        - 通常レビュー（既定）
        - 自分でマージ可
`;
}

function projectIssue(number: number, assignee: string, status: string, priority: string) {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.example/issues/${number}`,
    labels: { nodes: [{ name: "type/work" }] },
    assignees: { nodes: [{ login: assignee }] },
    projectItems: {
      nodes: [
        {
          fieldValues: {
            nodes: [
              { name: status, field: { name: "Status" } },
              { name: priority, field: { name: "Priority" } },
            ],
          },
        },
      ],
    },
  };
}

function projectItem(number: number, assignee: string, status: string, priority: string) {
  const issue = projectIssue(number, assignee, status, priority);
  const fieldValues = issue.projectItems.nodes[0]?.fieldValues;
  if (!fieldValues) throw new Error("Project fixtureにfieldValuesがありません");
  return {
    content: {
      number: issue.number,
      title: issue.title,
      url: issue.url,
      state: "OPEN",
      labels: issue.labels,
      assignees: issue.assignees,
    },
    fieldValues,
  };
}
