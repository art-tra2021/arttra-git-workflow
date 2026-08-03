import { describe, expect, test } from "bun:test";
import {
  issueDetailModal,
  issueFieldValues,
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

  test("work templateの内容に依存せずPR確認方法を明示する", () => {
    const schema: IssueTemplateSchema = {
      id: "work",
      name: "作業",
      titlePrefix: "[Work] ",
      labels: ["type/work"],
      fields: [{ id: "outcome", label: "成果", kind: "textarea", required: true }],
    };
    const modal = issueDetailModal(
      {
        channelId: "C123",
        responseUrl: "https://hooks.slack.test/response",
        slackTeamId: "T123",
        repository: "art-tra2021/work",
        template: "work",
      },
      schema,
    );
    const rendered = JSON.stringify(modal);
    expect(rendered).toContain("PRの確認方法");
    expect(rendered).toContain("通常レビュー（既定）");
    expect(rendered).toContain("自分でマージ可");
    expect(rendered).toContain("緊急マージ（事後レビュー必須）");
    expect(rendered).toContain("許可できる人へ承認依頼");
  });

  test("work templateの旧merge項目を送信時に二重読取しない", () => {
    expect(
      issueFieldValues(
        {
          background: { value: { value: "背景" } },
          outcome: { value: { value: "成果" } },
          done: { value: { value: "- [ ] 完了" } },
          blocked_by: { value: { value: "" } },
          target_date: { value: { value: "2026-08-04" } },
        },
        issueTemplate("work"),
      ),
    ).toEqual({
      background: "背景",
      outcome: "成果",
      done: "- [ ] 完了",
      blocked_by: "",
      target_date: "2026-08-04",
    });
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
