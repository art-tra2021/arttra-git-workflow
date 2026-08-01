import { describe, expect, test } from "bun:test";
import { buildCreateIssueCommand } from "../src/issue-command.ts";

describe("Issue作成command", () => {
  test("SlackとAIが共有できる安定したJSONへ変換する", () => {
    const command = buildCreateIssueCommand({
      issueType: "work",
      title: " SlackからIssueを作る ",
      purpose: " TUIを開かずに仕事を登録する ",
      completionConditions: "- Issueが作成される\n- URLが返る",
      actor: "U123",
    });
    expect(command).toEqual({
      schemaVersion: 1,
      kind: "issue.create",
      issueType: "work",
      title: "SlackからIssueを作る",
      purpose: "TUIを開かずに仕事を登録する",
      completionConditions: ["Issueが作成される", "URLが返る"],
      actor: "U123",
    });
  });

  test("目的のないIssueを拒否する", () => {
    expect(() =>
      buildCreateIssueCommand({
        issueType: "intake",
        title: "相談",
        purpose: "",
        completionConditions: "",
        actor: "U123",
      }),
    ).toThrow("Issueの目的を入力してください");
  });
});
