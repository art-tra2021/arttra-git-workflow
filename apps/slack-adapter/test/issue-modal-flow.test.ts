import { describe, expect, test } from "bun:test";
import {
  issueDetailModal,
  issueFieldValues,
  issueProjectFieldValues,
  issueRelationshipValues,
  issueRepositoryPickerModal,
  openIssueRepositoryFlow,
  parseProjectProjectionCommand,
  repositoryOptions,
  selectedRepositoryValue,
  selectedValue,
  transitionIssueModal,
} from "../src/app.ts";
import { type IssueTemplateSchema, issueTemplate } from "../src/issue-schema.ts";

describe("Slack Issue modal flow", () => {
  test("Project投影commandをrepo/allとList/Canvasへ決定的に変換する", () => {
    expect(parseProjectProjectionCommand("project", "art-tra2021/default")).toEqual({
      kind: "list",
      scope: { kind: "repo", repository: "art-tra2021/default" },
    });
    expect(parseProjectProjectionCommand("canvas repo art-tra2021/sales")).toEqual({
      kind: "canvas",
      scope: { kind: "repo", repository: "art-tra2021/sales" },
    });
    expect(parseProjectProjectionCommand("canvas all")).toEqual({
      kind: "canvas",
      scope: { kind: "all-accessible" },
    });
    expect(() => parseProjectProjectionCommand("project")).toThrow("repositoryを指定");
    expect(parseProjectProjectionCommand("unknown command")).toBeNull();
  });

  test("初回モーダルを外部API待ちなしで開きrepository cacheを検索する", () => {
    const modal = issueRepositoryPickerModal(
      "C123",
      "https://hooks.slack.test/response",
      "T123",
      "art-tra2021/arttra-git-workflow",
    );
    expect(modal.blocks[0]?.element).toMatchObject({
      type: "external_select",
      action_id: "ar.issue.repository.options",
      min_query_length: 0,
      initial_option: { value: "art-tra2021/arttra-git-workflow" },
    });
    expect(
      repositoryOptions(
        ["art-tra2021/arttra-git-workflow", "art-tra2021/frontend", "other/example"],
        "ART-TRA2021/FRONT",
      ),
    ).toEqual([
      {
        text: { type: "plain_text", text: "art-tra2021/frontend" },
        value: "art-tra2021/frontend",
      },
    ]);
  });

  test("既定repositoryが候補にあれば初期選択と候補先頭へ優先する", async () => {
    const updates: unknown[] = [];
    await openIssueRepositoryFlow({
      views: {
        open: async () => ({ view: { id: "V-default" } }),
        update: async (input) => updates.push(input),
      },
      listRepositories: async () => [".2B-tyodai", "art-tra2021/arttra-git-workflow", "zeta/repo"],
      defaultRepository: "art-tra2021/arttra-git-workflow",
      triggerId: "trigger-default",
      channelId: "C123",
      responseUrl: "https://hooks.slack.test/response",
      slackTeamId: "T123",
    });

    const element = (
      updates[0] as {
        view: {
          blocks: Array<{
            element: {
              initial_option: { value: string };
              options: Array<{ value: string }>;
            };
          }>;
        };
      }
    ).view.blocks[0]?.element;
    if (!element) throw new Error("Repository pickerのelementがありません");
    expect(element.initial_option.value).toBe("art-tra2021/arttra-git-workflow");
    expect(element.options[0]?.value).toBe("art-tra2021/arttra-git-workflow");
  });

  test("アクセスできない既定repositoryを候補へ追加しない", () => {
    expect(
      repositoryOptions([".2B-tyodai", "zeta/repo"], "", "art-tra2021/arttra-git-workflow").map(
        (candidate) => candidate.value,
      ),
    ).toEqual([".2B-tyodai", "zeta/repo"]);
  });

  test("外部選択のaction IDからrepositoryを読み取り欠落を拒否する", () => {
    expect(
      selectedValue(
        {
          repository: {
            "ar.issue.repository.options": {
              selected_option: { value: "art-tra2021/arttra-git-workflow" },
            },
          },
        },
        "repository",
        "ar.issue.repository.options",
      ),
    ).toBe("art-tra2021/arttra-git-workflow");
    expect(() => selectedValue({}, "repository", "ar.issue.repository.options")).toThrow(
      "repositoryが選択されていません",
    );
  });

  test("新旧どちらのrepository選択payloadも読み取る", () => {
    expect(
      selectedRepositoryValue({
        repository: {
          value: { selected_option: { value: "art-tra2021/sales-ops" } },
        },
      }),
    ).toBe("art-tra2021/sales-ops");
    expect(
      selectedRepositoryValue({
        repository: {
          "ar.issue.repository.options": {
            selected_option: { value: "art-tra2021/arttra-git-workflow" },
          },
        },
      }),
    ).toBe("art-tra2021/arttra-git-workflow");
    expect(() => selectedRepositoryValue({})).toThrow("repositoryが選択されていません");
  });

  test("task templateの内容に依存せずPR確認方法を明示する", () => {
    const schema: IssueTemplateSchema = {
      id: "task",
      name: "PR実装タスク",
      titlePrefix: "[Task] ",
      labels: ["type/task"],
      fields: [{ id: "action", label: "実装", kind: "textarea", required: true }],
    };
    const modal = issueDetailModal(
      {
        channelId: "C123",
        responseUrl: "https://hooks.slack.test/response",
        slackTeamId: "T123",
        repository: "art-tra2021/work",
        template: "task",
      },
      schema,
    );
    const rendered = JSON.stringify(modal);
    expect(rendered).toContain("PRの確認方法");
    expect(rendered).toContain("通常レビュー（既定）");
    expect(rendered).toContain("自分でマージ可");
    expect(rendered).toContain("緊急マージ（事後レビュー必須）");
    expect(rendered).toContain("セルフマージは事前承認を待ちません");
    expect(rendered).toContain("project-priority");
    expect(rendered).toContain("project-size");
    expect(rendered).toContain("project-start-date");
    expect(rendered).toContain("project-target-date");
    expect(rendered).toContain("project-status");
  });

  test("Slack native入力をProject field commandへ変換する", () => {
    expect(
      issueProjectFieldValues({
        "project-priority": { value: { selected_option: { value: "P1" } } },
        "project-size": { value: { selected_option: { value: "L" } } },
        "project-start-date": { value: { value: "2026-08-04" } },
        "project-target-date": { value: { value: "2026-08-10" } },
        "project-status": { value: { selected_option: { value: "Ready" } } },
      }),
    ).toEqual({
      priority: "P1",
      size: "L",
      startDate: "2026-08-04",
      targetDate: "2026-08-10",
      status: "Ready",
    });
  });

  test("task templateのmerge項目を送信時に二重読取しない", () => {
    expect(
      issueFieldValues(
        {
          parent: { value: { value: "" } },
          action: { value: { value: "実装" } },
          done: { value: { value: "- [ ] 完了" } },
          boundaries: { value: { value: "adapterのみ" } },
        },
        issueTemplate("task"),
      ),
    ).toEqual({
      parent: "",
      action: "実装",
      done: "- [ ] 完了",
      boundaries: "adapterのみ",
    });
  });

  test("旧Work templateのtop-level階層項目を送信時に読み取らない", () => {
    expect(
      issueFieldValues(
        { outcome: { value: { value: "成果" } } },
        {
          id: "work",
          name: "旧Work",
          titlePrefix: "[Work] ",
          labels: ["type/work"],
          fields: [
            {
              id: "hierarchy",
              label: "階層",
              kind: "select",
              required: true,
              options: ["Intakeから分解する", "最上位として作る"],
            },
            { id: "outcome", label: "成果", kind: "textarea", required: true },
          ],
        },
      ),
    ).toEqual({ outcome: "成果" });
  });

  test("TaskはWork/Business親、WorkはIntake親を案内する", () => {
    const taskModal = issueDetailModal(
      {
        channelId: "C123",
        responseUrl: "https://hooks.slack.test/response",
        slackTeamId: "T123",
        repository: "art-tra2021/work",
        template: "task",
      },
      issueTemplate("task"),
    );
    const blockIds = taskModal.blocks.flatMap((block) =>
      "block_id" in block ? [block.block_id] : [],
    );
    expect(blockIds).toContain("relationship-parent");
    expect(blockIds).toContain("relationship-blocked-by");
    expect(blockIds).toContain("relationship-blocking");
    expect(JSON.stringify(taskModal)).toContain("type/work または type/business");

    const workModal = issueDetailModal(
      {
        channelId: "C123",
        responseUrl: "https://hooks.slack.test/response",
        slackTeamId: "T123",
        repository: "art-tra2021/work",
        template: "work",
      },
      issueTemplate("work"),
    );
    const workBlockIds = workModal.blocks.flatMap((block) =>
      "block_id" in block ? [block.block_id] : [],
    );
    expect(workBlockIds).toContain("relationship-parent");
    expect(workBlockIds).toContain("relationship-blocked-by");
    const renderedWork = JSON.stringify(workModal);
    expect(renderedWork).not.toContain("最上位として作る");
    expect(renderedWork).toContain("type/intake");
  });

  test("共通関係blocksをCreateIssueCommand用の入力へ変換する", () => {
    expect(
      issueRelationshipValues({
        "relationship-parent": { value: { value: "42" } },
        "relationship-blocked-by": { value: { value: "7,8" } },
        "relationship-blocking": { value: { value: "9" } },
      }),
    ).toEqual({ parent: "42", blockedBy: "7,8", blocking: "9" });
    expect(issueRelationshipValues({})).toEqual({});
  });

  test("短寿命のtrigger_idをrepository取得より先に使用する", async () => {
    const events: string[] = [];
    const updates: Array<{ view_id: string; view: unknown }> = [];

    await openIssueRepositoryFlow({
      views: {
        open: async (input) => {
          events.push(`open:${input.trigger_id}`);
          return { view: { id: "V123" } };
        },
        update: async (input) => {
          events.push(`update:${input.view_id}`);
          updates.push(input);
        },
      },
      listRepositories: async () => {
        events.push("repositories");
        return ["art-tra2021/frontend", "art-tra2021/backend"];
      },
      triggerId: "trigger-123",
      channelId: "C123",
      responseUrl: "https://hooks.slack.test/response",
      slackTeamId: "T123",
    });

    expect(events).toEqual(["open:trigger-123", "repositories", "update:V123"]);
    expect(JSON.stringify(updates[0]?.view)).toContain("art-tra2021/frontend");
  });

  test("repository取得失敗を開いたモーダル内で日本語案内する", async () => {
    const updates: Array<{ view_id: string; view: unknown }> = [];

    await openIssueRepositoryFlow({
      views: {
        open: async () => ({ view: { id: "V123" } }),
        update: async (input) => {
          updates.push(input);
        },
      },
      listRepositories: async () => {
        throw new Error("GitHub APIが一時的に応答しませんでした。");
      },
      triggerId: "trigger-123",
      channelId: "C123",
      responseUrl: "https://hooks.slack.test/response",
      slackTeamId: "T123",
    });

    const updated = JSON.stringify(updates[0]?.view);
    expect(updated).toContain("GitHub APIが一時的に応答しませんでした。");
    expect(updated).toContain("/ar new を再実行してください");
  });

  test("Slackがview IDを返さない場合は処理を止める", async () => {
    await expect(
      openIssueRepositoryFlow({
        views: {
          open: async () => ({ view: null }),
          update: async () => undefined,
        },
        listRepositories: async () => ["art-tra2021/frontend"],
        triggerId: "trigger-123",
        channelId: "C123",
        responseUrl: "https://hooks.slack.test/response",
        slackTeamId: "T123",
      }),
    ).rejects.toThrow("Issue作成モーダルのIDをSlackから取得できませんでした。");
  });

  test("次へでは外部APIを待つ前に読み込み画面でackする", async () => {
    const events: string[] = [];
    const updates: Array<{ view_id: string; view: unknown }> = [];

    await transitionIssueModal({
      ack: async (input) => {
        events.push("ack");
        expect(JSON.stringify(input.view)).toContain("Issue種別を取得しています");
      },
      views: {
        open: async () => ({ view: { id: "unused" } }),
        update: async (input) => {
          events.push("update");
          updates.push(input);
        },
      },
      viewId: "V123",
      loadingText: "Issue種別を取得しています…",
      loadNextView: async () => {
        events.push("load");
        return { type: "modal", title: "Issue種別" };
      },
    });

    expect(events).toEqual(["ack", "load", "update"]);
    expect(updates[0]?.view).toEqual({ type: "modal", title: "Issue種別" });
  });

  test("次画面の取得失敗も開いているモーダル内で案内する", async () => {
    const updates: Array<{ view_id: string; view: unknown }> = [];

    await transitionIssueModal({
      ack: async () => undefined,
      views: {
        open: async () => ({ view: { id: "unused" } }),
        update: async (input) => {
          updates.push(input);
        },
      },
      viewId: "V123",
      loadingText: "入力項目を取得しています…",
      loadNextView: async () => {
        throw new Error("Issue templateを取得できませんでした。");
      },
    });

    const updated = JSON.stringify(updates[0]?.view);
    expect(updated).toContain("Issue templateを取得できませんでした。");
    expect(updated).toContain("/ar new を再実行してください");
  });
});
