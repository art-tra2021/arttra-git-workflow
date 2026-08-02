import { describe, expect, test } from "bun:test";
import { parseIssueUrl } from "../src/app.ts";
import { buildCreateIssueCommand } from "../src/issue-command.ts";
import { issueTemplate } from "../src/issue-schema.ts";

describe("Issue作成command", () => {
  test("SlackとAIが共有できる安定したJSONへ変換する", () => {
    const command = buildCreateIssueCommand({
      repository: "art-tra2021/arttra-git-workflow",
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
      repository: "art-tra2021/arttra-git-workflow",
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
      assigneeSlackUserIds: [],
      reviewerSlackUserIds: [],
    });
  });

  test("templateの必須項目がないIssueを拒否する", () => {
    expect(() =>
      buildCreateIssueCommand({
        repository: "art-tra2021/arttra-git-workflow",
        template: "intake",
        title: "相談",
        fields: { summary: "", urgency: "通常" },
        actor: "U123",
        schema: issueTemplate("intake"),
      }),
    ).toThrow("何がありましたかを入力してください");
  });

  test("repository側templateに項目がなくても共通のマージ方針をJSONへ保持する", () => {
    const command = buildCreateIssueCommand({
      repository: "art-tra2021/service",
      template: "work",
      title: "共通方針",
      fields: { outcome: "運用を統一する" },
      mergeMode: "緊急マージ（事後レビュー必須）",
      actor: "U123",
      schema: {
        id: "work",
        name: "作業",
        titlePrefix: "[Work] ",
        labels: ["type/work"],
        fields: [{ id: "outcome", label: "成果", kind: "textarea", required: true }],
      },
    });
    expect(command.fields.merge).toBe("緊急マージ（事後レビュー必須）");
  });
});

describe("Issue URL", () => {
  test("Project横断の着手先repositoryと番号を確定する", () => {
    expect(parseIssueUrl("https://github.com/art-tra2021/service/issues/42")).toEqual({
      repository: "art-tra2021/service",
      number: 42,
    });
    expect(parseIssueUrl("42")).toBeNull();
    expect(parseIssueUrl("https://example.com/art-tra2021/service/issues/42")).toBeNull();
  });
});
