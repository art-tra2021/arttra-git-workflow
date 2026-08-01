import { App } from "@slack/bolt";
import { buildCreateIssueCommand } from "./issue-command.ts";
import { workItemBlocks } from "./presentation.ts";
import type { CreatedIssue, CreateIssueCommand, HumanWorkItem } from "./types.ts";

export interface SlackAdapterDependencies {
  loadWorkItems(slackUserId: string): Promise<HumanWorkItem[]>;
  claimIssue(issueNumber: number, slackUserId: string): Promise<HumanWorkItem>;
  createIssue(command: CreateIssueCommand): Promise<CreatedIssue>;
}

export interface SlackAppOptions {
  token: string;
  signingSecret: string;
}

export function createSlackApp(
  dependencies: SlackAdapterDependencies,
  options: SlackAppOptions,
): App {
  const app = new App({ token: options.token, signingSecret: options.signingSecret });

  app.command("/ar", async ({ ack, client, command, respond }) => {
    await ack();
    if (["new", "issue"].includes(command.text.trim().toLowerCase())) {
      await client.views.open({
        trigger_id: command.trigger_id,
        view: issueCreateModal(command.channel_id),
      });
      return;
    }
    const items = await dependencies.loadWorkItems(command.user_id);
    const visible = items.filter((item) => item.delivery !== "silent");

    if (visible.length === 0) {
      await respond({ response_type: "ephemeral", text: "今すぐ対応が必要な仕事はありません。" });
      return;
    }

    await respond({
      response_type: "ephemeral",
      text: `次に確認する仕事は${visible.length}件です。`,
      blocks: visible.slice(0, 5).flatMap(workItemBlocks),
    });
  });

  app.view("ar.issue.create", async ({ ack, body, client, view }) => {
    await ack();
    try {
      const command = buildCreateIssueCommand({
        issueType: selectedValue(
          view.state.values,
          "issue_type",
          "value",
        ) as CreateIssueCommand["issueType"],
        title: inputValue(view.state.values, "title", "value"),
        purpose: inputValue(view.state.values, "purpose", "value"),
        completionConditions: inputValue(view.state.values, "completion", "value"),
        actor: body.user.id,
      });
      const issue = await dependencies.createIssue(command);
      await client.chat.postEphemeral({
        channel: view.private_metadata,
        user: body.user.id,
        text: `Issue #${issue.number}を作成しました: ${issue.url}`,
      });
    } catch (error) {
      await client.chat.postEphemeral({
        channel: view.private_metadata,
        user: body.user.id,
        text: error instanceof Error ? error.message : "Issueを作成できませんでした",
      });
    }
  });

  app.action("ar.claim", async ({ ack, action, body, respond }) => {
    await ack();
    if (action.type !== "button") {
      return;
    }
    const issueNumber = Number(action.value);
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
      await respond({ response_type: "ephemeral", text: "Issue番号を読み取れませんでした。" });
      return;
    }

    const item = await dependencies.claimIssue(issueNumber, body.user.id);
    await respond({
      response_type: "ephemeral",
      text: `#${issueNumber}を担当に設定しました。`,
      blocks: workItemBlocks(item),
      replace_original: false,
    });
  });

  return app;
}

function issueCreateModal(channelId: string) {
  return {
    type: "modal" as const,
    callback_id: "ar.issue.create",
    private_metadata: channelId,
    title: { type: "plain_text" as const, text: "Issueを作成" },
    submit: { type: "plain_text" as const, text: "作成" },
    close: { type: "plain_text" as const, text: "キャンセル" },
    blocks: [
      {
        type: "input" as const,
        block_id: "issue_type",
        label: { type: "plain_text" as const, text: "Issue種別" },
        element: {
          type: "static_select" as const,
          action_id: "value",
          initial_option: {
            text: { type: "plain_text" as const, text: "とりあえず相談" },
            value: "intake",
          },
          options: [
            { text: { type: "plain_text" as const, text: "とりあえず相談" }, value: "intake" },
            { text: { type: "plain_text" as const, text: "実行する仕事" }, value: "work" },
            { text: { type: "plain_text" as const, text: "営業・事業" }, value: "business" },
          ],
        },
      },
      issueInput("title", "タイトル", false),
      issueInput("purpose", "目的", true),
      issueInput("completion", "完了条件（1行に1つ）", true, true),
    ],
  };
}

function issueInput(blockId: string, label: string, multiline: boolean, optional = false) {
  return {
    type: "input" as const,
    block_id: blockId,
    optional,
    label: { type: "plain_text" as const, text: label },
    element: { type: "plain_text_input" as const, action_id: "value", multiline },
  };
}

function inputValue(
  values: Record<string, Record<string, { value?: string | null }>>,
  blockId: string,
  actionId: string,
): string {
  return values[blockId]?.[actionId]?.value ?? "";
}

function selectedValue(
  values: Record<string, Record<string, { selected_option?: { value: string } | null }>>,
  blockId: string,
  actionId: string,
): string {
  return values[blockId]?.[actionId]?.selected_option?.value ?? "intake";
}
