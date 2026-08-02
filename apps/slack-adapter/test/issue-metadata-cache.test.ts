import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IssueMetadataCache, type IssueMetadataSource } from "../src/issue-metadata-cache.ts";
import type { IssueTemplateSchema } from "../src/issue-schema.ts";
import { LocalStateStore } from "../src/state-store.ts";

const template: IssueTemplateSchema = {
  id: "work",
  name: "作業",
  titlePrefix: "[Work] ",
  labels: ["type/work"],
  fields: [],
};

describe("Issue metadata cache", () => {
  test("別instanceでもFirestore相当のstoreから読みGitHubへ再取得しない", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-metadata-")));
    const first = new IssueMetadataCache(source(), store);
    expect(await first.refresh(["art-tra2021/work"])).toEqual({
      repositoryCount: 2,
      templateRepositoryCount: 1,
    });

    const offline: IssueMetadataSource = {
      listRepositories: async () => {
        throw new Error("GitHubを呼んではいけません");
      },
      listIssueTemplates: async () => {
        throw new Error("GitHubを呼んではいけません");
      },
    };
    const coldInstance = new IssueMetadataCache(offline, store);

    expect(await coldInstance.listRepositories()).toEqual([
      "art-tra2021/sales",
      "art-tra2021/work",
    ]);
    expect(await coldInstance.listIssueTemplates("art-tra2021/work")).toEqual([template]);
  });

  test("未知repositoryのtemplateだけを一度取得して永続化する", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-metadata-")));
    let templateCalls = 0;
    const cached = new IssueMetadataCache(
      source(async () => {
        templateCalls += 1;
        return [template];
      }),
      store,
    );

    expect(await cached.listIssueTemplates("art-tra2021/sales")).toEqual([template]);
    expect(await cached.listIssueTemplates("art-tra2021/sales")).toEqual([template]);
    const coldInstance = new IssueMetadataCache(source(), store);
    expect(await coldInstance.listIssueTemplates("art-tra2021/sales")).toEqual([template]);
    expect(templateCalls).toBe(1);
  });

  test("viewerごとにrepository候補を分離し、global cacheを権限判定へ流用しない", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-metadata-viewer-")));
    let viewerCalls = 0;
    const cached = new IssueMetadataCache(
      source(
        async () => [template],
        async (githubLogin) => {
          viewerCalls += 1;
          return githubLogin === "alice" ? ["art-tra2021/work"] : ["art-tra2021/sales"];
        },
      ),
      store,
    );

    expect(await cached.listRepositoriesForViewer("alice")).toEqual(["art-tra2021/work"]);
    expect(await cached.listRepositoriesForViewer("alice")).toEqual(["art-tra2021/work"]);
    expect(await cached.listRepositoriesForViewer("bob")).toEqual(["art-tra2021/sales"]);
    expect(viewerCalls).toBe(2);
    await expect(cached.listIssueTemplatesForViewer("alice", "art-tra2021/sales")).rejects.toThrow(
      "参照できません",
    );

    const offline: IssueMetadataSource = {
      listRepositories: async () => {
        throw new Error("global一覧を呼んではいけません");
      },
      listIssueTemplates: async () => {
        throw new Error("templateを呼んではいけません");
      },
    };
    const coldInstance = new IssueMetadataCache(offline, store);
    expect(await coldInstance.listRepositoriesForViewer("alice")).toEqual(["art-tra2021/work"]);
  });

  test("viewer-aware API未実装sourceはglobal一覧へフォールバックしない", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-metadata-deny-")));
    const cache = new IssueMetadataCache(source(), store);
    await expect(cache.listRepositoriesForViewer("alice")).rejects.toThrow(
      "権限を確認できるbackend",
    );
  });

  test("viewerのメモリcacheも5分で失効し、権限変更を再確認する", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-metadata-ttl-")));
    let now = Date.parse("2026-08-02T00:00:00Z");
    let calls = 0;
    const cache = new IssueMetadataCache(
      source(
        async () => [template],
        async () => {
          calls += 1;
          return calls === 1 ? ["art-tra2021/work"] : ["art-tra2021/sales"];
        },
      ),
      store,
      () => now,
    );

    expect(await cache.listRepositoriesForViewer("alice")).toEqual(["art-tra2021/work"]);
    now += 4 * 60_000;
    expect(await cache.listRepositoriesForViewer("alice")).toEqual(["art-tra2021/work"]);
    now += 2 * 60_000;
    expect(await cache.listRepositoriesForViewer("alice")).toEqual(["art-tra2021/sales"]);
    expect(calls).toBe(2);
  });

  test("Issue Form cacheも5分で失効して改訂を反映する", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-template-ttl-")));
    let now = Date.parse("2026-08-02T00:00:00Z");
    let calls = 0;
    const revised = { ...template, name: "改訂後の作業" };
    const cache = new IssueMetadataCache(
      source(async () => {
        calls += 1;
        return calls === 1 ? [template] : [revised];
      }),
      store,
      () => now,
    );

    expect(await cache.listIssueTemplates("art-tra2021/work")).toEqual([template]);
    now += 4 * 60_000;
    expect(await cache.listIssueTemplates("art-tra2021/work")).toEqual([template]);
    now += 2 * 60_000;
    expect(await cache.listIssueTemplates("art-tra2021/work")).toEqual([revised]);
    expect(calls).toBe(2);
  });
});

function source(
  templates: () => Promise<IssueTemplateSchema[]> = async () => [template],
  viewers?: (githubLogin: string) => Promise<string[]>,
): IssueMetadataSource {
  return {
    listRepositories: async () => ["art-tra2021/work", "art-tra2021/sales"],
    ...(viewers ? { listRepositoriesForViewer: viewers } : {}),
    listIssueTemplates: templates,
  };
}
