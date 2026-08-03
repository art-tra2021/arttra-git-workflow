import { describe, expect, test } from "bun:test";
import {
  issueReferenceArgument,
  normalizeIssueRelationships,
  parseIssueReference,
  parseIssueReferences,
  parseIssueRelationships,
} from "../src/issue-relationships.ts";

const repository = "art-tra2021/arttra-git-workflow";

describe("Issueの親子・依存関係parser", () => {
  test("番号、短縮表記、URLを同じ構造へ正規化して重複を除く", () => {
    expect(
      parseIssueReferences(
        "123, #123\nart-tra2021/other#7, https://github.com/art-tra2021/other/issues/7",
        repository,
      ),
    ).toEqual([
      { repository, number: 123 },
      { repository: "art-tra2021/other", number: 7 },
    ]);
  });

  test("Issue以外のURLや不正な番号を拒否する", () => {
    expect(() =>
      parseIssueReference("https://github.com/art-tra2021/repo/pull/7", repository),
    ).toThrow("Issue関係の形式が不正です");
    expect(() => parseIssueReference("0", repository)).toThrow("Issue関係の形式が不正です");
    expect(() =>
      parseIssueReference("https://example.com/art-tra2021/repo/issues/7", repository),
    ).toThrow("Issue関係の形式が不正です");
  });

  test("専用入力を優先し、旧template fieldは後方互換として読み取る", () => {
    expect(
      parseIssueRelationships(
        { parent: "art-tra2021/parent#4", blockedBy: "5,6", blocking: "7" },
        { parent: "99", blocked_by: "100", blocking: "101" },
        repository,
      ),
    ).toEqual({
      parent: { repository: "art-tra2021/parent", number: 4 },
      blockedBy: [
        { repository, number: 5 },
        { repository, number: 6 },
      ],
      blocking: [{ repository, number: 7 }],
    });
    expect(
      parseIssueRelationships(undefined, { parent: "8", blocked_by: "9" }, repository),
    ).toEqual({
      parent: { repository, number: 8 },
      blockedBy: [{ repository, number: 9 }],
      blocking: [],
    });
  });

  test("ghには同一repositoryの番号、cross-repositoryにはcanonical URLを渡す", () => {
    expect(issueReferenceArgument({ repository, number: 12 }, repository)).toBe("12");
    expect(
      issueReferenceArgument({ repository: "art-tra2021/other", number: 13 }, repository),
    ).toBe("https://github.com/art-tra2021/other/issues/13");
  });

  test("AIから受け取った構造化JSONもrepositoryと番号を決定的に検証する", () => {
    expect(
      normalizeIssueRelationships(
        {
          parent: { repository: "ART-TRA2021/work", number: 4 },
          blockedBy: [
            { repository: "art-tra2021/work", number: 5 },
            { repository: "art-tra2021/work", number: 5 },
          ],
          blocking: [],
        },
        repository,
      ),
    ).toEqual({
      parent: { repository: "ART-TRA2021/work", number: 4 },
      blockedBy: [{ repository: "art-tra2021/work", number: 5 }],
      blocking: [],
    });
    expect(() =>
      normalizeIssueRelationships(
        {
          parent: null,
          blockedBy: [{ repository: "art-tra2021/work", number: Number.MAX_SAFE_INTEGER + 1 }],
          blocking: [],
        },
        repository,
      ),
    ).toThrow("Issue番号が不正です");
  });
});
