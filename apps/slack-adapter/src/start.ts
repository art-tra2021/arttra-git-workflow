import { ExpressReceiver } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { raw } from "express";
import {
  createSlackApp,
  type ProjectProjectionRequest,
  type ProjectProjectionResult,
} from "./app.ts";
import { IssueApprovalService } from "./approval.ts";
import { type CanvasClient, CanvasProjectionService } from "./canvas-service.ts";
import { GitHubAppDependencies } from "./github-app.ts";
import { GitHubCapabilityGrants } from "./github-capabilities.ts";
import { GitHubCliDependencies } from "./github-cli.ts";
import { parseGitHubWebhookJob, verifyGitHubWebhookSignature } from "./github-webhook.ts";
import { GitHubWebhookProcessor } from "./github-webhook-processor.ts";
import { completeGoogleCalendarCallback } from "./google-calendar-callback.ts";
import { GoogleCalendarService } from "./google-calendar-service.ts";
import {
  type GitHubIdentity,
  GitHubIdentityService,
  MissingGitHubIdentityError,
} from "./identity-service.ts";
import { IssueMetadataCache } from "./issue-metadata-cache.ts";
import {
  CloudTasksGitHubJobQueue,
  type GitHubJobQueue,
  type GitHubWebhookJob,
  LocalGitHubJobQueue,
  verifyJobSignature,
} from "./job-queue.ts";
import { LifecycleNotificationService } from "./lifecycle-notification-service.ts";
import {
  DelegatingNotificationPayloadSender,
  NotificationOutboxService,
  OutboxLifecycleNotifier,
  OutboxWorkNotifier,
} from "./notification-outbox.ts";
import { NotificationThreadService } from "./notification-thread-service.ts";
import {
  ProjectProjectionAccessError,
  parseProjectCanvasSyncCommand,
  type ScheduledCanvasProjectionRequest,
  syncExistingPersonalCanvases,
} from "./project-canvas-schedule.ts";
import type { ProjectListClient } from "./project-list.ts";
import { ProjectListSyncService, parseProjectListSyncCommand } from "./project-list-service.ts";
import { filterItemsByAccessibleRepositories, normalizeRepositoryScope } from "./project-scope.ts";
import { isRetryableWorkError } from "./retryable-error.ts";
import { PullRequestReviewService } from "./review-service.ts";
import { SlackLifecycleNotifier } from "./slack-lifecycle-notifier.ts";
import {
  type SlackConversationClient,
  SlackNotificationReconciler,
} from "./slack-notification-reconciler.ts";
import { SlackRequirementNotifier } from "./slack-requirement-notifier.ts";
import { SlackReviewNotifier } from "./slack-review-notifier.ts";
import { SlackWorkNotifier } from "./slack-work-notifier.ts";
import { createStateStoreFromEnvironment } from "./state-store-factory.ts";
import { WorkNotificationService } from "./work-notification-service.ts";

const transport = (process.env.AR_SLACK_TRANSPORT ?? "socket").trim().toLowerCase();
if (transport !== "socket" && transport !== "http") {
  throw new Error("AR_SLACK_TRANSPORTはsocketまたはhttpを指定してください。");
}

const botToken = required("SLACK_BOT_TOKEN");
const repository = required("AR_GITHUB_REPO");
const githubLogin = required("AR_GITHUB_LOGIN");
const owners = (process.env.AR_GITHUB_OWNERS ?? repository.split("/")[0] ?? githubLogin)
  .split(",")
  .map((owner) => owner.trim())
  .filter(Boolean);
const project = projectConfig();
const approverUserIds = csv("AR_SLACK_APPROVER_IDS");
const selfApproverUserIds = csv("AR_SLACK_SELF_APPROVER_IDS");
const notificationReplayOperatorIds = csv("AR_NOTIFICATION_REPLAY_OPERATOR_IDS");
const githubCapabilities = GitHubCapabilityGrants.fromJson(
  process.env.AR_GITHUB_CAPABILITY_GRANTS_JSON,
);
const githubBackend = (process.env.AR_GITHUB_BACKEND ?? "cli").trim().toLowerCase();
if (githubBackend !== "cli" && githubBackend !== "app") {
  throw new Error("AR_GITHUB_BACKENDはcliまたはappを指定してください。");
}
const store = createStateStoreFromEnvironment();
const publicBaseUrl = required("AR_PUBLIC_BASE_URL");
const identityService = new GitHubIdentityService({
  clientId: required("GITHUB_OAUTH_CLIENT_ID"),
  clientSecret: required("GITHUB_OAUTH_CLIENT_SECRET"),
  stateSecret: required("AR_OAUTH_STATE_SECRET"),
  publicBaseUrl,
  store,
});
const slackTeamId = required("AR_SLACK_TEAM_ID");
const dependencies =
  githubBackend === "app"
    ? new GitHubAppDependencies({
        appId: required("GITHUB_APP_ID"),
        installationId: required("GITHUB_APP_INSTALLATION_ID"),
        privateKey: required("GITHUB_APP_PRIVATE_KEY"),
        repository,
        githubLogin,
        owners,
        project,
        resolveGitHubLogin: async (slackUserId) => {
          const identity = await identityService.get(slackTeamId, slackUserId);
          if (!identity) {
            throw new Error(
              "GitHubアカウントが未連携です。Slackで `/ar connect github` を実行してください。",
            );
          }
          return identity.githubLogin;
        },
      })
    : new GitHubCliDependencies(
        repository,
        githubLogin,
        owners,
        project,
        required("AR_SLACK_CLI_USER_ID"),
      );
const issueMetadata = new IssueMetadataCache(dependencies, store);
try {
  await issueMetadata.listRepositories();
} catch (error) {
  console.error(
    error instanceof Error
      ? `Issue repository cacheの起動時読み込みに失敗しました: ${error.message}`
      : "Issue repository cacheの起動時読み込みに失敗しました。",
  );
}
const googleCalendarSettings = googleCalendarConfig();
const googleCalendarService = googleCalendarSettings
  ? new GoogleCalendarService({
      ...googleCalendarSettings,
      stateSecret: required("AR_OAUTH_STATE_SECRET"),
      tokenEncryptionSecret: strongSecret("AR_GOOGLE_TOKEN_KEY"),
      publicBaseUrl,
      store,
      source: dependencies,
    })
  : null;
const slackClient = new WebClient(botToken);
const requirementNotifier = new SlackRequirementNotifier(slackClient, store);
const resolveSlackUserId = async (githubLoginToFind: string) => {
  const identities = await store.list<GitHubIdentity>("github-identity");
  return (
    identities.find(
      (identity) =>
        identity.slackTeamId === slackTeamId &&
        identity.githubLogin.toLowerCase() === githubLoginToFind.toLowerCase(),
    )?.slackUserId ?? null
  );
};
const approvalService = new IssueApprovalService(store, {
  ttlMilliseconds:
    positiveInteger(process.env.AR_APPROVAL_TTL_MINUTES ?? "1440", "AR_APPROVAL_TTL_MINUTES") *
    60_000,
});
const projectListService = new ProjectListSyncService(
  slackClient as unknown as ProjectListClient,
  dependencies,
  store,
  resolveSlackUserId,
);
const canvasProjectionService = new CanvasProjectionService(
  slackClient as unknown as CanvasClient,
  store,
);
const projectListChannelId = optional("AR_SLACK_PROJECT_LIST_CHANNEL_ID");
const workNotificationChannelId = optional("AR_SLACK_WORK_CHANNEL_ID") ?? projectListChannelId;
const sharedRepository = optional("AR_SLACK_SHARED_REPOSITORY");
if ((projectListChannelId || workNotificationChannelId) && !sharedRepository) {
  throw new Error(
    "共有Slack channelを使う場合はAR_SLACK_SHARED_REPOSITORYで公開を許可する単一repositoryを指定してください。",
  );
}
const sharedWorkSource = {
  loadProjectItems: async () =>
    sharedRepository
      ? filterItemsByAccessibleRepositories(await dependencies.loadProjectItems(), [
          sharedRepository,
        ])
      : [],
};
const sharedProjectListService = new ProjectListSyncService(
  slackClient as unknown as ProjectListClient,
  sharedWorkSource,
  store,
  resolveSlackUserId,
);
const notificationThreads = new NotificationThreadService(store);
const rawSlackLifecycleNotifier = workNotificationChannelId
  ? new SlackLifecycleNotifier(slackClient, workNotificationChannelId)
  : null;
const rawSlackWorkNotifier = workNotificationChannelId
  ? new SlackWorkNotifier(slackClient, workNotificationChannelId)
  : null;
const notificationOutbox =
  workNotificationChannelId && rawSlackLifecycleNotifier && rawSlackWorkNotifier
    ? new NotificationOutboxService(
        store,
        new DelegatingNotificationPayloadSender(rawSlackLifecycleNotifier, rawSlackWorkNotifier),
        {
          channelId: workNotificationChannelId,
          replayOperatorIds: notificationReplayOperatorIds,
          reconciler: new SlackNotificationReconciler(
            slackClient as unknown as SlackConversationClient,
            store,
          ),
        },
      )
    : null;
const slackLifecycleNotifier = notificationOutbox
  ? new OutboxLifecycleNotifier(notificationOutbox)
  : null;
const workNotifier = notificationOutbox ? new OutboxWorkNotifier(notificationOutbox) : null;
const workNotificationService = workNotificationChannelId
  ? new WorkNotificationService(
      sharedWorkSource,
      store,
      defined(workNotifier ?? undefined, "通知outbox work notifier"),
      Date.now,
      resolveSlackUserId,
      positiveInteger(process.env.AR_DEADLINE_REMINDER_DAYS ?? "3", "AR_DEADLINE_REMINDER_DAYS"),
      notificationThreads,
      dependencies instanceof GitHubAppDependencies ? dependencies : null,
    )
  : null;
const receiver =
  transport === "http"
    ? new ExpressReceiver({
        signingSecret: required("SLACK_SIGNING_SECRET"),
        endpoints: "/slack/events",
        processBeforeResponse: false,
      })
    : undefined;
const reviewService =
  dependencies instanceof GitHubAppDependencies && slackLifecycleNotifier
    ? new PullRequestReviewService(
        dependencies,
        identityService,
        store,
        new SlackReviewNotifier(
          slackLifecycleNotifier,
          notificationThreads,
          resolveSlackUserId,
          dependencies,
        ),
        {
          slackTeamId,
          ...(sharedRepository ? { allowedRepositories: [sharedRepository] } : {}),
          reminderMilliseconds:
            positiveInteger(
              process.env.AR_REVIEW_REMINDER_MINUTES ?? "1440",
              "AR_REVIEW_REMINDER_MINUTES",
            ) * 60_000,
        },
      )
    : null;
const lifecycleNotificationService =
  dependencies instanceof GitHubAppDependencies && slackLifecycleNotifier
    ? new LifecycleNotificationService(
        dependencies,
        store,
        notificationThreads,
        slackLifecycleNotifier,
        resolveSlackUserId,
        Date.now,
        sharedRepository ? [sharedRepository] : [],
        githubCapabilities,
      )
    : null;
const webhookProcessor =
  reviewService || projectListChannelId || workNotificationService || lifecycleNotificationService
    ? new GitHubWebhookProcessor(
        reviewService,
        store,
        projectListChannelId && sharedRepository
          ? () =>
              sharedProjectListService.sync(projectListChannelId, undefined, {
                teamId: slackTeamId,
                scope: { kind: "repo", repository: sharedRepository },
                target: { kind: "channel", id: projectListChannelId },
                accessibleRepositories: [sharedRepository],
              })
          : undefined,
        workNotificationService,
        lifecycleNotificationService,
      )
    : null;
const jobSecret = strongSecret("AR_JOB_SECRET");
const githubWebhookSecret = strongSecret("GITHUB_WEBHOOK_SECRET");
const jobQueue = createJobQueue(webhookProcessor, jobSecret);
const revokeProjectProjections = async (teamId: string, userId: string) => {
  await canvasProjectionService.revokeViewerAccess(teamId, userId);
  await projectListService.revokeViewerAccess(teamId, userId);
};
const syncProjectProjection = async (
  request: ProjectProjectionRequest | ScheduledCanvasProjectionRequest,
): Promise<ProjectProjectionResult> => {
  let githubViewer: string;
  try {
    githubViewer = await identityService.requireGitHubLogin(
      request.slackTeamId,
      request.slackUserId,
    );
  } catch (error) {
    if (error instanceof MissingGitHubIdentityError) {
      await revokeProjectProjections(request.slackTeamId, request.slackUserId);
    }
    throw error;
  }
  const accessibleRepositories = await issueMetadata.listRepositoriesForViewer(githubViewer);
  const normalizedScope = normalizeRepositoryScope(request.scope);
  if (
    normalizedScope.kind === "repo" &&
    !accessibleRepositories.some(
      (candidate) => candidate.toLowerCase() === normalizedScope.repository?.toLowerCase(),
    )
  ) {
    await revokeProjectProjections(request.slackTeamId, request.slackUserId);
    throw new ProjectProjectionAccessError(
      `GitHub @${githubViewer} は${normalizedScope.repository}を参照できません。`,
    );
  }
  const items = filterItemsByAccessibleRepositories(
    await dependencies.loadProjectItems(),
    accessibleRepositories,
  );
  const target = { kind: "user" as const, id: request.slackUserId };
  if (request.kind === "canvas") {
    const result = await canvasProjectionService.sync({
      teamId: request.slackTeamId,
      viewerId: request.slackUserId,
      target,
      scope: request.scope,
      items,
      accessibleRepositories,
      ...("createIfMissing" in request && request.createIfMissing === false
        ? { createIfMissing: false }
        : {}),
    });
    return {
      kind: "canvas",
      resourceId: result.canvasId,
      itemCount: result.itemCount,
      created: result.created ? 1 : 0,
      updated: result.updated ? 1 : 0,
      deleted: 0,
      unchanged: result.unchanged,
    };
  }
  const result = await projectListService.sync(request.channelId, request.slackUserId, {
    teamId: request.slackTeamId,
    viewerId: request.slackUserId,
    scope: request.scope,
    target,
    accessibleRepositories,
  });
  return {
    kind: "list",
    resourceId: result.listId,
    itemCount: result.itemCount,
    created: result.created,
    updated: result.updated,
    deleted: result.deleted,
  };
};

receiver?.router.get("/health", (_request, response) => {
  response.status(200).json({ ok: true, schemaVersion: 1 });
});

receiver?.router.get("/github/callback", async (request, response) => {
  const code = typeof request.query.code === "string" ? request.query.code : "";
  const state = typeof request.query.state === "string" ? request.query.state : "";
  if (!code || !state) {
    response.status(400).type("text/plain").send("GitHub連携に必要なcodeまたはstateがありません。");
    return;
  }
  try {
    const identity = await identityService.complete(code, state, async (previous) => {
      await canvasProjectionService.revokeViewerAccess(previous.slackTeamId, previous.slackUserId);
      await projectListService.revokeViewerAccess(previous.slackTeamId, previous.slackUserId);
    });
    response
      .status(200)
      .type("text/html")
      .send(
        `<!doctype html><html lang="ja"><meta charset="utf-8"><title>GitHub連携完了</title><body><h1>GitHub連携が完了しました</h1><p>@${identity.githubLogin} とSlackアカウントを対応付けました。この画面を閉じてSlackへ戻ってください。</p></body></html>`,
      );
  } catch (error) {
    response
      .status(400)
      .type("text/plain")
      .send(error instanceof Error ? error.message : "GitHub連携に失敗しました。");
  }
});

receiver?.router.get("/google/callback", async (request, response) => {
  if (!googleCalendarService) {
    response.status(503).type("text/plain").send("Google Calendar連携は設定されていません。");
    return;
  }
  const code = typeof request.query.code === "string" ? request.query.code : "";
  const state = typeof request.query.state === "string" ? request.query.state : "";
  if (!code || !state) {
    response
      .status(400)
      .type("text/plain")
      .send("Google Calendar連携に必要なcodeまたはstateがありません。");
    return;
  }
  try {
    const result = await completeGoogleCalendarCallback(googleCalendarService, code, state);
    if (result.syncWarning) {
      console.warn(`Google Calendar連携後の初回同期を保留しました: ${result.syncWarning}`);
    }
    const message = result.sync
      ? `${escapeHtml(result.identity.googleEmail)} の専用カレンダーへ、自分の期限付きタスクを同期しました。`
      : `${escapeHtml(result.identity.googleEmail)} との連携は完了しました。GitHub連携後にSlackで <code>/ar calendar sync</code> を実行してください。`;
    response
      .status(200)
      .type("text/html")
      .send(
        `<!doctype html><html lang="ja"><meta charset="utf-8"><title>Calendar連携完了</title><body><h1>Google Calendar連携が完了しました</h1><p>${message} この画面を閉じてSlackへ戻ってください。</p></body></html>`,
      );
  } catch (error) {
    response
      .status(400)
      .type("text/plain")
      .send(error instanceof Error ? error.message : "Google Calendar連携に失敗しました。");
  }
});

receiver?.router.post(
  "/github/events",
  raw({ type: "application/json", limit: "2mb" }),
  async (request, response) => {
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.from("");
    const signature = request.header("x-hub-signature-256") ?? "";
    if (!verifyGitHubWebhookSignature(body, signature, githubWebhookSecret)) {
      response.status(401).json({ ok: false, error: "invalid_signature" });
      return;
    }
    let job: GitHubWebhookJob;
    try {
      job = parseGitHubWebhookJob(
        body,
        request.header("x-github-delivery") ?? "",
        request.header("x-github-event") ?? "",
      );
    } catch (error) {
      response.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : "GitHub webhookを受理できませんでした。",
      });
      return;
    }
    try {
      const created = await jobQueue.enqueue(job);
      response.status(202).json({ ok: true, queued: created, schemaVersion: 1 });
    } catch {
      response.status(503).json({ ok: false, error: "queue_unavailable" });
    }
  },
);

receiver?.router.post(
  "/internal/issue-metadata-sync",
  raw({ type: "application/json", limit: "1kb" }),
  async (request, response) => {
    const body = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : "";
    if (!verifyJobSignature(body, request.header("x-ar-job-signature") ?? "", jobSecret)) {
      response.status(401).json({ ok: false, error: "invalid_job_signature" });
      return;
    }
    try {
      const command = JSON.parse(body) as { schemaVersion?: number; kind?: string };
      if (command.schemaVersion !== 1 || command.kind !== "issue-metadata.sync") {
        response.status(400).json({ ok: false, error: "invalid_issue_metadata_command" });
        return;
      }
      const result = await issueMetadata.refresh([repository]);
      response.status(200).json({ ok: true, schemaVersion: 1, ...result });
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Issue metadata同期に失敗しました。");
      response.status(500).json({ ok: false, error: "issue_metadata_sync_failed" });
    }
  },
);

receiver?.router.post(
  "/internal/project-list-sync",
  raw({ type: "application/json", limit: "1kb" }),
  async (request, response) => {
    if (!projectListChannelId || !sharedRepository) {
      response.status(503).json({ ok: false, error: "project_list_channel_required" });
      return;
    }
    const body = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : "";
    if (!verifyJobSignature(body, request.header("x-ar-job-signature") ?? "", jobSecret)) {
      response.status(401).json({ ok: false, error: "invalid_job_signature" });
      return;
    }
    try {
      parseProjectListSyncCommand(body);
      const result = await sharedProjectListService.sync(projectListChannelId, undefined, {
        teamId: slackTeamId,
        scope: { kind: "repo", repository: sharedRepository },
        target: { kind: "channel", id: projectListChannelId },
        accessibleRepositories: [sharedRepository],
      });
      response.status(200).json({ ok: true, schemaVersion: 1, ...result });
    } catch (error) {
      if (isRetryableWorkError(error)) {
        console.warn(error.message);
        response
          .set("Retry-After", "5")
          .status(429)
          .json({ ok: false, error: error.code, retryable: true, schemaVersion: 1 });
        return;
      }
      console.error(error instanceof Error ? error.message : "Project List同期に失敗しました。");
      response.status(500).json({ ok: false, error: "project_list_sync_failed" });
    }
  },
);

receiver?.router.post(
  "/internal/project-canvas-sync",
  raw({ type: "application/json", limit: "1kb" }),
  async (request, response) => {
    const body = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : "";
    if (!verifyJobSignature(body, request.header("x-ar-job-signature") ?? "", jobSecret)) {
      response.status(401).json({ ok: false, error: "invalid_job_signature" });
      return;
    }
    try {
      parseProjectCanvasSyncCommand(body);
    } catch {
      response.status(400).json({ ok: false, error: "invalid_project_canvas_command" });
      return;
    }
    try {
      const result = await syncExistingPersonalCanvases(
        await canvasProjectionService.listExistingStates(),
        slackTeamId,
        syncProjectProjection,
      );
      if (result.totals.error > 0) {
        const retryable = result.results.some((item) => item.status === "error" && item.retryable);
        response
          .set("Retry-After", "5")
          .status(retryable ? 429 : 500)
          .json({
            ok: false,
            error: retryable ? "project_canvas_sync_retryable" : "project_canvas_sync_failed",
            retryable,
            ...result,
          });
        return;
      }
      response.status(200).json({ ok: true, ...result });
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Project Canvas同期に失敗しました。");
      response.status(500).json({ ok: false, error: "project_canvas_sync_failed" });
    }
  },
);

receiver?.router.post(
  "/internal/calendar-sync",
  raw({ type: "application/json", limit: "1kb" }),
  async (request, response) => {
    if (!googleCalendarService) {
      response.status(503).json({ ok: false, error: "google_calendar_required" });
      return;
    }
    const body = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : "";
    if (!verifyJobSignature(body, request.header("x-ar-job-signature") ?? "", jobSecret)) {
      response.status(401).json({ ok: false, error: "invalid_job_signature" });
      return;
    }
    try {
      const command = JSON.parse(body) as { schemaVersion?: number; kind?: string };
      if (command.schemaVersion !== 1 || command.kind !== "calendar.sync") {
        response.status(400).json({ ok: false, error: "invalid_calendar_command" });
        return;
      }
      const results = await googleCalendarService.syncAll(slackTeamId);
      response.status(200).json({ ok: true, schemaVersion: 1, results });
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Calendar同期に失敗しました。");
      response.status(500).json({ ok: false, error: "calendar_sync_failed" });
    }
  },
);

receiver?.router.post(
  "/internal/deadline-reminders",
  raw({ type: "application/json", limit: "1kb" }),
  async (request, response) => {
    if (!workNotificationService) {
      response.status(503).json({ ok: false, error: "work_notification_channel_required" });
      return;
    }
    const body = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : "";
    if (!verifyJobSignature(body, request.header("x-ar-job-signature") ?? "", jobSecret)) {
      response.status(401).json({ ok: false, error: "invalid_job_signature" });
      return;
    }
    try {
      const command = JSON.parse(body) as { schemaVersion?: number; kind?: string };
      if (command.schemaVersion !== 1 || command.kind !== "work.deadline-remind") {
        response.status(400).json({ ok: false, error: "invalid_deadline_command" });
        return;
      }
      const notified = await workNotificationService.notifyDeadlines();
      response.status(200).json({ ok: true, notified, schemaVersion: 1 });
    } catch (error) {
      console.error(error instanceof Error ? error.message : "期限通知処理に失敗しました。");
      response.status(500).json({ ok: false, error: "deadline_reminder_failed" });
    }
  },
);

receiver?.router.post(
  "/internal/work-digest",
  raw({ type: "application/json", limit: "1kb" }),
  async (request, response) => {
    if (!workNotificationService) {
      response.status(503).json({ ok: false, error: "work_notification_channel_required" });
      return;
    }
    const body = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : "";
    if (!verifyJobSignature(body, request.header("x-ar-job-signature") ?? "", jobSecret)) {
      response.status(401).json({ ok: false, error: "invalid_job_signature" });
      return;
    }
    try {
      const command = JSON.parse(body) as { schemaVersion?: number; kind?: string };
      if (command.schemaVersion !== 1 || command.kind !== "work.digest") {
        response.status(400).json({ ok: false, error: "invalid_digest_command" });
        return;
      }
      const itemCount = await workNotificationService.sendDigest();
      response.status(200).json({ ok: true, itemCount, schemaVersion: 1 });
    } catch (error) {
      console.error(error instanceof Error ? error.message : "作業ダイジェストに失敗しました。");
      response.status(500).json({ ok: false, error: "digest_failed" });
    }
  },
);

receiver?.router.post(
  "/internal/review-reminders",
  raw({ type: "application/json", limit: "1kb" }),
  async (request, response) => {
    if (!reviewService) {
      response.status(503).json({ ok: false, error: "github_app_required" });
      return;
    }
    const body = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : "";
    if (!verifyJobSignature(body, request.header("x-ar-job-signature") ?? "", jobSecret)) {
      response.status(401).json({ ok: false, error: "invalid_job_signature" });
      return;
    }
    try {
      const command = JSON.parse(body) as { schemaVersion?: number; kind?: string };
      if (command.schemaVersion !== 1 || command.kind !== "review.remind") {
        response.status(400).json({ ok: false, error: "invalid_reminder_command" });
        return;
      }
      const processed = await reviewService.remindPending();
      response.status(200).json({ ok: true, processed, schemaVersion: 1 });
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Review再通知処理に失敗しました。");
      response.status(500).json({ ok: false, error: "reminder_failed" });
    }
  },
);

receiver?.router.post(
  "/internal/github-events",
  raw({ type: "application/json", limit: "2mb" }),
  async (request, response) => {
    if (!webhookProcessor) {
      response.status(503).json({ ok: false, error: "github_app_required" });
      return;
    }
    const body = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : "";
    if (!verifyJobSignature(body, request.header("x-ar-job-signature") ?? "", jobSecret)) {
      response.status(401).json({ ok: false, error: "invalid_job_signature" });
      return;
    }
    try {
      await webhookProcessor.process(parseQueuedJob(body));
      response.status(200).json({ ok: true, schemaVersion: 1 });
    } catch (error) {
      if (isRetryableWorkError(error)) {
        console.warn(error.message);
        response
          .set("Retry-After", "5")
          .status(429)
          .json({ ok: false, error: error.code, retryable: true, schemaVersion: 1 });
        return;
      }
      console.error(error instanceof Error ? error.message : "GitHub webhook jobに失敗しました。");
      response.status(500).json({ ok: false, error: "job_failed" });
    }
  },
);

const app = createSlackApp(dependencies, {
  token: botToken,
  ...(transport === "socket"
    ? { appToken: required("SLACK_APP_TOKEN"), socketMode: true }
    : { receiver: defined(receiver, "HTTP receiver") }),
  approverUserIds,
  selfApproverUserIds,
  defaultRepository: repository,
  approvalService,
  identityService,
  requirementNotifier,
  issueMetadata,
  resolveSlackUserId,
  revokeProjectProjections,
  ...(googleCalendarService ? { googleCalendarService } : {}),
  syncProjectList: (channelId, requesterUserId) =>
    projectListService.sync(channelId, requesterUserId),
  syncProjectProjection,
  tokenVerificationEnabled: process.env.AR_SLACK_TOKEN_VERIFICATION !== "off",
});

if (projectListChannelId) {
  await sharedProjectListService.migrateLegacyChannelState(projectListChannelId);
}

if (transport === "http") {
  const port = positiveInteger(process.env.PORT ?? "8080", "PORT");
  await app.start(port);
  console.log(
    `⚡ Slack adapter HTTPを起動しました: port=${port} repository=${repository} github=${githubBackend}`,
  );
} else {
  await app.start();
  console.log(`⚡ Slack adapter Socket Modeを起動しました: ${repository}`);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name}が未設定です。apps/slack-adapter/.env.exampleを確認してください。`);
  }
  return value;
}

function csv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function optional(name: string): string | null {
  return process.env[name]?.trim() || null;
}

function projectConfig(): { owner: string; number: number } | null {
  const owner = optional("AR_GITHUB_PROJECT_OWNER");
  const value = optional("AR_GITHUB_PROJECT_NUMBER");
  if (!owner && !value) return null;
  if (!owner || !value || !/^[A-Za-z0-9-]+$/.test(owner)) {
    throw new Error("AR_GITHUB_PROJECT_OWNERとAR_GITHUB_PROJECT_NUMBERを両方設定してください。");
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error("AR_GITHUB_PROJECT_NUMBERには1以上の整数を指定してください。");
  }
  return { owner, number };
}

function googleCalendarConfig(): { clientId: string; clientSecret: string } | null {
  const clientId = optional("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = optional("GOOGLE_OAUTH_CLIENT_SECRET");
  const tokenKey = optional("AR_GOOGLE_TOKEN_KEY");
  if (!clientId && !clientSecret && !tokenKey) return null;
  if (!clientId || !clientSecret || !tokenKey) {
    throw new Error(
      "GOOGLE_OAUTH_CLIENT_ID、GOOGLE_OAUTH_CLIENT_SECRET、AR_GOOGLE_TOKEN_KEYをすべて設定してください。",
    );
  }
  return { clientId, clientSecret };
}

function strongSecret(name: string): string {
  const value = required(name);
  if (value.length < 32) {
    throw new Error(`${name}は32文字以上で設定してください。`);
  }
  return value;
}

function positiveInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 65_535) {
    throw new Error(`${name}には1から65535の整数を指定してください。`);
  }
  return number;
}

function defined<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`${name}を初期化できませんでした。`);
  }
  return value;
}

function createJobQueue(
  processor: GitHubWebhookProcessor | null,
  jobSecret: string,
): GitHubJobQueue {
  const backend = (process.env.AR_JOB_QUEUE ?? "local").trim().toLowerCase();
  if (backend === "local") {
    if (!processor) {
      return new LocalGitHubJobQueue(async () => {
        throw new Error("GitHub App backendが必要です。");
      });
    }
    return new LocalGitHubJobQueue((job) => processor.process(job));
  }
  if (backend === "cloud-tasks") {
    return new CloudTasksGitHubJobQueue({
      projectId: required("AR_GCP_PROJECT_ID"),
      location: required("AR_CLOUD_TASKS_LOCATION"),
      queue: required("AR_CLOUD_TASKS_QUEUE"),
      publicBaseUrl: required("AR_PUBLIC_BASE_URL"),
      jobSecret,
      ...(process.env.AR_CLOUD_TASKS_SERVICE_ACCOUNT?.trim()
        ? { serviceAccountEmail: process.env.AR_CLOUD_TASKS_SERVICE_ACCOUNT.trim() }
        : {}),
    });
  }
  throw new Error("AR_JOB_QUEUEはlocalまたはcloud-tasksを指定してください。");
}

function parseQueuedJob(body: string): GitHubWebhookJob {
  const parsed = JSON.parse(body) as Partial<GitHubWebhookJob>;
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.deliveryId !== "string" ||
    typeof parsed.event !== "string" ||
    parsed.payload === undefined
  ) {
    throw new Error("GitHub webhook jobの形式が不正です。");
  }
  return parsed as GitHubWebhookJob;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
