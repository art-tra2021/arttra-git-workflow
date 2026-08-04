import { App, type Receiver } from "@slack/bolt";
import {
  decidePrivilegedMerge,
  type IssueApprovalService,
  requiresIssueApproval,
} from "./approval.ts";
import type { GoogleCalendarService } from "./google-calendar-service.ts";
import { type GitHubIdentityService, MissingGitHubIdentityError } from "./identity-service.ts";
import { buildCreateIssueCommand, MERGE_MODES } from "./issue-command.ts";
import type { IssueMetadataSource } from "./issue-metadata-cache.ts";
import {
  hasIssueRelationships,
  ISSUE_RELATIONSHIP_FIELD_IDS,
  type IssueRelationshipInput,
  type IssueRelationships,
  issueReferenceLabel,
} from "./issue-relationships.ts";
import {
  GENERIC_ISSUE_TEMPLATE,
  type IssueTemplateId,
  type IssueTemplateSchema,
} from "./issue-schema.ts";
import { workItemBlocks } from "./presentation.ts";
import { allAccessibleScope, type RepositoryScope, repositoryScope } from "./project-scope.ts";
import {
  approvalDecisionMessage,
  approvalRequestMessage,
  selfMergeStoppedMessage,
} from "./slack-action-message.ts";
import { slackDivider, slackHeader, slackPlain } from "./slack-message-style.ts";
import type { SlackRequirementNotifier } from "./slack-requirement-notifier.ts";
import type {
  CreatedIssue,
  CreateIssueCommand,
  HumanWorkItem,
  RepositoryPermission,
} from "./types.ts";

const ISSUE_REPOSITORY_ACTION_ID = "ar.issue.repository.options";

export interface SlackAdapterDependencies extends IssueMetadataSource {
  loadWorkItems(slackUserId: string): Promise<HumanWorkItem[]>;
  claimIssue(
    repository: string,
    issueNumber: number,
    slackUserId: string,
    viewerGitHubLogin?: string,
  ): Promise<HumanWorkItem>;
  createIssue(command: CreateIssueCommand): Promise<CreatedIssue>;
  validateIssueAuthorization(command: CreateIssueCommand): Promise<void>;
  repositoryPermission(repository: string, githubLogin: string): Promise<RepositoryPermission>;
  stopSelfMerge?(
    repository: string,
    issueNumber: number,
    actorLogin: string,
    reason: string,
  ): Promise<{ number: number; title: string; url: string; assigneeLogins: string[] }>;
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
  revokeProjectProjections?: (slackTeamId: string, slackUserId: string) => Promise<void>;
  requirementNotifier?: Pick<SlackRequirementNotifier, "requireGitHubConnection">;
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
  syncProjectProjection?: (request: ProjectProjectionRequest) => Promise<ProjectProjectionResult>;
  receiver?: Receiver;
  tokenVerificationEnabled?: boolean;
  resolveSlackUserId?: (githubLogin: string) => Promise<string | null>;
}

export interface ProjectProjectionRequest {
  kind: "list" | "canvas";
  scope: RepositoryScope;
  channelId: string;
  slackTeamId: string;
  slackUserId: string;
}

export interface ProjectProjectionResult {
  kind: "list" | "canvas";
  resourceId: string;
  itemCount: number;
  created: number;
  updated: number;
  deleted: number;
  unchanged?: boolean;
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
  const issueTemplatesForViewer = async (
    slackTeamId: string,
    slackUserId: string,
    repository: string,
  ) => {
    const githubLogin = await options.identityService.requireGitHubLogin(slackTeamId, slackUserId);
    if (!issueMetadata.listIssueTemplatesForViewer) {
      throw new Error("repositoryごとのGitHub権限を確認できるbackendが設定されていません。");
    }
    const templates = await issueMetadata.listIssueTemplatesForViewer(githubLogin, repository);
    return templates.length > 0 ? templates : [GENERIC_ISSUE_TEMPLATE];
  };

  app.command("/ar", async ({ ack, client, command, respond }) => {
    const normalized = command.text.trim().toLowerCase();
    if (["new", "issue"].includes(normalized)) {
      await ack();
      try {
        await openIssueRepositoryFlow({
          views: client.views as unknown as IssueModalViews,
          listRepositories: async () => {
            const githubLogin = await options.identityService.requireGitHubLogin(
              command.team_id,
              command.user_id,
            );
            if (!issueMetadata.listRepositoriesForViewer) {
              throw new Error(
                "repositoryごとのGitHub権限を確認できるbackendが設定されていません。",
              );
            }
            return issueMetadata.listRepositoriesForViewer(githubLogin);
          },
          ...(options.defaultRepository ? { defaultRepository: options.defaultRepository } : {}),
          triggerId: command.trigger_id,
          channelId: command.channel_id,
          responseUrl: command.response_url,
          slackTeamId: command.team_id,
        });
      } catch (error) {
        await respond({
          response_type: "ephemeral",
          text: slackPlain(
            "error",
            error instanceof Error ? error.message : "Issue作成画面を開けませんでした。",
          ),
        });
      }
      return;
    }
    await ack();
    if (normalized === "connect github") {
      const url = await options.identityService.connectUrl(command.team_id, command.user_id);
      await respond({
        response_type: "ephemeral",
        text: slackPlain("action", `GitHubアカウントを連携してください: ${url}`),
        blocks: [
          slackHeader("action", "GitHub連携"),
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
      await options.revokeProjectProjections?.(command.team_id, command.user_id);
      const removed = await options.identityService.disconnect(command.team_id, command.user_id);
      await respond({
        response_type: "ephemeral",
        text: slackPlain(
          removed ? "success" : "info",
          removed
            ? "GitHubアカウント連携を解除しました。"
            : "GitHubアカウントは連携されていません。",
        ),
      });
      return;
    }
    if (normalized === "connect google") {
      if (!options.googleCalendarService) {
        await respond({
          response_type: "ephemeral",
          text: slackPlain("warning", "Google Calendar連携はまだ管理者により設定されていません。"),
        });
        return;
      }
      const url = await options.googleCalendarService.connectUrl(command.team_id, command.user_id);
      await respond({
        response_type: "ephemeral",
        text: slackPlain("action", `Google Calendarを連携してください: ${url}`),
        blocks: [
          slackHeader("action", "Google Calendar連携"),
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
          text: slackPlain("warning", "Google Calendar連携はまだ管理者により設定されていません。"),
        });
        return;
      }
      const removed = await options.googleCalendarService.disconnect(
        command.team_id,
        command.user_id,
      );
      await respond({
        response_type: "ephemeral",
        text: slackPlain(
          removed ? "success" : "info",
          removed
            ? "Google Calendar連携を解除しました。作成済みの専用カレンダーは履歴として残ります。"
            : "Google Calendarは連携されていません。",
        ),
      });
      return;
    }
    if (["calendar", "calendar sync"].includes(normalized)) {
      if (!options.googleCalendarService) {
        await respond({
          response_type: "ephemeral",
          text: slackPlain("warning", "Google Calendar連携はまだ管理者により設定されていません。"),
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
          text: slackPlain(
            "success",
            `自分のCalendarを同期しました。対象${result.itemCount}件 / 新規${result.created}件 / 更新${result.updated}件 / 予定から除外${result.deleted}件`,
          ),
        });
      } catch (error) {
        await respond({
          response_type: "ephemeral",
          text: slackPlain(
            "error",
            error instanceof Error ? error.message : "Google Calendarを同期できませんでした。",
          ),
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
          ? slackPlain("info", `\`\`\`${JSON.stringify(approval, null, 2)}\`\`\``)
          : slackPlain("warning", "指定された承認申請は見つかりません。"),
      });
      return;
    }
    let projectionRequest: Pick<ProjectProjectionRequest, "kind" | "scope"> | null;
    try {
      projectionRequest = parseProjectProjectionCommand(command.text, options.defaultRepository);
    } catch (error) {
      await respond({
        response_type: "ephemeral",
        text: slackPlain("error", projectProjectionErrorMessage(error)),
      });
      return;
    }
    if (projectionRequest) {
      if (!options.syncProjectProjection) {
        await respond({
          response_type: "ephemeral",
          text: slackPlain("warning", "Project投影が設定されていません。"),
        });
        return;
      }
      try {
        const result = await options.syncProjectProjection({
          ...projectionRequest,
          channelId: command.channel_id,
          slackTeamId: command.team_id,
          slackUserId: command.user_id,
        });
        const label = result.kind === "canvas" ? "Canvas" : "List";
        await respond({
          response_type: "ephemeral",
          text: slackPlain(
            "success",
            `Project ${label}を同期しました。対象${result.itemCount}件 / 新規${result.created}件 / 更新${result.updated}件 / 削除${result.deleted}件${result.unchanged ? " / 変更なし" : ""} / ${label} ID: ${result.resourceId}`,
          ),
        });
      } catch (error) {
        await respond({
          response_type: "ephemeral",
          text: slackPlain("error", projectProjectionErrorMessage(error)),
        });
      }
      return;
    }
    const items = await dependencies.loadWorkItems(command.user_id);
    const visible = items.filter((item) => item.delivery !== "silent");

    if (visible.length === 0) {
      await respond({
        response_type: "ephemeral",
        text: slackPlain("success", "今すぐ対応が必要な仕事はありません。"),
      });
      return;
    }

    await respond({
      response_type: "ephemeral",
      text: slackPlain("digest", `次に確認する仕事は${visible.length}件です。`),
      blocks: [
        slackHeader("digest", `次に確認する仕事（${visible.length}件）`),
        slackDivider(),
        ...visible.slice(0, 5).flatMap(workItemBlocks),
      ],
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

  app.options(ISSUE_REPOSITORY_ACTION_ID, async ({ ack, body, options: request }) => {
    try {
      const suggestion = body as unknown as {
        team?: { id?: string };
        user?: { id?: string };
      };
      const slackTeamId = suggestion.team?.id ?? "";
      const slackUserId = suggestion.user?.id ?? "";
      const githubLogin = await options.identityService.requireGitHubLogin(
        slackTeamId,
        slackUserId,
      );
      if (!issueMetadata.listRepositoriesForViewer) {
        throw new Error("repository権限を確認できません。");
      }
      const repositories = await issueMetadata.listRepositoriesForViewer(githubLogin);
      await ack({
        options: repositoryOptions(repositories, request.value, options.defaultRepository),
      });
    } catch (error) {
      console.error(
        error instanceof Error ? error.message : "repository一覧を取得できませんでした。",
      );
      await ack({ options: [] });
    }
  });

  app.view("ar.issue.repository", async ({ ack, body, client, view }) => {
    const metadata = parseMetadata(view.private_metadata);
    const repository = selectedRepositoryValue(view.state.values);
    await transitionIssueModal({
      ack: ack as unknown as IssueModalAck,
      views: client.views as unknown as IssueModalViews,
      viewId: view.id,
      loadingText: "Issue種別を取得しています…",
      loadNextView: async () => {
        const templates = await issueTemplatesForViewer(
          metadata.slackTeamId,
          body.user.id,
          repository,
        );
        return issueTemplateModal({ ...metadata, repository }, templates);
      },
    });
  });

  app.view("ar.issue.prepare", async ({ ack, body, client, view }) => {
    const metadata = parseMetadata(view.private_metadata);
    const template = selectedValue(view.state.values, "template", "value") as IssueTemplateId;
    await transitionIssueModal({
      ack: ack as unknown as IssueModalAck,
      views: client.views as unknown as IssueModalViews,
      viewId: view.id,
      loadingText: "入力項目を取得しています…",
      loadNextView: async () => {
        const schema = (
          await issueTemplatesForViewer(metadata.slackTeamId, body.user.id, metadata.repository)
        ).find((candidate) => candidate.id === template);
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
      const schema = (
        await issueTemplatesForViewer(metadata.slackTeamId, body.user.id, metadata.repository)
      ).find((candidate) => candidate.id === metadata.template);
      if (!schema) {
        throw new Error(`Issue templateが見つかりません: ${metadata.template}`);
      }
      const fields = issueFieldValues(view.state.values, schema);
      const command = buildCreateIssueCommand({
        repository: metadata.repository,
        template: metadata.template,
        title: inputValue(view.state.values, "title", "value"),
        fields,
        relationships: issueRelationshipValues(view.state.values),
        actor: body.user.id,
        slackTeamId: metadata.slackTeamId,
        assigneeSlackUserIds: selectedUsers(view.state.values, "assignees", "value"),
        reviewerSlackUserIds: selectedUsers(view.state.values, "reviewers", "value"),
        ...(metadata.template === "task"
          ? { mergeMode: selectedValue(view.state.values, "merge-policy", "value") }
          : {}),
        schema,
      });
      const resolved = await options.identityService.resolveCommand(command, metadata.slackTeamId);
      let approvalReason: string | null = null;
      if (resolved.fields.merge === "自分でマージ可") {
        const identity = await options.identityService.get(metadata.slackTeamId, body.user.id);
        let permission: RepositoryPermission = "none";
        if (identity) {
          permission = await dependencies.repositoryPermission(
            command.repository,
            identity.githubLogin,
          );
        }
        const decision = decidePrivilegedMerge(
          body.user.id,
          selfApprovers,
          identity?.githubLogin ?? null,
          permission,
        );
        if (!decision.direct) {
          throw new Error(
            `セルフマージを直接指定する権限がありません。${decision.reason} 通常レビューを選ぶか、管理者へ設定を依頼してください。`,
          );
        }
      } else if (requiresIssueApproval(resolved)) {
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
        const approval = await options.approvalService.request(resolved, body.user.id);
        await requestIssueApproval(
          metadata.responseUrl,
          approval.id,
          resolved,
          approvers,
          approvalReason,
        );
        return;
      }
      const issue = await dependencies.createIssue(resolved);
      const result = issueCreateNotification(
        issue,
        `Issue #${issue.number}を作成しました: ${issue.url}`,
        "success",
      );
      await respondToCommand(metadata.responseUrl, slackPlain(result.tone, result.text));
    } catch (error) {
      if (error instanceof MissingGitHubIdentityError && options.requirementNotifier) {
        try {
          await options.requirementNotifier.requireGitHubConnection({
            channelId: metadata.channelId,
            slackTeamId: metadata.slackTeamId,
            slackUserIds: error.slackUserIds,
          });
        } catch {
          // Issue作成者へのエラー応答を、案内通知の失敗で失わない。
        }
      }
      await respondToCommand(
        metadata.responseUrl,
        slackPlain("error", error instanceof Error ? error.message : "Issueを作成できませんでした"),
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
          const requesterGitHubLogin = await options.identityService.requireGitHubLogin(
            teamId,
            command.actor,
          );
          resolvedCommand = await options.identityService.resolveCommand(command, teamId);
          if (!dependencies.listRepositoriesForViewer) {
            throw new Error("repositoryごとのGitHub権限を再確認できないbackendです。");
          }
          const viewerRepositories =
            await dependencies.listRepositoriesForViewer(requesterGitHubLogin);
          if (
            !viewerRepositories.some(
              (repository) =>
                repository.toLowerCase() === resolvedCommand?.repository.toLowerCase(),
            )
          ) {
            throw new Error(
              `GitHub @${requesterGitHubLogin} は${resolvedCommand.repository}を参照できません。`,
            );
          }
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
      const teamId = "team" in body && body.team?.id ? body.team.id : "";
      const actorIdentity = teamId ? await options.identityService.get(teamId, body.user.id) : null;
      const message = approvalDecisionMessage({
        decision: "approved",
        requesterSlackUserId: approval.requester,
        actorSlackUserId: body.user.id,
        actorGitHubLogin: actorIdentity?.githubLogin ?? null,
        issue,
      });
      const result = issueCreateNotification(issue, message.text, "approved");
      await respond({
        response_type: "in_channel",
        replace_original: true,
        text: slackPlain(result.tone, result.text),
      });
    } catch (error) {
      await respond({
        response_type: "ephemeral",
        text: slackPlain(
          "error",
          error instanceof Error ? error.message : "Issueを作成できませんでした。",
        ),
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
      const teamId = "team" in body && body.team?.id ? body.team.id : "";
      const actorIdentity = teamId ? await options.identityService.get(teamId, body.user.id) : null;
      const message = approvalDecisionMessage({
        decision: "rejected",
        requesterSlackUserId: approval.requester,
        actorSlackUserId: body.user.id,
        actorGitHubLogin: actorIdentity?.githubLogin ?? null,
      });
      await respond({
        response_type: "in_channel",
        replace_original: true,
        text: slackPlain("warning", message.text),
      });
    } catch (error) {
      await respond({
        response_type: "ephemeral",
        text: slackPlain(
          "error",
          error instanceof Error ? error.message : "Issue作成申請を却下できませんでした。",
        ),
      });
    }
  });

  app.action("ar.self-merge.stop", async ({ ack, action, body, client }) => {
    await ack();
    if (action.type !== "button" || !action.value || !("trigger_id" in body)) return;
    const target = parseSelfMergeTarget(action.value);
    if (!target) return;
    const message = "message" in body ? body.message : undefined;
    const channel = "channel" in body ? body.channel : undefined;
    const channelId = channel && "id" in channel ? channel.id : "";
    const rootTs = message && "ts" in message ? (message.thread_ts ?? message.ts) : "";
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "ar.self-merge.stop.submit",
        private_metadata: JSON.stringify({ ...target, channelId, rootTs }),
        title: { type: "plain_text", text: "セルフマージ停止" },
        submit: { type: "plain_text", text: "停止する" },
        close: { type: "plain_text", text: "キャンセル" },
        blocks: [
          {
            type: "input",
            block_id: "reason",
            label: { type: "plain_text", text: "停止理由" },
            element: {
              type: "plain_text_input",
              action_id: "value",
              multiline: true,
              placeholder: { type: "plain_text", text: "レビューが必要な理由を記載してください" },
            },
          },
        ],
      },
    });
  });

  app.view("ar.self-merge.stop.submit", async ({ ack, body, view, client }) => {
    const target = parseSelfMergeTarget(view.private_metadata);
    const reason = inputValue(view.state.values, "reason", "value").trim();
    if (!target || !reason) {
      await ack({
        response_action: "errors",
        errors: { reason: "停止理由を入力してください。" },
      });
      return;
    }
    try {
      if (!dependencies.stopSelfMerge) {
        throw new Error("セルフマージ停止に対応するGitHub App backendが設定されていません。");
      }
      const teamId = "team" in body && body.team?.id ? body.team.id : "";
      const actorLogin = await options.identityService.requireGitHubLogin(teamId, body.user.id);
      const permission = await dependencies.repositoryPermission(target.repository, actorLogin);
      if (!(["write", "maintain", "admin"] as RepositoryPermission[]).includes(permission)) {
        throw new Error("セルフマージを停止するにはGitHubのwrite以上の権限が必要です。");
      }
      const issue = await dependencies.stopSelfMerge(
        target.repository,
        target.issueNumber,
        actorLogin,
        reason,
      );
      await ack();
      const ownerIds = options.resolveSlackUserId
        ? await Promise.all(issue.assigneeLogins.map(options.resolveSlackUserId))
        : [];
      const message = selfMergeStoppedMessage({
        ownerSlackUserIds: ownerIds.filter((value): value is string => Boolean(value)),
        actorSlackUserId: body.user.id,
        actorGitHubLogin: actorLogin,
        reason,
        issueUrl: issue.url,
      });
      if (target.channelId) {
        try {
          await client.chat.postMessage({
            channel: target.channelId,
            ...(target.rootTs ? { thread_ts: target.rootTs, reply_broadcast: false } : {}),
            text: slackPlain("warning", message.text),
            unfurl_links: false,
            unfurl_media: false,
          });
        } catch (error) {
          console.error(
            error instanceof Error
              ? `セルフマージ停止後のSlack通知に失敗しました: ${error.message}`
              : "セルフマージ停止後のSlack通知に失敗しました。",
          );
        }
      }
    } catch (error) {
      await ack({
        response_action: "errors",
        errors: {
          reason: error instanceof Error ? error.message : "セルフマージを停止できませんでした。",
        },
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
      await respond({
        response_type: "ephemeral",
        text: slackPlain("error", "Issue URLを読み取れませんでした。"),
      });
      return;
    }

    try {
      const slackTeamId = body.team?.id ?? "";
      const viewerGitHubLogin = await options.identityService.requireGitHubLogin(
        slackTeamId,
        body.user.id,
      );
      if (!issueMetadata.listRepositoriesForViewer) {
        throw new Error("repositoryごとのGitHub権限を確認できるbackendが設定されていません。");
      }
      const repositories = await issueMetadata.listRepositoriesForViewer(viewerGitHubLogin);
      if (
        !repositories.some(
          (repository) => repository.toLowerCase() === target.repository.toLowerCase(),
        )
      ) {
        throw new Error(`GitHub @${viewerGitHubLogin} は${target.repository}を参照できません。`);
      }
      const item = await dependencies.claimIssue(
        target.repository,
        target.number,
        body.user.id,
        viewerGitHubLogin,
      );
      await respond({
        response_type: "ephemeral",
        text: slackPlain("success", `${target.repository}#${target.number}を担当に設定しました。`),
        blocks: [
          slackHeader("success", "担当者を設定しました"),
          slackDivider(),
          ...workItemBlocks(item),
        ],
        replace_original: false,
      });
    } catch (error) {
      await respond({
        response_type: "ephemeral",
        text: slackPlain(
          "error",
          error instanceof Error ? error.message : "Issueを担当に設定できませんでした。",
        ),
      });
    }
  });

  return app;
}

function projectProjectionErrorMessage(error: unknown): string {
  const code =
    error && typeof error === "object" && "data" in error
      ? (error.data as { error?: unknown } | undefined)?.error
      : undefined;
  if (code === "missing_scope") {
    return "Slack Appの権限が不足しています。Canvasにはcanvases:write、Listにはlists:readとlists:writeを追加し、Appを再インストールしてください。";
  }
  if (
    code === "canvas_disabled_user_team" ||
    code === "free_teams_cannot_edit_standalone_canvases" ||
    code === "team_tier_cannot_create_channel_canvases"
  ) {
    return "このSlackワークスペースの契約ではCanvas APIを利用できません。List表示を使用してください。";
  }
  if (code === "access_denied" || code === "no_permission") {
    return "Slack Canvasへのアクセスを設定できません。Appの参加先とCanvas権限を確認してください。";
  }
  return error instanceof Error ? error.message : "Project投影を同期できませんでした。";
}

interface SelfMergeTarget {
  repository: string;
  issueNumber: number;
  channelId?: string;
  rootTs?: string;
}

function parseSelfMergeTarget(value: string): SelfMergeTarget | null {
  try {
    const parsed = JSON.parse(value) as Partial<SelfMergeTarget>;
    if (
      !parsed.repository ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(parsed.repository) ||
      !Number.isSafeInteger(parsed.issueNumber) ||
      Number(parsed.issueNumber) < 1
    ) {
      return null;
    }
    return {
      repository: parsed.repository,
      issueNumber: Number(parsed.issueNumber),
      ...(parsed.channelId ? { channelId: parsed.channelId } : {}),
      ...(parsed.rootTs ? { rootTs: parsed.rootTs } : {}),
    };
  } catch {
    return null;
  }
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

export function parseProjectProjectionCommand(
  value: string,
  defaultRepository?: string,
): Pick<ProjectProjectionRequest, "kind" | "scope"> | null {
  const match = value
    .trim()
    .match(/^(project|list|canvas)(?:\s+sync)?(?:\s+(all|mine|repo\s+\S+|\S+))?$/i);
  if (!match) return null;
  const kind = match[1]?.toLowerCase() === "canvas" ? "canvas" : "list";
  const rawScope = match[2]?.trim() ?? "";
  if (/^(all|mine)$/i.test(rawScope)) {
    return { kind, scope: allAccessibleScope() };
  }
  const repository = rawScope.replace(/^repo\s+/i, "").trim() || defaultRepository?.trim();
  if (!repository) {
    throw new Error(
      "repositoryを指定してください。例: `/ar canvas repo art-tra2021/example` または `/ar canvas all`",
    );
  }
  return { kind, scope: repositoryScope(repository) };
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
  defaultRepository?: string;
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
      options.defaultRepository,
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
  defaultRepository?: string,
) {
  if (repositories.length === 0) {
    throw new Error("Issueを作成できるrepositoryがありません");
  }
  const orderedRepositories = prioritizeRepository(repositories, defaultRepository);
  const firstRepository = orderedRepositories[0] ?? "";
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
          options: orderedRepositories
            .slice(0, 100)
            .map((repository) => option(repository, repository)),
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

export function repositoryOptions(
  repositories: string[],
  query: string,
  defaultRepository?: string,
) {
  const normalized = query.trim().toLowerCase();
  const ordered = prioritizeRepository(repositories, defaultRepository);
  return ordered
    .filter((repository) => !normalized || repository.toLowerCase().includes(normalized))
    .slice(0, 100)
    .map((repository) => option(repository, repository));
}

function prioritizeRepository(repositories: string[], defaultRepository?: string): string[] {
  const unique = [...new Set(repositories.map((repository) => repository.trim()).filter(Boolean))];
  const normalizedDefault = defaultRepository?.trim().toLowerCase();
  if (!normalizedDefault) return unique;
  const index = unique.findIndex((repository) => repository.toLowerCase() === normalizedDefault);
  if (index <= 0) return unique;
  const [defaultCandidate] = unique.splice(index, 1);
  return defaultCandidate ? [defaultCandidate, ...unique] : unique;
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
      ...(firstTemplate.id === GENERIC_ISSUE_TEMPLATE.id
        ? [
            {
              type: "section" as const,
              text: {
                type: "mrkdwn" as const,
                text: "⚠️ *テンプレート未導入です*\nこのrepositoryには共通のIssueテンプレートがありません。標準Issueで作成します。作成後に管理者へテンプレート導入を依頼してください。",
              },
            },
          ]
        : []),
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
        .filter(
          (field) =>
            field.id !== "merge" &&
            field.id !== "hierarchy" &&
            !ISSUE_RELATIONSHIP_FIELD_IDS.has(field.id),
        )
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
      ...issueRelationshipInputs(schema),
      ...(schema.id === "task" ? [issueMergePolicy()] : []),
      issueMembers("assignees", "担当者"),
      issueMembers("reviewers", "予定レビュワー"),
    ],
  };
}

function issueRelationshipInputs(schema: IssueTemplateSchema) {
  const parentField =
    schema.fields.find((field) => field.id === "parent") ??
    (schema.id === "task"
      ? { id: "parent", label: "親Work / Business", required: true }
      : schema.id === "work" || schema.id === "business"
        ? { id: "parent", label: "親Intake", required: true }
        : undefined);
  const parentHint =
    schema.id === "task"
      ? "type/work または type/business のIssueを、123、owner/repo#123、またはGitHub Issue URLで1件指定"
      : "type/intake のIssueを、123、owner/repo#123、またはGitHub Issue URLで1件指定";
  return [
    ...(parentField
      ? [
          issueRelationshipInput(
            "relationship-parent",
            parentField.label,
            parentField.required,
            parentHint,
          ),
        ]
      : []),
    issueRelationshipInput(
      "relationship-blocked-by",
      "ブロック元（このIssueが待つもの）",
      false,
      "複数はカンマまたは改行区切り。123、owner/repo#123、またはGitHub Issue URL",
    ),
    issueRelationshipInput(
      "relationship-blocking",
      "ブロック対象（このIssueが止めるもの）",
      false,
      "複数はカンマまたは改行区切り。123、owner/repo#123、またはGitHub Issue URL",
    ),
  ];
}

function issueRelationshipInput(blockId: string, label: string, required: boolean, hint: string) {
  return {
    type: "input" as const,
    block_id: blockId,
    optional: !required,
    label: { type: "plain_text" as const, text: label },
    hint: { type: "plain_text" as const, text: hint },
    element: {
      type: "plain_text_input" as const,
      action_id: "value",
      multiline: true,
      placeholder: {
        type: "plain_text" as const,
        text: "例: 123 または https://github.com/.../issues/123",
      },
    },
  };
}

function issueMergePolicy() {
  const descriptions: Record<string, string> = {
    "通常レビュー（既定）": "PR作成者以外の承認を受けてからマージします。",
    自分でマージ可: "本人が必須CI後にマージします。Slackへ強調通知し、権限者が停止できます。",
    "緊急マージ（事後レビュー必須）": "緊急時用です。権限確認またはSlack承認が必要です。",
  };
  return {
    type: "input" as const,
    block_id: "merge-policy",
    label: { type: "plain_text" as const, text: "PRの確認方法" },
    hint: {
      type: "plain_text" as const,
      text: "セルフマージは事前承認を待ちません。緊急マージだけ権限確認または承認が必要です。",
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

export function issueFieldValues(
  values: Record<
    string,
    Record<
      string,
      {
        value?: string | null;
        selected_option?: { value: string } | null;
      }
    >
  >,
  schema: IssueTemplateSchema,
): Record<string, string> {
  return Object.fromEntries(
    schema.fields
      .filter((field) => field.id !== "merge" && field.id !== "hierarchy")
      .map((field) => [
        field.id,
        field.kind === "select"
          ? selectedValue(values, field.id, "value")
          : inputValue(values, field.id, "value"),
      ]),
  );
}

/** 共通関係blocksの入力を、CreateIssueCommandの関係parserへ渡す。 */
export function issueRelationshipValues(
  values: Record<string, Record<string, { value?: string | null }>>,
): IssueRelationshipInput {
  const input: IssueRelationshipInput = {};
  const parent = inputValueOrUndefined(values, "relationship-parent", "value");
  const blockedBy = inputValueOrUndefined(values, "relationship-blocked-by", "value");
  const blocking = inputValueOrUndefined(values, "relationship-blocking", "value");
  if (parent !== undefined) input.parent = parent;
  if (blockedBy !== undefined) input.blockedBy = blockedBy;
  if (blocking !== undefined) input.blocking = blocking;
  return input;
}

function inputValueOrUndefined(
  values: Record<string, Record<string, { value?: string | null }>>,
  blockId: string,
  actionId: string,
): string | undefined {
  const value = values[blockId]?.[actionId]?.value;
  return value === undefined || value === null ? undefined : value;
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

export function selectedRepositoryValue(
  values: Record<string, Record<string, { selected_option?: { value: string } | null }>>,
): string {
  const repositoryActions = values.repository ?? {};
  for (const actionId of ["value", ISSUE_REPOSITORY_ACTION_ID]) {
    const value = repositoryActions[actionId]?.selected_option?.value?.trim();
    if (value) return value;
  }
  throw new Error("repositoryが選択されていません。もう一度選択してください。");
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

function issueCreateNotification(
  issue: CreatedIssue,
  text: string,
  successTone: "success" | "approved",
): { tone: "success" | "approved" | "warning"; text: string } {
  const status = issue.relationshipStatus;
  if (!status) {
    return { tone: successTone, text };
  }
  const failed = status.failed
    .map((item) => `${item.relation} ${item.reference}: ${item.message}`)
    .join("\n");
  return {
    tone: "warning",
    text: `${text}\n⚠️ Issueは作成済みですが、親Issue・依存関係の一部を反映できませんでした。\n未反映:\n${failed}`,
  };
}

function issueRelationshipSummary(relationships: IssueRelationships | undefined): string {
  if (!relationships || !hasIssueRelationships(relationships)) {
    return "";
  }
  const lines = [
    relationships.parent ? `*親Issue:* ${issueReferenceLabel(relationships.parent)}` : "",
    relationships.blockedBy.length > 0
      ? `*ブロック元:* ${relationships.blockedBy.map(issueReferenceLabel).join(", ")}`
      : "",
    relationships.blocking.length > 0
      ? `*ブロック対象:* ${relationships.blocking.map(issueReferenceLabel).join(", ")}`
      : "",
  ].filter(Boolean);
  return lines.join("\n");
}

async function requestIssueApproval(
  responseUrl: string,
  approvalId: string,
  command: CreateIssueCommand,
  approvers: ReadonlySet<string>,
  reason: string,
): Promise<void> {
  const message = approvalRequestMessage({
    approverSlackUserIds: approvers,
    requesterSlackUserId: command.actor,
    requesterGitHubLogin: command.requesterGitHubUser?.login ?? null,
  });
  const mergeMode = command.fields.merge ?? "権限昇格";
  const relationshipSummary = issueRelationshipSummary(command.relationships);
  const response = await fetch(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      response_type: "in_channel",
      replace_original: false,
      text: slackPlain("action", message.text),
      blocks: [
        slackHeader("action", "Issue作成の承認依頼"),
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${message.text}\n*作成先:* ${command.repository}\n*タイトル:* ${command.title}\n*マージ方式:* ${mergeMode}${relationshipSummary ? `\n${relationshipSummary}` : ""}\n*承認が必要な理由:* ${reason}`,
          },
        },
        slackDivider(),
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
