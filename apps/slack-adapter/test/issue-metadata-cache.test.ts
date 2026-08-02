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
      "art-tra2021/work",
      "art-tra2021/sales",
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
});

function source(
  templates: () => Promise<IssueTemplateSchema[]> = async () => [template],
): IssueMetadataSource {
  return {
    listRepositories: async () => ["art-tra2021/work", "art-tra2021/sales"],
    listIssueTemplates: templates,
  };
}
