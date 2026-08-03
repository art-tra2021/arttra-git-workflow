import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubIdentityService, type IdentityFetch } from "../src/identity-service.ts";
import { LocalStateStore } from "../src/state-store.ts";
import type { CreateIssueCommand } from "../src/types.ts";

const NOW = Date.parse("2026-08-01T00:00:00Z");

describe("GitHubIdentityService", () => {
  test("署名stateを一度だけ使いGitHub IDとloginのみを保存する", async () => {
    const root = await mkdtemp(join(tmpdir(), "arttra-identity-"));
    const service = identityService(root);
    const url = new URL(await service.connectUrl("T123", "U123"));
    expect(url.origin).toBe("https://github.example");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    const state = url.searchParams.get("state") ?? "";

    const identity = await service.complete("oauth-code", state);
    expect(identity).toMatchObject({
      schemaVersion: 1,
      slackTeamId: "T123",
      slackUserId: "U123",
      githubUserId: 987,
      githubLogin: "octocat",
    });
    expect(identity).not.toHaveProperty("token");
    expect(await service.get("T123", "U123")).toEqual(identity);
    expect(await service.requireGitHubLogin("T123", "U123")).toBe("octocat");
    expect(service.complete("oauth-code", state)).rejects.toThrow("使用済み");
  });

  test("未連携viewerのlogin解決はglobal repository候補を返さず失敗する", async () => {
    const root = await mkdtemp(join(tmpdir(), "arttra-identity-missing-"));
    const service = identityService(root);
    await expect(service.requireGitHubLogin("T123", "U404")).rejects.toThrow(
      "<@U404> はGitHub未連携です",
    );
  });

  test("改ざんしたstateをGitHubへ送る前に拒否する", async () => {
    const root = await mkdtemp(join(tmpdir(), "arttra-identity-"));
    let requests = 0;
    const service = identityService(root, async () => {
      requests += 1;
      return Response.json({});
    });
    const url = new URL(await service.connectUrl("T123", "U123"));
    const state = url.searchParams.get("state") ?? "";
    expect(service.complete("oauth-code", `${state}x`)).rejects.toThrow("署名が一致しません");
    expect(requests).toBe(0);
  });

  test("Slack memberを検証済みGitHub loginへ変換し、未連携者をmentionする", async () => {
    const root = await mkdtemp(join(tmpdir(), "arttra-identity-"));
    const service = identityService(root);
    const url = new URL(await service.connectUrl("T123", "U123"));
    const identity = await service.complete("oauth-code", url.searchParams.get("state") ?? "");
    expect(await service.findByGitHubUserId("T123", 987)).toEqual(identity);
    const command = issueCommand({
      assigneeSlackUserIds: ["U123"],
      reviewerSlackUserIds: ["U404"],
    });
    expect(service.resolveCommand(command, "T123")).rejects.toThrow("<@U404> はGitHub未連携です");
    const resolved = await service.resolveCommand(
      { ...command, reviewerSlackUserIds: ["U123"] },
      "T123",
    );
    expect(resolved.assigneeGitHubLogins).toEqual(["octocat"]);
    expect(resolved.reviewerGitHubLogins).toEqual(["octocat"]);
    expect(resolved.reviewerGitHubUsers).toEqual([{ id: 987, login: "octocat" }]);
    expect(resolved.requesterGitHubUser).toEqual({ id: 987, login: "octocat" });
  });

  test("連携解除でmappingを削除する", async () => {
    const root = await mkdtemp(join(tmpdir(), "arttra-identity-"));
    const service = identityService(root);
    const url = new URL(await service.connectUrl("T123", "U123"));
    await service.complete("oauth-code", url.searchParams.get("state") ?? "");
    expect(await service.disconnect("T123", "U123")).toBe(true);
    expect(await service.get("T123", "U123")).toBeNull();
    expect(await service.findByGitHubUserId("T123", 987)).toBeNull();
  });

  test("別GitHubアカウントへの再連携前に旧projection失効処理を完了する", async () => {
    const root = await mkdtemp(join(tmpdir(), "arttra-identity-relink-"));
    let nonce = 0;
    let currentCode = "";
    const service = new GitHubIdentityService({
      clientId: "client-id",
      clientSecret: "client-secret",
      stateSecret: "state-secret-with-at-least-32-characters",
      publicBaseUrl: "https://slack.example",
      store: new LocalStateStore(root),
      now: () => NOW,
      nonce: () => `nonce-${++nonce}`,
      githubBaseUrl: "https://github.example",
      githubApiBaseUrl: "https://api.github.example",
      fetch: async (input, init) => {
        if (input.endsWith("/login/oauth/access_token")) {
          currentCode = String((JSON.parse(String(init?.body)) as { code: string }).code);
          return Response.json({ access_token: `token-${currentCode}` });
        }
        if (input.endsWith("/user")) {
          return Response.json(
            currentCode === "first"
              ? { id: 111, login: "old-account" }
              : { id: 222, login: "new-account" },
          );
        }
        throw new Error(`予期しないrequest: ${input}`);
      },
    });
    const firstUrl = new URL(await service.connectUrl("T123", "U123"));
    await service.complete("first", firstUrl.searchParams.get("state") ?? "");
    const secondUrl = new URL(await service.connectUrl("T123", "U123"));
    const order: string[] = [];

    const replacement = await service.complete(
      "second",
      secondUrl.searchParams.get("state") ?? "",
      async (previous, next) => {
        order.push(`${previous.githubLogin}->${next.githubLogin}`);
        expect((await service.get("T123", "U123"))?.githubLogin).toBe("old-account");
      },
    );

    expect(order).toEqual(["old-account->new-account"]);
    expect(replacement.githubLogin).toBe("new-account");
    expect((await service.get("T123", "U123"))?.githubLogin).toBe("new-account");
    expect(await service.findByGitHubUserId("T123", 111)).toBeNull();
  });
});

function identityService(root: string, fetchImpl: IdentityFetch = githubFetch()) {
  return new GitHubIdentityService({
    clientId: "client-id",
    clientSecret: "client-secret",
    stateSecret: "state-secret-with-at-least-32-characters",
    publicBaseUrl: "https://slack.example",
    store: new LocalStateStore(root),
    fetch: fetchImpl,
    now: () => NOW,
    nonce: () => "nonce-1",
    githubBaseUrl: "https://github.example",
    githubApiBaseUrl: "https://api.github.example",
  });
}

function githubFetch(): IdentityFetch {
  return async (input, init) => {
    if (input.endsWith("/login/oauth/access_token")) {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        client_id: "client-id",
        client_secret: "client-secret",
        code: "oauth-code",
      });
      return Response.json({ access_token: "temporary-user-token" });
    }
    if (input.endsWith("/user")) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer temporary-user-token");
      return Response.json({ id: 987, login: "octocat" });
    }
    throw new Error(`予期しないrequest: ${input}`);
  };
}

function issueCommand(overrides: Partial<CreateIssueCommand> = {}): CreateIssueCommand {
  return {
    schemaVersion: 1,
    kind: "issue.create",
    repository: "example/repo",
    template: "work",
    title: "identity",
    fields: { merge: "通常レビュー（既定）" },
    actor: "U123",
    slackTeamId: "T123",
    ...overrides,
  };
}
