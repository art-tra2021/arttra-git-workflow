import { describe, expect, test } from "bun:test";
import { parseIssueUrl } from "../src/app.ts";
import { buildIssueCreateInput } from "../src/github-shared.ts";
import { buildCreateIssueCommand } from "../src/issue-command.ts";
import {
  GENERIC_ISSUE_TEMPLATE,
  issueTemplate,
  resolveIssueTemplate,
} from "../src/issue-schema.ts";

describe("Issue作成command", () => {
  test("SlackとAIが共有できる安定したJSONへ変換する", () => {
    const command = buildCreateIssueCommand({
      repository: "art-tra2021/arttra-git-workflow",
      template: "task",
      title: " SlackからIssueを作る ",
      fields: {
        parent: "",
        action: " Slackから作成できる ",
        done: "- [ ] Issueが作成される",
        boundaries: "Slack adapterのみ",
        merge: "自分でマージ可",
      },
      relationships: { parent: "86" },
      actor: "U123",
      schema: issueTemplate("task"),
    });
    expect(command).toEqual({
      schemaVersion: 1,
      kind: "issue.create",
      repository: "art-tra2021/arttra-git-workflow",
      template: "task",
      title: "SlackからIssueを作る",
      fields: {
        parent: "",
        action: "Slackから作成できる",
        done: "- [ ] Issueが作成される",
        boundaries: "Slack adapterのみ",
        merge: "自分でマージ可",
      },
      actor: "U123",
      assigneeSlackUserIds: [],
      reviewerSlackUserIds: [],
      relationships: {
        parent: { repository: "art-tra2021/arttra-git-workflow", number: 86 },
        blockedBy: [],
        blocking: [],
      },
    });
  });

  test("Project #8のfield入力をversion付きcommandへ保持する", () => {
    const command = buildCreateIssueCommand({
      repository: "art-tra2021/arttra-git-workflow",
      template: "intake",
      title: "Project field入力",
      fields: { summary: "同期する", urgency: "通常" },
      actor: "U123",
      projectFields: {
        priority: "P1",
        size: "L",
        startDate: "2026-08-04",
        targetDate: "2026-08-10",
        status: "Intake",
      },
      schema: issueTemplate("intake"),
    });
    expect(command.projectFields).toEqual({
      priority: "P1",
      size: "L",
      startDate: "2026-08-04",
      targetDate: "2026-08-10",
      status: "Intake",
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

  test("repository側Task templateに項目がなくても共通のマージ方針をJSONへ保持する", () => {
    const command = buildCreateIssueCommand({
      repository: "art-tra2021/service",
      template: "task",
      title: "共通方針",
      fields: { action: "運用を統一する" },
      mergeMode: "緊急マージ（事後レビュー必須）",
      relationships: { parent: "42" },
      actor: "U123",
      schema: {
        id: "task",
        name: "PR実装タスク",
        titlePrefix: "[Task] ",
        labels: ["type/task"],
        fields: [{ id: "action", label: "実装", kind: "textarea", required: true }],
      },
    });
    expect(command.fields.merge).toBe("緊急マージ（事後レビュー必須）");
    expect(command.relationships?.parent?.number).toBe(42);
  });

  test("workとbusinessは親Intakeが必須の成果Issueにする", () => {
    const schema = {
      id: "work",
      name: "作業",
      titlePrefix: "[Work] ",
      labels: ["type/work"],
      fields: [{ id: "outcome", label: "成果", kind: "textarea" as const, required: true }],
    };
    expect(() =>
      buildCreateIssueCommand({
        repository: "art-tra2021/service",
        template: "work",
        title: "親なしWork",
        fields: { outcome: "成果" },
        actor: "U123",
        schema,
      }),
    ).toThrow("親Intakeを指定してください");

    const decomposed = buildCreateIssueCommand({
      repository: "art-tra2021/service",
      template: "work",
      title: "Intakeから分解したWork",
      fields: { outcome: "成果" },
      relationships: { parent: "42" },
      actor: "U123",
      schema,
    });
    expect(decomposed.relationships?.parent?.number).toBe(42);
  });

  test("古いWork templateのmerge項目とlabelを成果Issueへ引き継がない", () => {
    const schema = {
      id: "work",
      name: "旧Work",
      titlePrefix: "[Work] ",
      labels: ["type/work", "merge/review"],
      fields: [
        { id: "outcome", label: "成果", kind: "textarea" as const, required: true },
        { id: "merge", label: "マージ方式", kind: "select" as const, required: true },
      ],
    };
    const command = buildCreateIssueCommand({
      repository: "art-tra2021/service",
      template: "work",
      title: "成果",
      fields: {
        outcome: "成果を調整する",
        merge: "自分でマージ可",
      },
      relationships: { parent: "42" },
      actor: "U123",
      schema,
    });
    expect(command.fields).not.toHaveProperty("merge");

    const createInput = buildIssueCreateInput(command, schema);
    expect(createInput.labels).toEqual(["type/work"]);
    expect(createInput.body).not.toContain("マージ方式");
  });

  test("親Issueとブロック関係を構造化してcommandへ保持する", () => {
    const command = buildCreateIssueCommand({
      repository: "art-tra2021/arttra-git-workflow",
      template: "task",
      title: "関係を付ける",
      fields: {
        parent: "",
        action: "依存関係を設定する",
        done: "- [ ] native relationが付く",
      },
      relationships: {
        parent: "42",
        blockedBy: "art-tra2021/other#8",
        blocking: "43,44",
      },
      actor: "U123",
      schema: issueTemplate("task"),
    });
    expect(command.relationships).toEqual({
      parent: { repository: "art-tra2021/arttra-git-workflow", number: 42 },
      blockedBy: [{ repository: "art-tra2021/other", number: 8 }],
      blocking: [
        { repository: "art-tra2021/arttra-git-workflow", number: 43 },
        { repository: "art-tra2021/arttra-git-workflow", number: 44 },
      ],
    });
    expect(command.fields.parent).toBe("");
  });

  test("taskは専用親Issue入力がなければ作成できない", () => {
    expect(() =>
      buildCreateIssueCommand({
        repository: "art-tra2021/arttra-git-workflow",
        template: "task",
        title: "親なし",
        fields: { parent: "", action: "作業", done: "- [ ] 完了" },
        actor: "U123",
        schema: issueTemplate("task"),
      }),
    ).toThrow("Taskには親Work / Businessを指定してください");
  });

  test("テンプレート未導入repositoryでは標準Issueを構造化できる", () => {
    const schema = resolveIssueTemplate([], GENERIC_ISSUE_TEMPLATE.id);
    expect(schema).toEqual(GENERIC_ISSUE_TEMPLATE);
    const command = buildCreateIssueCommand({
      repository: "art-tra2021/no-template",
      template: GENERIC_ISSUE_TEMPLATE.id,
      title: "標準Issue",
      fields: { summary: "テンプレート導入前の相談", done: "" },
      actor: "U123",
      schema: GENERIC_ISSUE_TEMPLATE,
    });
    expect(command.template).toBe("generic");
    expect(command.fields.summary).toBe("テンプレート導入前の相談");
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
