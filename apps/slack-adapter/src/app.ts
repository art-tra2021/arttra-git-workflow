import { App, type Receiver } from "@slack/bolt";
import {
  decidePrivilegedMerge,
  type IssueApprovalService,
  requiresIssueApproval,
} from "./approval.ts";
import type { GoogleCalendarService } from "./google-calendar-service.ts";
import type { GitHubIdentityService } from "./identity-service.ts";
import { buildCreateIssueCommand, MERGE_MODES } from "./issue-command.ts";
import type { IssueMetadataSource } from "./issue-metadata-cache.ts";
import type { IssueTemplateId, IssueTemplateSchema } from "./issue-schema.ts";
import { workItemBlocks } from "./presentation.ts";
import type {
  CreatedIssue,
  CreateIssueCommand,
  HumanWorkItem,
  RepositoryPermission,
} from "./types.ts";

const ISSUE_REPOSITORY_ACTION_ID = "ar.issue.repository.options";

export interface SlackAdapterDependencies {
  listRepositories(): Promise<string[]>;
  listIssueTemplates(repository: string): Promise<IssueTemplateSchema[]>;
  loadWorkItems(slackUserId: string): Promise<HumanWorkItem[]>;
  claimIssue(repository: string, issueNumber: number, slackUserId: string): Promise<HumanWorkItem>;
  createIssue(command: CreateIssueCommand): Promise<CreatedIssue>;
  validateIssueAuthorization(command: CreateIssueCommand): Promise<void>;
  repositoryPermission(repository: string, githubLogin: string): Promise<RepositoryPermission>;
}

export interface SlackAppOptions {
  token: string;
  signingSecret?: string;
  appToken?: string;
  socketMode?: boolean;
  approverUserIds?: string[];
  selfApproverUserIds?: string[];
  defaultRepository?: string;
  approvalService: IssueApprovalService;
  identityService: GitHubIdentityService;
  googleCalendarService?: GoogleCalendarService;
  issueMetadata?: IssueMetadataSource;
  syncProjectList?: (
    channelId: string,
    requesterUserId?: string,
  ) => Promise<{
    listId: string;
    itemCount: number;
    created: number;
    updated: number;
    deleted: number;
  }>;
  receiver?: Receiver;
  tokenVerificationEnabled?: boolean;
}

export function createSlackApp(
  dependencies: SlackAdapterDependencies,
  options: SlackAppOptions,
): App {
  const approvers = new Set(options.approverUserIds ?? []);
  const selfApprovers = new Set(options.selfApproverUserIds ?? []);
  const issueMetadata = options.issueMetadata ?? dependencies;
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
    const normalized = command.text.trim().toLowerCase();
    if (["new", "issue"].includes(normalized)) {
      try {
        await client.views.open({
          trigger_id: command.trigger_id,
          view: issueRepositoryPickerModal(
            command.channel_id,
            command.response_url,
            command.team_id,
            options.defaultRepository,
          ),
        });
        await ack();
      } catch (error) {
        await ack();
        await respond({
          response_type: "ephemeral",
          text: error instanceof Error ? error.message : "Issue作成画面を開けませんでした。",
        });
      }
      return;
    }
    await ack();
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
    if (normalized === "connect google") {
      if (!options.googleCalendarService) {
        await respond({
          response_type: "ephemeral",
          text: "Google Calendar連携はまだ管理者により設定されていません。",
        });
        return;
      }
      const url = await options.googleCalendarService.connectUrl(command.team_id, command.user_id);
      await respond({
        response_type: "ephemeral",
        text: `Google Calendarを連携してください: ${url}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "本人がGitHub Projectsで担当する未完了・期限付き項目だけを、専用の `ART-TRA Work` カレンダーへ同期します。既存の予定は読みません。",
            },
            accessory: {
              type: "button",
              text: { type: "plain_text", text: "Calendarと連携" },
              url,
              action_id: "ar.google.connect.open",
            },
          },
        ],
      });
      return;
    }
    if (normalized === "disconnect google") {
      if (!options.googleCalendarService) {
        await respond({
          response_type: "ephemeral",
          text: "Google Calendar連携はまだ管理者により設定されていません。",
        });
        return;
      }
      const removed = await options.googleCalendarService.disconnect(
        command.team_id,
        command.user_id,
      );
      await respond({
        response_type: "ephemeral",
        text: removed
          ? "Google Calendar連携を解除しました。作成済みの専用カレンダーは履歴として残ります。"
          : "Google Calendarは連携されていません。",
      });
      return;
    }
    if (["calendar", "calendar sync"].includes(normalized)) {
      if (!options.googleCalendarService) {
        await respond({
          response_type: "ephemeral",
          text: "Google Calendar連携はまだ管理者により設定されていません。",
        });
        return;
      }
      try {
        const result = await options.googleCalendarService.syncUser(
          command.team_id,
          command.user_id,
        );
        await respond({
          response_type: "ephemeral",
          text: `自分のCalendarを同期しました。対象${result.itemCount}件 / 新規${result.created}件 / 更新${result.updated}件 / 予定から除外${result.deleted}件`,
        });
      } catch (error) {
        await respond({
          response_type: "ephemeral",
          text: error instanceof Error ? error.message : "Google Calendarを同期できませんでした。",
        });
      }
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
    if (
      ["project", "project sync", "list", "list sync", "canvas", "canvas sync"].includes(normalized)
    ) {
      if (!options.syncProjectList) {
        await respond({
          response_type: "ephemeral",
          text: "Project List同期が設定されていません。",
        });
        return;
      }
      try {
        const result = await options.syncProjectList(command.channel_id, command.user_id);
        await respond({
          response_type: "ephemeral",
          text: `Project Listを同期しました。対象${result.itemCount}件 / 新規${result.created}件 / 更新${result.updated}件 / 削除${result.deleted}件 / List ID: ${result.listId}`,
        });
      } catch (error) {
        await respond({
          response_type: "ephemeral",
          text: error instanceof Error ? error.message : "Project Listを同期できませんでした。",
        });
      }
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

  app.action("ar.google.connect.open", async ({ ack }) => {
    await ack();
  });

  app.action("ar.review.open", async ({ ack }) => {
    await ack();
  });

  app.options(ISSUE_REPOSITORY_ACTION_ID, async ({ ack, options: request }) => {
    try {
      const repositories = await issueMetadata.listRepositories();
      await ack({ options: repositoryOptions(repositories, request.value) });
    } catch (error) {
      console.error(
        error instanceof Error ? error.message : "repository一覧を取得できませんでした。",
      );
      await ack({ options: [] });
    }
  });

  app.view("ar.issue.repository", async ({ ack, client, view }) => {
    const metadata = parseMetadata(view.private_metadata);
    const repository = selectedValue(view.state.values, "repository", ISSUE_REPOSITORY_ACTION_ID);
    await transitionIssueModal({
      ack: ack as unknown as IssueModalAck,
      views: client.views as unknown as IssueModalViews,
      viewId: view.id,
      loadingText: "Issue種別を取得しています…",
      loadNextView: async () => {
        const templates = await issueMetadata.listIssueTemplates(repository);
        return issueTemplateModal({ ...metadata, repository }, templates);
      },
    });
  });

  app.view("ar.issue.prepare", async ({ ack, client, view }) => {
    const metadata = parseMetadata(view.private_metadata);
    const template = selectedValue(view.state.values, "template", "value") as IssueTemplateId;
    await transitionIssueModal({
      ack: ack as unknown as IssueModalAck,
      views: client.views as unknown as IssueModalViews,
      viewId: view.id,
      loadingText: "入力項目を取得しています…",
      loadNextView: async () => {
        const schema = (await issueMetadata.listIssueTemplates(metadata.repository)).find(
          (candidate) => candidate.id === template,
        );
        if (!schema) {
          throw new Error(`Issue templateが見つかりません: ${template}`);
        }
        return issueDetailModal({ ...metadata, template }, schema);
      },
    });
  });

  app.view("ar.issue.create", async ({ ack, body, view }) => {
    const metadata = parseMetadata(view.private_metadata);
    await ack();
    try {
      const schema = (await issueMetadata.listIssueTemplates(metadata.repository)).find(
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
        ...(metadata.template === "work"
          ? { mergeMode: selectedValue(view.state.values, "merge-policy", "value") }
          : {}),
        schema,
      });
      let approvalReason: string | null = null;
      if (requiresIssueApproval(command)) {
        const identity = await options.identityService.get(metadata.slackTeamId, body.user.id);
        let permission: RepositoryPermission = "none";
        if (identity) {
          try {
            permission = await dependencies.repositoryPermission(
              command.repository,
              identity.githubLogin,
            );
          } catch {
            approvalReason =
              "GitHubのrepository権限を確認できなかったため、安全側で承認を要求します。";
          }
        }
        const decision = decidePrivilegedMerge(
          body.user.id,
          selfApprovers,
          identity?.githubLogin ?? null,
          permission,
        );
        if (!decision.direct) {
          approvalReason ??= decision.reason;
        }
      }
      if (approvalReason) {
        if (approvers.size === 0) {
          throw new Error("このマージ方式には承認が必要ですが、承認者が設定されていません。");
        }
        const approval = await options.approvalService.request(command, body.user.id);
        await requestIssueApproval(
          metadata.responseUrl,
          approval.id,
          command,
          approvers,
          approvalReason,
        );
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
    if (action.type !== "button" || !action.value) {
      return;
    }
    const target = parseIssueUrl(action.value);
    if (!target) {
      await respond({ response_type: "ephemeral", text: "Issue URLを読み取れませんでした。" });
      return;
    }

    const item = await dependencies.claimIssue(target.repository, target.number, body.user.id);
    await respond({
      response_type: "ephemeral",
      text: `${target.repository}#${target.number}を担当に設定しました。`,
      blocks: workItemBlocks(item),
      replace_original: false,
    });
  });

  return app;
}

export function parseIssueUrl(value: string): { repository: string; number: number } | null {
  const match = value.match(
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)\/?$/,
  );
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { repository: match[1], number: Number(match[2]) };
}

interface IssueModalMetadata {
  channelId: string;
  responseUrl: string;
  slackTeamId: string;
  repository: string;
  template: IssueTemplateId;
}

interface IssueModalViews {
  open(input: { trigger_id: string; view: unknown }): Promise<{
    view?: { id?: string | null } | null;
  }>;
  update(input: { view_id: string; view: unknown }): Promise<unknown>;
}

type IssueModalAck = (input: { response_action: "update"; view: unknown }) => Promise<void>;

interface IssueRepositoryFlowOptions {
  views: IssueModalViews;
  listRepositories(): Promise<string[]>;
  triggerId: string;
  channelId: string;
  responseUrl: string;
  slackTeamId: string;
}

export async function openIssueRepositoryFlow(options: IssueRepositoryFlowOptions): Promise<void> {
  const opened = await options.views.open({
    trigger_id: options.triggerId,
    view: issueLoadingModal("Repositoryを取得しています…"),
  });
  const viewId = opened.view?.id;
  if (!viewId) {
    throw new Error("Issue作成モーダルのIDをSlackから取得できませんでした。");
  }

  let nextView: unknown;
  try {
    const repositories = await options.listRepositories();
    nextView = issueRepositoryModal(
      options.channelId,
      options.responseUrl,
      options.slackTeamId,
      repositories,
    );
  } catch (error) {
    nextView = issueErrorModal(
      error instanceof Error ? error.message : "repository一覧を取得できませんでした。",
    );
  }
  await options.views.update({ view_id: viewId, view: nextView });
}

interface IssueModalTransitionOptions {
  ack: IssueModalAck;
  views: IssueModalViews;
  viewId: string;
  loadingText: string;
  loadNextView(): Promise<unknown>;
}

export async function transitionIssueModal(options: IssueModalTransitionOptions): Promise<void> {
  await options.ack({
    response_action: "update",
    view: issueLoadingModal(options.loadingText),
  });

  let nextView: unknown;
  try {
    nextView = await options.loadNextView();
  } catch (error) {
    nextView = issueErrorModal(
      error instanceof Error ? error.message : "Issue作成画面を取得できませんでした。",
    );
  }
  await options.views.update({ view_id: options.viewId, view: nextView });
}

function issueLoadingModal(message: string) {
  return {
    type: "modal" as const,
    title: { type: "plain_text" as const, text: "Issueを作成" },
    close: { type: "plain_text" as const, text: "キャンセル" },
    blocks: [
      {
        type: "section" as const,
        text: { type: "plain_text" as const, text: message },
      },
    ],
  };
}

function issueErrorModal(message: string) {
  return {
    type: "modal" as const,
    title: { type: "plain_text" as const, text: "Issueを作成" },
    close: { type: "plain_text" as const, text: "閉じる" },
    blocks: [
      {
        type: "section" as const,
        text: {
          type: "plain_text" as const,
          text: `${message.slice(0, 2500)}\n\n少し待ってから /ar new を再実行してください。`,
        },
      },
    ],
  };
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

export function issueRepositoryPickerModal(
  channelId: string,
  responseUrl: string,
  slackTeamId: string,
  defaultRepository?: string,
) {
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
          type: "external_select" as const,
          action_id: ISSUE_REPOSITORY_ACTION_ID,
          min_query_length: 0,
          placeholder: { type: "plain_text" as const, text: "Repositoryを選択" },
          ...(defaultRepository
            ? { initial_option: option(defaultRepository, defaultRepository) }
            : {}),
        },
      },
    ],
  };
}

export function repositoryOptions(repositories: string[], query: string) {
  const normalized = query.trim().toLowerCase();
  return repositories
    .filter((repository) => !normalized || repository.toLowerCase().includes(normalized))
    .slice(0, 100)
    .map((repository) => option(repository, repository));
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

export function issueDetailModal(metadata: IssueModalMetadata, schema: IssueTemplateSchema) {
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
      ...schema.fields
        .filter((field) => field.id !== "merge")
        .map((field) =>
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
      ...(schema.id === "work" ? [issueMergePolicy()] : []),
      issueMembers("assignees", "担当者"),
      issueMembers("reviewers", "予定レビュワー"),
    ],
  };
}

function issueMergePolicy() {
  const descriptions: Record<string, string> = {
    "通常レビュー（既定）": "PR作成者以外の承認を受けてからマージします。",
    自分でマージ可: "許可された人だけ直通し、それ以外はSlackで承認を求めます。",
    "緊急マージ（事後レビュー必須）": "緊急時用です。権限確認またはSlack承認が必要です。",
  };
  return {
    type: "input" as const,
    block_id: "merge-policy",
    label: { type: "plain_text" as const, text: "PRの確認方法" },
    hint: {
      type: "plain_text" as const,
      text: "権限が足りない指定は拒否せず、許可できる人へ承認依頼を送ります。",
    },
    element: {
      type: "static_select" as const,
      action_id: "value",
      initial_option: describedOption(
        MERGE_MODES[0],
        MERGE_MODES[0],
        descriptions[MERGE_MODES[0]] ?? "",
      ),
      options: MERGE_MODES.map((mode) => describedOption(mode, mode, descriptions[mode] ?? "")),
    },
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

function describedOption(text: string, value: string, description: string) {
  return {
    text: { type: "plain_text" as const, text },
    value,
    description: { type: "plain_text" as const, text: description },
  };
}

function inputValue(
  values: Record<string, Record<string, { value?: string | null }>>,
  blockId: string,
  actionId: string,
): string {
  return values[blockId]?.[actionId]?.value ?? "";
}

export function selectedValue(
  values: Record<string, Record<string, { selected_option?: { value: string } | null }>>,
  blockId: string,
  actionId: string,
): string {
  const value = values[blockId]?.[actionId]?.selected_option?.value;
  if (!value) {
    throw new Error(`${blockId}が選択されていません。もう一度選択してください。`);
  }
  return value;
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
  reason: string,
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
            text: `${mentions}\n<@${command.actor}> からIssue作成の承認申請です。\n*作成先:* ${command.repository}\n*タイトル:* ${command.title}\n*マージ方式:* ${mergeMode}\n*承認が必要な理由:* ${reason}`,
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
