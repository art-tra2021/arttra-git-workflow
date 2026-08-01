import { describe, expect, test } from "bun:test";
import { buildCreateIssueCommand } from "../src/issue-command.ts";
import { issueTemplate } from "../src/issue-schema.ts";

describe("Issue作成command", () => {
  test("SlackとAIが共有できる安定したJSONへ変換する", () => {
    const command = buildCreateIssueCommand({
      repository: "rozwer/arttra-git-lab",
      template: "work",
      title: " SlackからIssueを作る ",
      fields: {
        background: " 手作業が必要 ",
        outcome: " Slackから作成できる ",
        done: "- [ ] Issueが作成される",
        merge: "自分でマージ可",
        blocked_by: "",
        target_date: "2026-08-15",
      },
      actor: "U123",
      schema: issueTemplate("work"),
    });
    expect(command).toEqual({
      schemaVersion: 1,
      kind: "issue.create",
      repository: "rozwer/arttra-git-lab",
      template: "work",
      title: "SlackからIssueを作る",
      fields: {
        background: "手作業が必要",
        outcome: "Slackから作成できる",
        done: "- [ ] Issueが作成される",
        merge: "自分でマージ可",
        blocked_by: "",
        target_date: "2026-08-15",
      },
      actor: "U123",
    });
  });

  test("templateの必須項目がないIssueを拒否する", () => {
    expect(() =>
      buildCreateIssueCommand({
        repository: "rozwer/arttra-git-lab",
        template: "intake",
        title: "相談",
        fields: { summary: "", urgency: "通常" },
        actor: "U123",
        schema: issueTemplate("intake"),
      }),
    ).toThrow("何がありましたかを入力してください");
  });
});
