import { App, type Receiver } from "@slack/bolt";
import {
  canBypassIssueApproval,
  type IssueApprovalService,
  requiresIssueApproval,
} from "./approval.ts";
import type { GitHubIdentityService } from "./identity-service.ts";
import { buildCreateIssueCommand } from "./issue-command.ts";
import type { IssueTemplateId, IssueTemplateSchema } from "./issue-schema.ts";
import { workItemBlocks } from "./presentation.ts";
import type { CreatedIssue, CreateIssueCommand, HumanWorkItem } from "./types.ts";

export interface SlackAdapterDependencies {
  listRepositories(): Promise<string[]>;
  listIssueTemplates(repository: string): Promise<IssueTemplateSchema[]>;
  loadWorkItems(slackUserId: string): Promise<HumanWorkItem[]>;
  claimIssue(issueNumber: number, slackUserId: string): Promise<HumanWorkItem>;
  createIssue(command: CreateIssueCommand): Promise<CreatedIssue>;
  validateIssueAuthorization(command: CreateIssueCommand): Promise<void>;
}

export interface SlackAppOptions {
  token: string;
  signingSecret?: string;
  appToken?: string;
  socketMode?: boolean;
  approverUserIds?: string[];
  selfApproverUserIds?: string[];
  approvalService: IssueApprovalService;
  identityService: GitHubIdentityService;
  syncCanvas?: (channelId: string) => Promise<{ canvasId: string; itemCount: number }>;
  receiver?: Receiver;
  tokenVerificationEnabled?: boolean;
}

export function createSlackApp(
  dependencies: SlackAdapterDependencies,
  options: SlackAppOptions,
): App {
  const approvers = new Set(options.approverUserIds ?? []);
  const selfApprovers = new Set(options.selfApproverUserIds ?? []);
  const app = new App({
    token: options.token,
    ...(options.signingSecret ? { signingSecret: options.signingSecret } : {}),
    ...(options.appToken ? { appToken: options.appToken } : {}),
    ...(options.socketMode === undefined ? {} : { socketMode: options.socketMode }),
    ...(options.receiver ? { receiver: options.receiver } : {}),
    ...(options.tokenVerificationEnabled === undefined
      ? {}
      : { tokenVerificationEnabled: options.tokenVerificationEnabled }),
  });

  app.command("/ar", async ({ ack, client, command, respond }) => {
    await ack();
    const normalized = command.text.trim().toLowerCase();
    if (normalized === "connect github") {
      const url = await options.identityService.connectUrl(command.team_id, command.user_id);
      await respond({
        response_type: "ephemeral",
        text: `GitHubアカウントを連携してください: ${url}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "GitHubで本人確認すると、Slackの担当者・予定レビュワー選択をGitHubへ安全に反映できます。",
            },
            accessory: {
              type: "button",
              text: { type: "plain_text", text: "GitHubと連携" },
              url,
              action_id: "ar.github.connect.open",
            },
          },
        ],
      });
      return;
    }
    if (normalized === "disconnect github") {
      const removed = await options.identityService.disconnect(command.team_id, command.user_id);
      await respond({
        response_type: "ephemeral",
        text: removed
          ? "GitHubアカウント連携を解除しました。"
          : "GitHubアカウントは連携されていません。",
      });
      return;
    }
    const approvalMatch = command.text.trim().match(/^approval\s+([A-Za-z0-9-]+)$/i);
    if (approvalMatch?.[1]) {
      const approval = await options.approvalService.status(approvalMatch[1]);
      await respond({
        response_type: "ephemeral",
        text: approval
          ? `\`\`\`${JSON.stringify(approval, null, 2)}\`\`\``
          : "指定された承認申請は見つかりません。",
      });
      return;
    }
    if (["canvas", "canvas sync"].includes(normalized)) {
      if (!options.syncCanvas) {
        await respond({ response_type: "ephemeral", text: "Canvas同期が設定されていません。" });
        return;
      }
      try {
        const result = await options.syncCanvas(command.channel_id);
        await respond({
          response_type: "ephemeral",
          text: `Canvasを同期しました。対象${result.itemCount}件 / Canvas ID: ${result.canvasId}`,
        });
      } catch (error) {
        await respond({
          response_type: "ephemeral",
          text: error instanceof Error ? error.message : "Canvasを同期できませんでした。",
        });
      }
      return;
    }
    if (["new", "issue"].includes(normalized)) {
      const repositories = await dependencies.listRepositories();
      await client.views.open({
        trigger_id: command.trigger_id,
        view: issueRepositoryModal(
          command.channel_id,
          command.response_url,
          command.team_id,
          repositories,
        ),
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

  app.action("ar.github.connect.open", async ({ ack }) => {
    await ack();
  });

  app.view("ar.issue.repository", async ({ ack, view }) => {
    const metadata = parseMetadata(view.private_metadata);
    const repository = selectedValue(view.state.values, "repository", "value");
    const templates = await dependencies.listIssueTemplates(repository);
    await ack({
      response_action: "update",
      view: issueTemplateModal({ ...metadata, repository }, templates),
    });
  });

  app.view("ar.issue.prepare", async ({ ack, view }) => {
    const metadata = parseMetadata(view.private_metadata);
    const template = selectedValue(view.state.values, "template", "value") as IssueTemplateId;
    const schema = (await dependencies.listIssueTemplates(metadata.repository)).find(
      (candidate) => candidate.id === template,
    );
    if (!schema) {
      throw new Error(`Issue templateが見つかりません: ${template}`);
    }
    await ack({
      response_action: "update",
      view: issueDetailModal({ ...metadata, template }, schema),
    });
  });

  app.view("ar.issue.create", async ({ ack, body, view }) => {
    const metadata = parseMetadata(view.private_metadata);
    await ack();
    try {
      const schema = (await dependencies.listIssueTemplates(metadata.repository)).find(
        (candidate) => candidate.id === metadata.template,
      );
      if (!schema) {
        throw new Error(`Issue templateが見つかりません: ${metadata.template}`);
      }
      const command = buildCreateIssueCommand({
        repository: metadata.repository,
        template: metadata.template,
        title: inputValue(view.state.values, "title", "value"),
        fields: Object.fromEntries(
          schema.fields.map((field) => [
            field.id,
            field.kind === "select"
              ? selectedValue(view.state.values, field.id, "value")
              : inputValue(view.state.values, field.id, "value"),
          ]),
        ),
        actor: body.user.id,
        slackTeamId: metadata.slackTeamId,
        assigneeSlackUserIds: selectedUsers(view.state.values, "assignees", "value"),
        reviewerSlackUserIds: selectedUsers(view.state.values, "reviewers", "value"),
        schema,
      });
      if (requiresIssueApproval(command) && !canBypassIssueApproval(body.user.id, selfApprovers)) {
        if (approvers.size === 0) {
          throw new Error("このマージ方式には承認が必要ですが、承認者が設定されていません。");
        }
        const approval = await options.approvalService.request(command, body.user.id);
        await requestIssueApproval(metadata.responseUrl, approval.id, command, approvers);
        return;
      }
      const resolved = await options.identityService.resolveCommand(command, metadata.slackTeamId);
      const issue = await dependencies.createIssue(resolved);
      await respondToCommand(
        metadata.responseUrl,
        `Issue #${issue.number}を作成しました: ${issue.url}`,
      );
    } catch (error) {
      await respondToCommand(
        metadata.responseUrl,
        error instanceof Error ? error.message : "Issueを作成できませんでした",
      );
    }
  });

  app.action("ar.issue.approve", async ({ ack, action, body, respond }) => {
    await ack();
    if (action.type !== "button" || !action.value) {
      return;
    }
    try {
      let resolvedCommand: CreateIssueCommand | null = null;
      const approval = await options.approvalService.approve(
        action.value,
        body.user.id,
        { approvers, selfApprovers },
        async (command) => {
          const teamId = command.slackTeamId;
          if (!teamId) {
            throw new Error("承認申請のSlack workspace IDを読み取れませんでした。");
          }
          resolvedCommand = await options.identityService.resolveCommand(command, teamId);
          await dependencies.validateIssueAuthorization(resolvedCommand);
        },
        async () => {
          if (!resolvedCommand) {
            throw new Error("Issueの担当者・予定レビュワーを解決できませんでした。");
          }
          return dependencies.createIssue(resolvedCommand);
        },
      );
      const issue = approval.issue;
      if (!issue) {
        throw new Error("承認済みIssueの作成結果を読み取れませんでした。");
      }
      await respond({
        response_type: "in_channel",
        replace_original: true,
        text: `<@${body.user.id}> が承認し、Issue #${issue.number}を作成しました: ${issue.url}`,
      });
    } catch (error) {
      await respond({
        response_type: "ephemeral",
        text: error instanceof Error ? error.message : "Issueを作成できませんでした。",
      });
    }
  });

  app.action("ar.issue.reject", async ({ ack, action, body, respond }) => {
    await ack();
    if (action.type !== "button" || !action.value) {
      return;
    }
    try {
      const approval = await options.approvalService.reject(action.value, body.user.id, {
        approvers,
        selfApprovers,
      });
      await respond({
        response_type: "in_channel",
        replace_original: true,
        text: `<@${body.user.id}> がIssue作成申請を却下しました。申請者: <@${approval.requester}>`,
      });
    } catch (error) {
      await respond({
        response_type: "ephemeral",
        text: error instanceof Error ? error.message : "Issue作成申請を却下できませんでした。",
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

interface IssueModalMetadata {
  channelId: string;
  responseUrl: string;
  slackTeamId: string;
  repository: string;
  template: IssueTemplateId;
}

function issueRepositoryModal(
  channelId: string,
  responseUrl: string,
  slackTeamId: string,
  repositories: string[],
) {
  if (repositories.length === 0) {
    throw new Error("Issueを作成できるrepositoryがありません");
  }
  const firstRepository = repositories[0] ?? "";
  return {
    type: "modal" as const,
    callback_id: "ar.issue.repository",
    private_metadata: JSON.stringify({ channelId, responseUrl, slackTeamId }),
    title: { type: "plain_text" as const, text: "Issueを作成" },
    submit: { type: "plain_text" as const, text: "次へ" },
    close: { type: "plain_text" as const, text: "キャンセル" },
    blocks: [
      {
        type: "input" as const,
        block_id: "repository",
        label: { type: "plain_text" as const, text: "Repository" },
        element: {
          type: "static_select" as const,
          action_id: "value",
          initial_option: option(firstRepository, firstRepository),
          options: repositories.slice(0, 100).map((repository) => option(repository, repository)),
        },
      },
    ],
  };
}

function issueTemplateModal(metadata: IssueModalMetadata, templates: IssueTemplateSchema[]) {
  const firstTemplate = templates[0];
  if (!firstTemplate) {
    throw new Error("このrepositoryには利用可能なIssue templateがありません");
  }
  return {
    type: "modal" as const,
    callback_id: "ar.issue.prepare",
    private_metadata: JSON.stringify(metadata),
    title: { type: "plain_text" as const, text: "Issue種別を選択" },
    submit: { type: "plain_text" as const, text: "次へ" },
    close: { type: "plain_text" as const, text: "キャンセル" },
    blocks: [
      {
        type: "section" as const,
        text: { type: "mrkdwn" as const, text: `*作成先*\n${metadata.repository}` },
      },
      {
        type: "input" as const,
        block_id: "template",
        label: { type: "plain_text" as const, text: "Issue種別" },
        element: {
          type: "static_select" as const,
          action_id: "value",
          initial_option: option(firstTemplate.name, firstTemplate.id),
          options: templates.slice(0, 100).map((template) => option(template.name, template.id)),
        },
      },
    ],
  };
}

function issueDetailModal(metadata: IssueModalMetadata, schema: IssueTemplateSchema) {
  return {
    type: "modal" as const,
    callback_id: "ar.issue.create",
    private_metadata: JSON.stringify(metadata),
    title: { type: "plain_text" as const, text: schema.name },
    submit: { type: "plain_text" as const, text: "作成" },
    close: { type: "plain_text" as const, text: "キャンセル" },
    blocks: [
      {
        type: "section" as const,
        text: { type: "mrkdwn" as const, text: `*作成先*\n${metadata.repository}` },
      },
      issueInput("title", "タイトル", false),
      ...schema.fields.map((field) =>
        field.kind === "select"
          ? issueSelect(field.id, field.label, field.options ?? [], field.required)
          : issueInput(
              field.id,
              field.label,
              field.kind === "textarea",
              !field.required,
              field.initialValue,
            ),
      ),
      issueMembers("assignees", "担当者"),
      issueMembers("reviewers", "予定レビュワー"),
    ],
  };
}

function issueInput(
  blockId: string,
  label: string,
  multiline: boolean,
  optional = false,
  initialValue?: string,
) {
  return {
    type: "input" as const,
    block_id: blockId,
    optional,
    label: { type: "plain_text" as const, text: label },
    element: {
      type: "plain_text_input" as const,
      action_id: "value",
      multiline,
      ...(initialValue ? { initial_value: initialValue } : {}),
    },
  };
}

function issueSelect(blockId: string, label: string, options: string[], required: boolean) {
  return {
    type: "input" as const,
    block_id: blockId,
    optional: !required,
    label: { type: "plain_text" as const, text: label },
    element: {
      type: "static_select" as const,
      action_id: "value",
      initial_option: option(options[0] ?? "未選択", options[0] ?? ""),
      options: options.map((value) => option(value, value)),
    },
  };
}

function issueMembers(blockId: string, label: string) {
  return {
    type: "input" as const,
    block_id: blockId,
    optional: true,
    label: { type: "plain_text" as const, text: label },
    element: {
      type: "multi_users_select" as const,
      action_id: "value",
      placeholder: { type: "plain_text" as const, text: "Slackメンバーから選択" },
    },
  };
}

function option(text: string, value: string) {
  return { text: { type: "plain_text" as const, text }, value };
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

function selectedUsers(
  values: Record<string, Record<string, { selected_users?: string[] }>>,
  blockId: string,
  actionId: string,
): string[] {
  return values[blockId]?.[actionId]?.selected_users ?? [];
}

function parseMetadata(value: string): IssueModalMetadata {
  const parsed = JSON.parse(value) as Partial<IssueModalMetadata>;
  return {
    channelId: parsed.channelId ?? "",
    responseUrl: parsed.responseUrl ?? "",
    slackTeamId: parsed.slackTeamId ?? "",
    repository: parsed.repository ?? "",
    template: parsed.template ?? "intake",
  };
}

async function respondToCommand(responseUrl: string, text: string): Promise<void> {
  const response = await fetch(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }),
  });
  if (!response.ok) {
    throw new Error(`Slackへの結果通知に失敗しました: HTTP ${response.status}`);
  }
}

async function requestIssueApproval(
  responseUrl: string,
  approvalId: string,
  command: CreateIssueCommand,
  approvers: ReadonlySet<string>,
): Promise<void> {
  const mentions = [...approvers].map((id) => `<@${id}>`).join(" ");
  const mergeMode = command.fields.merge ?? "権限昇格";
  const response = await fetch(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      response_type: "in_channel",
      replace_original: false,
      text: `${mentions} Issue作成の承認をお願いします。`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${mentions}\n<@${command.actor}> からIssue作成の承認申請です。\n*作成先:* ${command.repository}\n*タイトル:* ${command.title}\n*マージ方式:* ${mergeMode}`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "ar.issue.approve",
              text: { type: "plain_text", text: "承認して作成" },
              style: "primary",
              value: approvalId,
            },
            {
              type: "button",
              action_id: "ar.issue.reject",
              text: { type: "plain_text", text: "却下" },
              style: "danger",
              value: approvalId,
            },
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`Slackへの承認依頼に失敗しました: HTTP ${response.status}`);
  }
}
