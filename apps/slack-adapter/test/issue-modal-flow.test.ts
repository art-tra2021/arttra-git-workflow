import { describe, expect, test } from "bun:test";
import { openIssueRepositoryFlow } from "../src/app.ts";

describe("Slack Issue modal flow", () => {
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
});
