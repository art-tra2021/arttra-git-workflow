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

  test("Issue template directoryの404は未導入として空一覧へ変換する", async () => {
    const client = dependencies(async (input) => {
      const url = String(input);
      if (url.endsWith("/app/installations/99/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2026-08-01T01:00:00Z" });
      }
      if (url.endsWith("/contents/.github/ISSUE_TEMPLATE")) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      throw new Error(`予期しないrequest: ${url}`);
    });

    expect(await client.listIssueTemplates("art-tra2021/no-template")).toEqual([]);
  });

  test("viewer-aware repository一覧はpublic readとprivateのeffective permissionだけを返す", async () => {
    const collaboratorCalls: string[] = [];
    const client = dependencies(async (input) => {
      if (input.endsWith("/app/installations/99/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2026-08-01T01:00:00Z" });
      }
      if (input.includes("/installation/repositories")) {
        return json({
          total_count: 4,
          repositories: [
            { full_name: "art-tra2021/public", archived: false, private: false },
            { full_name: "art-tra2021/private", archived: false, private: true },
            { full_name: "art-tra2021/denied", archived: false, private: true },
            { full_name: "outside/nope", archived: false, private: false },
          ],
        });
      }
      if (input.includes("/collaborators/alice/permission")) {
        collaboratorCalls.push(input);
        if (input.includes("/private/")) return json({ permission: "triage" });
        return new Response(JSON.stringify({ message: "forbidden" }), { status: 403 });
      }
      throw new Error(`予期しないrequest: ${input}`);
    });

    expect(await client.listRepositoriesForViewer("alice")).toEqual([
      "art-tra2021/private",
      "art-tra2021/public",
    ]);
    expect(collaboratorCalls).toEqual([
      "https://github.example/api/v3/repos/art-tra2021/private/collaborators/alice/permission",
      "https://github.example/api/v3/repos/art-tra2021/denied/collaborators/alice/permission",
    ]);
    expect(await client.assertRepositoryAccess("art-tra2021/public", "alice")).toMatchObject({
      permission: "read",
      visibility: "public",
    });
    await expect(client.assertRepositoryAccess("art-tra2021/denied", "alice")).rejects.toThrow(
      "参照する権限がありません",
    );
  });

  test("Issue作成はslack commandのviewerを解決してrepository権限を再確認する", async () => {
    const calls: string[] = [];
    const client = new GitHubAppDependencies({
      ...baseConfig(),
      resolveGitHubLogin: async (slackUserId) => {
        expect(slackUserId).toBe("U_ALICE");
        return "alice";
      },
      fetch: async (input, init) => {
        calls.push(input);
        if (input.endsWith("/app/installations/99/access_tokens")) {
          return json({
            token: "installation-token",
            expires_at: "2026-08-01T01:00:00Z",
            permissions: { issues: "write", contents: "read" },
          });
        }
        if (input.includes("/installation/repositories")) {
          return json({
            total_count: 1,
            repositories: [{ full_name: "art-tra2021/private", archived: false, private: true }],
          });
        }
        if (input.endsWith("/collaborators/alice/permission")) {
          return json({ permission: "read" });
        }
        if (input.endsWith("/contents/.github/ISSUE_TEMPLATE")) {
          return json([
            { name: "work.yml", path: ".github/ISSUE_TEMPLATE/work.yml", type: "file" },
          ]);
        }
        if (input.endsWith("/contents/.github/ISSUE_TEMPLATE/work.yml")) {
          return new Response(issueForm(), { status: 200 });
        }
        if (input.endsWith("/repos/art-tra2021/private/issues/6")) {
          return json({
            id: 6,
            number: 6,
            title: "parent Intake",
            html_url: "https://github.example/issues/6",
            body: "",
            state: "open",
            user: { login: "alice" },
            labels: ["type/intake"],
            assignees: [],
          });
        }
        if (input.endsWith("/repos/art-tra2021/private/issues")) {
          return json({
            number: 7,
            title: "[作業] viewer check",
            html_url: "https://github.example/issues/7",
            labels: [],
            assignees: [],
          });
        }
        throw new Error(`予期しないrequest: ${input} ${String(init?.body ?? "")}`);
      },
    });
    const command: CreateIssueCommand = {
      schemaVersion: 1,
      kind: "issue.create",
      repository: "art-tra2021/private",
      template: "work",
      title: "viewer check",
      fields: { outcome: "権限確認" },
      actor: "U_ALICE",
      slackTeamId: "T123",
      relationships: {
        parent: { repository: "art-tra2021/private", number: 6 },
        blockedBy: [],
        blocking: [],
      },
    };

    expect(await client.createIssue(command)).toMatchObject({ number: 7 });
    expect(calls.some((input) => input.endsWith("/collaborators/alice/permission"))).toBe(true);
  });

  test("Issue担当ボタンもviewer権限を再確認して本人をassigneeにする", async () => {
    let patchedBody: unknown;
    const client = dependencies(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/app/installations/99/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2026-08-01T01:00:00Z" });
      }
      if (url.includes("/installation/repositories")) {
        return json({
          total_count: 1,
          repositories: [{ full_name: "art-tra2021/private", archived: false, private: true }],
        });
      }
      if (url.endsWith("/collaborators/alice/permission")) {
        return json({ permission: "triage" });
      }
      if (url.endsWith("/repos/art-tra2021/private/issues/7")) {
        patchedBody = JSON.parse(String(init?.body));
        return json({
          number: 7,
          title: "private work",
          html_url: "https://github.com/art-tra2021/private/issues/7",
          body: "",
          state: "open",
          user: { login: "author" },
          labels: [],
          assignees: [{ login: "alice" }],
        });
      }
      throw new Error(`予期しないrequest: ${url}`);
    });

    expect(await client.claimIssue("art-tra2021/private", 7, "U_ALICE", "alice")).toMatchObject({
      issueNumber: 7,
      owner: "alice",
    });
    expect(patchedBody).toEqual({ assignees: ["alice"] });
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
        return json([{ name: "task.yml", path: ".github/ISSUE_TEMPLATE/task.yml", type: "file" }]);
      }
      if (url.endsWith("/contents/.github/ISSUE_TEMPLATE/task.yml")) {
        return new Response(taskIssueForm(), { status: 200 });
      }
      if (url.endsWith("/repos/art-tra2021/arttra-git-workflow")) {
        return json({ full_name: "art-tra2021/arttra-git-workflow" });
      }
      if (url.includes("/installation/repositories")) {
        return json({
          total_count: 1,
          repositories: [
            { full_name: "art-tra2021/arttra-git-workflow", archived: false, private: false },
          ],
        });
      }
      if (url.endsWith("/collaborators/octocat/permission")) {
        return json({ permission: "maintain" });
      }
      if (url.endsWith("/repos/art-tra2021/arttra-git-workflow/issues/86")) {
        return json({
          id: 86,
          number: 86,
          title: "parent Work",
          html_url: "https://github.com/art-tra2021/arttra-git-workflow/issues/86",
          body: "",
          state: "open",
          user: { login: "owner" },
          labels: ["type/work"],
          assignees: [],
        });
      }
      if (url.endsWith("/repos/art-tra2021/arttra-git-workflow/issues")) {
        createdBody = JSON.parse(String(init?.body));
        return json({
          id: 42,
          number: 42,
          title: "[作業] API接続",
          html_url: "https://github.com/art-tra2021/arttra-git-workflow/issues/42",
          labels: [],
          assignees: [],
        });
      }
      if (url.endsWith("/repos/art-tra2021/arttra-git-workflow/issues/86/sub_issues")) {
        return json({});
      }
      throw new Error(`予期しないrequest: ${url}`);
    });
    const command: CreateIssueCommand = {
      schemaVersion: 1,
      kind: "issue.create",
      repository: "art-tra2021/arttra-git-workflow",
      template: "task",
      title: "API接続",
      fields: { action: "Cloud Runから作成できる", merge: "自分でマージ可" },
      actor: "U123",
      assigneeGitHubLogins: ["octocat"],
      reviewerGitHubLogins: ["reviewer"],
      reviewerGitHubUsers: [{ id: 456, login: "reviewer" }],
      requesterGitHubUser: { id: 123, login: "requester" },
      relationships: {
        parent: { repository: "art-tra2021/arttra-git-workflow", number: 86 },
        blockedBy: [],
        blocking: [],
      },
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
      title: "[Task] API接続",
      labels: ["type/task", "merge/self"],
      assignees: ["octocat"],
    });
    expect(createdBody).toHaveProperty("body");
    expect((createdBody as { body: string }).body).toContain(
      '<!-- ar:reviewers:v1 [{"id":456,"login":"reviewer"}] -->',
    );
    expect((createdBody as { body: string }).body).toContain(
      '<!-- ar:requester:v1 {"id":123,"login":"requester"} -->',
    );
  });

  test("template未導入repositoryでは標準IssueをGitHub APIへ送る", async () => {
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
      if (url.endsWith("/repos/art-tra2021/no-template")) {
        return json({ full_name: "art-tra2021/no-template" });
      }
      if (url.endsWith("/contents/.github/ISSUE_TEMPLATE")) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      if (url.endsWith("/repos/art-tra2021/no-template/issues")) {
        createdBody = JSON.parse(String(init?.body));
        return json({
          number: 7,
          title: "[Issue] 相談",
          html_url: "https://github.com/art-tra2021/no-template/issues/7",
          labels: ["type/intake"],
          assignees: [],
        });
      }
      throw new Error(`予期しないrequest: ${url}`);
    });
    const command: CreateIssueCommand = {
      schemaVersion: 1,
      kind: "issue.create",
      repository: "art-tra2021/no-template",
      template: "generic",
      title: "相談",
      fields: { summary: "テンプレート導入前の相談", done: "" },
      actor: "U123",
    };

    await client.validateIssueAuthorization(command);
    expect(await client.createIssue(command)).toEqual({
      number: 7,
      title: "[Issue] 相談",
      url: "https://github.com/art-tra2021/no-template/issues/7",
    });
    expect(createdBody).toMatchObject({
      title: "[Issue] 相談",
      labels: ["type/intake", "status/triage"],
    });
    expect((createdBody as { body: string }).body).toContain("テンプレート導入前の相談");
  });

  test("GitHub AppはIssue作成後にnative parent・依存関係を付与する", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = dependencies(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ url, method, body });
      if (url.endsWith("/app/installations/99/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2026-08-01T01:00:00Z" });
      }
      if (url.endsWith("/contents/.github/ISSUE_TEMPLATE")) {
        return json([{ name: "work.yml", path: ".github/ISSUE_TEMPLATE/work.yml", type: "file" }]);
      }
      if (url.endsWith("/contents/.github/ISSUE_TEMPLATE/work.yml")) {
        return new Response(issueForm(), { status: 200 });
      }
      if (url.includes("/installation/repositories")) {
        return json({
          total_count: 3,
          repositories: [
            { full_name: "art-tra2021/arttra-git-workflow", archived: false, private: false },
            { full_name: "art-tra2021/other", archived: false, private: false },
            { full_name: "outside/nope", archived: false, private: false },
          ],
        });
      }
      const target = url.match(/\/repos\/([^/]+\/[^/]+)\/issues\/(4|5|6)$/)?.[2] ?? null;
      if (target) {
        const number = Number(target);
        return json({
          id: 100 + number,
          number,
          title: `target ${number}`,
          html_url: `https://github.example/issues/${number}`,
          body: "",
          state: "open",
          user: { login: "author" },
          labels: ["type/intake"],
          assignees: [],
        });
      }
      if (url.endsWith("/repos/art-tra2021/arttra-git-workflow/issues")) {
        return json({
          id: 222,
          number: 42,
          title: "created",
          html_url: "https://github.example/issues/42",
          body: "",
          state: "open",
          user: { login: "author" },
          labels: [],
          assignees: [],
        });
      }
      if (url.endsWith("/repos/art-tra2021/arttra-git-workflow/issues/4/sub_issues")) {
        return json({});
      }
      if (
        url.endsWith("/repos/art-tra2021/arttra-git-workflow/issues/42/dependencies/blocked_by")
      ) {
        return json({});
      }
      if (url.endsWith("/repos/art-tra2021/other/issues/6/dependencies/blocked_by")) {
        return json({});
      }
      throw new Error(`予期しないrequest: ${url} ${String(init?.body ?? "")}`);
    });
    const command: CreateIssueCommand = {
      schemaVersion: 1,
      kind: "issue.create",
      repository: "art-tra2021/arttra-git-workflow",
      template: "work",
      title: "関係を付ける",
      fields: { outcome: "native relation" },
      actor: "U123",
      relationships: {
        parent: { repository: "art-tra2021/arttra-git-workflow", number: 4 },
        blockedBy: [{ repository: "art-tra2021/arttra-git-workflow", number: 5 }],
        blocking: [{ repository: "art-tra2021/other", number: 6 }],
      },
    };

    expect(await client.createIssue(command)).toEqual({
      number: 42,
      title: "created",
      url: "https://github.example/issues/42",
    });
    expect(
      calls
        .filter((call) => call.method === "POST" && !call.url.includes("/access_tokens"))
        .map((call) => [call.url, call.body]),
    ).toEqual([
      [
        "https://github.example/api/v3/repos/art-tra2021/arttra-git-workflow/issues",
        expect.objectContaining({ title: "[作業] 関係を付ける" }),
      ],
      [
        "https://github.example/api/v3/repos/art-tra2021/arttra-git-workflow/issues/4/sub_issues",
        { sub_issue_id: 222 },
      ],
      [
        "https://github.example/api/v3/repos/art-tra2021/arttra-git-workflow/issues/42/dependencies/blocked_by",
        { issue_id: 105 },
      ],
      [
        "https://github.example/api/v3/repos/art-tra2021/other/issues/6/dependencies/blocked_by",
        { issue_id: 222 },
      ],
    ]);
  });

  test.each([
    ["Task→Intake", "task", ["type/intake"], "type/work または type/business"],
    ["Work→Work", "work", ["type/work"], "type/intake"],
    ["type複数", "task", ["type/work", "type/business"], "type/work または type/business"],
    ["typeなし", "work", [], "type/intake"],
  ] as const)(
    "不正な親%sはIssue作成POST前に拒否する",
    async (_name, template, labels, expected) => {
      let createPosts = 0;
      const client = dependencies(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/app/installations/99/access_tokens")) {
          return json({ token: "installation-token", expires_at: "2026-08-01T01:00:00Z" });
        }
        if (url.endsWith("/contents/.github/ISSUE_TEMPLATE")) {
          return json([
            {
              name: `${template}.yml`,
              path: `.github/ISSUE_TEMPLATE/${template}.yml`,
              type: "file",
            },
          ]);
        }
        if (url.endsWith(`/contents/.github/ISSUE_TEMPLATE/${template}.yml`)) {
          return new Response(issueForm(), { status: 200 });
        }
        if (url.includes("/installation/repositories")) {
          return json({
            total_count: 1,
            repositories: [
              { full_name: "art-tra2021/arttra-git-workflow", archived: false, private: false },
            ],
          });
        }
        if (url.endsWith("/repos/art-tra2021/arttra-git-workflow/issues/4")) {
          return json({
            id: 104,
            number: 4,
            title: "invalid parent",
            html_url: "https://github.example/issues/4",
            body: "",
            state: "open",
            user: { login: "author" },
            labels,
            assignees: [],
          });
        }
        if (url.endsWith("/repos/art-tra2021/arttra-git-workflow/issues")) {
          createPosts += init?.method === "POST" ? 1 : 0;
          return json({});
        }
        throw new Error(`予期しないrequest: ${url}`);
      });
      const command: CreateIssueCommand = {
        schemaVersion: 1,
        kind: "issue.create",
        repository: "art-tra2021/arttra-git-workflow",
        template,
        title: "invalid hierarchy",
        fields: {},
        actor: "U123",
        relationships: {
          parent: { repository: "art-tra2021/arttra-git-workflow", number: 4 },
          blockedBy: [],
          blocking: [],
        },
      };

      await expect(client.createIssue(command)).rejects.toThrow(expected);
      expect(createPosts).toBe(0);
    },
  );

  test("native関係の一部失敗でも作成済みIssue URLと構造化失敗を返す", async () => {
    const client = dependencies(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/app/installations/99/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2026-08-01T01:00:00Z" });
      }
      if (url.endsWith("/contents/.github/ISSUE_TEMPLATE")) {
        return json([{ name: "work.yml", path: ".github/ISSUE_TEMPLATE/work.yml", type: "file" }]);
      }
      if (url.endsWith("/contents/.github/ISSUE_TEMPLATE/work.yml")) {
        return new Response(issueForm(), { status: 200 });
      }
      if (url.includes("/installation/repositories")) {
        return json({
          total_count: 1,
          repositories: [
            { full_name: "art-tra2021/arttra-git-workflow", archived: false, private: false },
          ],
        });
      }
      if (url.endsWith("/repos/art-tra2021/arttra-git-workflow/issues/4")) {
        return json({
          id: 104,
          number: 4,
          title: "parent",
          html_url: "https://github.example/issues/4",
          body: "",
          state: "open",
          user: { login: "author" },
          labels: ["type/intake"],
          assignees: [],
        });
      }
      if (url.endsWith("/repos/art-tra2021/arttra-git-workflow/issues")) {
        return json({
          id: 222,
          number: 42,
          title: "created",
          html_url: "https://github.example/issues/42",
          body: "",
          state: "open",
          user: { login: "author" },
          labels: [],
          assignees: [],
        });
      }
      if (url.endsWith("/sub_issues")) {
        return new Response(JSON.stringify({ message: "forbidden" }), { status: 403 });
      }
      throw new Error(`予期しないrequest: ${url} ${String(init?.body ?? "")}`);
    });

    const issue = await client.createIssue({
      schemaVersion: 1,
      kind: "issue.create",
      repository: "art-tra2021/arttra-git-workflow",
      template: "work",
      title: "部分失敗",
      fields: { outcome: "URLを失わない" },
      actor: "U123",
      relationships: {
        parent: { repository: "art-tra2021/arttra-git-workflow", number: 4 },
        blockedBy: [],
        blocking: [],
      },
    });
    expect(issue.number).toBe(42);
    expect(issue.url).toBe("https://github.example/issues/42");
    expect(issue.relationshipStatus).toMatchObject({
      status: "partial",
      attached: [],
      failed: [{ relation: "parent", reference: "art-tra2021/arttra-git-workflow#4" }],
    });
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
    let closingIssuesQuery: unknown;
    const client = dependencies(async (input, init) => {
      if (input.endsWith("/app/installations/99/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2026-08-01T01:00:00Z" });
      }
      if (input.endsWith("/repos/art-tra2021/arttra-git-workflow/pulls/28")) {
        return json({
          number: 28,
          title: "review automation",
          html_url: "https://github.example/pull/28",
          body: "Closes #29\n\nRelates to #30",
          draft: false,
          state: "open",
          mergeable_state: "clean",
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
      if (input.endsWith("/graphql")) {
        closingIssuesQuery = JSON.parse(String(init?.body));
        return json({
          data: {
            repository: {
              pullRequest: {
                closingIssuesReferences: {
                  totalCount: 1,
                  nodes: [
                    {
                      number: 29,
                      title: "primary issue",
                      body: "issue body",
                      url: "https://github.example/issues/29",
                      state: "OPEN",
                      author: { login: "requester" },
                      parent: { url: "https://github.example/example/parent/issues/7" },
                      assignees: { nodes: [{ login: "owner" }] },
                      labels: { nodes: [{ name: "type/task" }] },
                    },
                  ],
                },
              },
            },
          },
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
      mergeableState: "clean",
      approvedReviewerLogins: ["finished"],
      changesRequestedReviewerLogins: [],
      closingIssueCount: 1,
      primaryIssue: {
        number: 29,
        title: "primary issue",
        body: "issue body",
        assigneeLogins: ["owner"],
        parentIssueUrl: "https://github.example/example/parent/issues/7",
      },
      linkedIssues: [
        {
          number: 29,
          title: "primary issue",
          body: "issue body",
          assigneeLogins: ["owner"],
        },
      ],
      codeowners: "* @alice",
    });
    expect(closingIssuesQuery).toMatchObject({
      variables: { owner: "art-tra2021", name: "arttra-git-workflow", number: 28 },
    });
    expect(JSON.stringify(closingIssuesQuery)).toContain("closingIssuesReferences");
    expect(JSON.stringify(closingIssuesQuery)).not.toContain("Relates");
    expect(await client.resolveGitHubUsers(["alice"])).toEqual([{ id: 101, login: "alice" }]);
    await client.requestPullRequestReviewers(
      "art-tra2021/arttra-git-workflow",
      28,
      ["alice"],
      ["frontend"],
    );
    expect(requested).toEqual({ reviewers: ["alice"], team_reviewers: ["frontend"] });
  });

  test("closing Issueが0件または複数件ならprimary Issueを設定しない", async () => {
    const cases = [
      { totalCount: 0, numbers: [] },
      { totalCount: 2, numbers: [29, 31] },
    ];
    for (const fixture of cases) {
      const client = dependencies(async (input, init) => {
        if (input.endsWith("/app/installations/99/access_tokens")) {
          return json({ token: "installation-token", expires_at: "2026-08-01T01:00:00Z" });
        }
        if (input.endsWith("/repos/art-tra2021/arttra-git-workflow/pulls/28")) {
          return json({
            number: 28,
            title: "review automation",
            html_url: "https://github.example/pull/28",
            body: "単なる参照 #30",
            draft: false,
            state: "open",
            mergeable_state: "clean",
            user: { login: "author" },
            head: { sha: "abc123" },
            requested_reviewers: [],
            requested_teams: [],
          });
        }
        if (input.includes("/pulls/28/files?")) return json([]);
        if (input.includes("/pulls/28/reviews?")) return json([]);
        if (input.endsWith("/graphql")) {
          expect(JSON.parse(String(init?.body))).toMatchObject({
            variables: { owner: "art-tra2021", name: "arttra-git-workflow", number: 28 },
          });
          return json({
            data: {
              repository: {
                pullRequest: {
                  closingIssuesReferences: {
                    totalCount: fixture.totalCount,
                    nodes: fixture.numbers.map((number) => ({
                      number,
                      title: `closing issue ${number}`,
                      body: "",
                      url: `https://github.example/issues/${number}`,
                      state: "OPEN",
                      author: { login: "requester" },
                      assignees: { nodes: [] },
                      labels: { nodes: [] },
                    })),
                  },
                },
              },
            },
          });
        }
        if (input.endsWith("/contents/.github/CODEOWNERS")) return new Response("");
        if (input.includes("/rulesets?")) return json([]);
        throw new Error(`予期しないrequest: ${input}`);
      });

      const context = await client.loadPullRequestReviewContext(
        "art-tra2021/arttra-git-workflow",
        28,
      );
      expect(context.closingIssueCount).toBe(fixture.totalCount);
      expect(context.primaryIssue).toBeNull();
      expect(context.linkedIssues.map((issue) => issue.number)).toEqual(fixture.numbers);
    }
  });

  test("セルフマージ停止はreview labelへ切り替えて停止者と理由をIssueへ記録する", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    let loadCount = 0;
    const client = dependencies(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/app/installations/99/access_tokens")) {
        return json({ token: "installation-token", expires_at: "2026-08-01T01:00:00Z" });
      }
      if (url.endsWith("/issues/86") && (!init?.method || init.method === "GET")) {
        loadCount += 1;
        return json({
          number: 86,
          title: "self merge",
          body: "done",
          html_url: "https://github.example/issues/86",
          state: "open",
          user: { login: "requester" },
          assignees: [{ login: "owner" }],
          labels: loadCount === 1 ? ["type/task", "merge/self"] : ["type/task", "merge/review"],
        });
      }
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return json([]);
    });

    const issue = await client.stopSelfMerge(
      "art-tra2021/arttra-git-workflow",
      86,
      "stopper",
      "影響範囲を第三者が確認する必要があるため",
    );

    expect(issue.labels).toContain("merge/review");
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["PATCH", "https://github.example/api/v3/repos/art-tra2021/arttra-git-workflow/issues/86"],
      [
        "POST",
        "https://github.example/api/v3/repos/art-tra2021/arttra-git-workflow/issues/86/comments",
      ],
    ]);
    expect(JSON.stringify(requests.at(-1)?.body)).toContain("@stopper");
    expect(JSON.stringify(requests.at(-1)?.body)).toContain("影響範囲を第三者が確認");
    expect(requests[0]?.body).toEqual({ labels: ["type/task", "merge/review"] });
  });
});

function dependencies(fetchImpl: GitHubFetch): GitHubAppDependencies {
  return new GitHubAppDependencies({
    ...baseConfig(),
    apiBaseUrl: "https://github.example/api/v3",
    fetch: fetchImpl,
    now: () => NOW,
  });
}

function baseConfig() {
  return {
    appId: "12345",
    installationId: "99",
    privateKey,
    repository: "art-tra2021/arttra-git-workflow",
    githubLogin: "rozwer",
    owners: ["rozwer", "art-tra2021"],
    apiBaseUrl: "https://github.example/api/v3",
    now: () => NOW,
  };
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

function taskIssueForm(): string {
  return `
name: PR実装タスク
title: "[Task] "
labels: [type/task, merge/review]
body:
  - type: textarea
    id: action
    attributes:
      label: このPRで実装すること
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
