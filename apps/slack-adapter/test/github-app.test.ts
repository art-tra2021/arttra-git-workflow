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
      "rozwer/arttra-git-lab",
      "art-tra2021/service",
    ]);
    expect((await client.listIssueTemplates("rozwer/arttra-git-lab"))[0]?.id).toBe("work");
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
      if (url.endsWith("/repos/rozwer/arttra-git-lab")) {
        return json({ full_name: "rozwer/arttra-git-lab" });
      }
      if (url.endsWith("/repos/rozwer/arttra-git-lab/issues")) {
        createdBody = JSON.parse(String(init?.body));
        return json({
          number: 42,
          title: "[作業] API接続",
          html_url: "https://github.com/rozwer/arttra-git-lab/issues/42",
          labels: [],
          assignees: [],
        });
      }
      throw new Error(`予期しないrequest: ${url}`);
    });
    const command: CreateIssueCommand = {
      schemaVersion: 1,
      kind: "issue.create",
      repository: "rozwer/arttra-git-lab",
      template: "work",
      title: "API接続",
      fields: { outcome: "Cloud Runから作成できる", merge: "自分でマージ可" },
      actor: "U123",
    };

    await client.validateIssueAuthorization(command);
    expect(await client.createIssue(command)).toEqual({
      number: 42,
      title: "[作業] API接続",
      url: "https://github.com/rozwer/arttra-git-lab/issues/42",
    });
    expect(createdBody).toMatchObject({
      title: "[作業] API接続",
      labels: ["type/work", "merge/self"],
    });
  });
});

function dependencies(fetchImpl: GitHubFetch): GitHubAppDependencies {
  return new GitHubAppDependencies({
    appId: "12345",
    installationId: "99",
    privateKey,
    repository: "rozwer/arttra-git-lab",
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
