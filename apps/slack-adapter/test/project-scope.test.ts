import { describe, expect, test } from "bun:test";
import {
  allAccessibleScope,
  assertSharedProjectionBinding,
  filterItemsByAccessibleRepositories,
  projectionStateKey,
  repositoryScope,
  validateProjectionBinding,
} from "../src/project-scope.ts";

describe("Project projection scope", () => {
  test("all-accessibleは共有channelを拒否し、本人user ACLだけを受け付ける", () => {
    expect(() =>
      validateProjectionBinding({
        teamId: "T123",
        viewerId: "U123",
        target: { kind: "channel", id: "C123" },
        kind: "canvas",
        scope: allAccessibleScope(),
      }),
    ).toThrow("all-accessibleの投影を共有channelへ公開できません");

    expect(
      validateProjectionBinding({
        teamId: "T123",
        viewerId: "U123",
        target: { kind: "user", id: "U123" },
        kind: "canvas",
        scope: allAccessibleScope(),
      }),
    ).toMatchObject({ target: { kind: "user", id: "U123" }, scope: { kind: "all-accessible" } });
  });

  test("state keyはteam/viewer/target/kind/scopeの差を衝突させない", () => {
    const base = {
      teamId: "T123",
      viewerId: "U123",
      target: { kind: "user" as const, id: "U123" },
      kind: "canvas" as const,
      scope: repositoryScope("art-tra2021/work"),
    };
    const keys = [
      projectionStateKey(base),
      projectionStateKey({ ...base, viewerId: "U456", target: { kind: "user", id: "U456" } }),
      projectionStateKey({ ...base, kind: "list" }),
      projectionStateKey({ ...base, scope: repositoryScope("art-tra2021/other") }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("viewerがアクセスできないrepositoryの項目をURLではなくrepository正本で除外する", () => {
    const items = [
      {
        repository: "art-tra2021/allowed",
        url: "https://github.com/art-tra2021/wrong/issues/1",
      },
      {
        repository: "art-tra2021/private",
        url: "https://github.com/art-tra2021/allowed/issues/2",
      },
    ];
    expect(filterItemsByAccessibleRepositories(items, ["art-tra2021/allowed"])).toEqual([
      {
        repository: "art-tra2021/allowed",
        url: "https://github.com/art-tra2021/wrong/issues/1",
      },
    ]);
  });

  test("共有投影は環境へ固定したchannelとrepositoryの組以外を拒否する", () => {
    expect(() =>
      assertSharedProjectionBinding({
        channelId: "COTHER",
        configuredChannelId: "CSHARED",
        repository: "art-tra2021/work",
        configuredRepository: "art-tra2021/work",
      }),
    ).toThrow("未登録channel");
    expect(() =>
      assertSharedProjectionBinding({
        channelId: "CSHARED",
        configuredChannelId: "CSHARED",
        repository: "art-tra2021/private",
        configuredRepository: "art-tra2021/work",
      }),
    ).toThrow("repositoryはart-tra2021/workに固定");
    expect(() =>
      assertSharedProjectionBinding({
        channelId: "CSHARED",
        configuredChannelId: "CSHARED",
        repository: "ART-TRA2021/WORK",
        configuredRepository: "art-tra2021/work",
      }),
    ).not.toThrow();
  });
});
