import { ExpressReceiver } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { raw } from "express";
import { createSlackApp } from "./app.ts";
import { IssueApprovalService } from "./approval.ts";
import { GitHubAppDependencies } from "./github-app.ts";
import { GitHubCliDependencies } from "./github-cli.ts";
import { parseGitHubWebhookJob, verifyGitHubWebhookSignature } from "./github-webhook.ts";
import { GitHubWebhookProcessor } from "./github-webhook-processor.ts";
import { completeGoogleCalendarCallback } from "./google-calendar-callback.ts";
import { GoogleCalendarService } from "./google-calendar-service.ts";
import { type GitHubIdentity, GitHubIdentityService } from "./identity-service.ts";
import { IssueMetadataCache } from "./issue-metadata-cache.ts";
import {
  CloudTasksGitHubJobQueue,
  type GitHubJobQueue,
  type GitHubWebhookJob,
  LocalGitHubJobQueue,
  verifyJobSignature,
} from "./job-queue.ts";
import { LifecycleNotificationService } from "./lifecycle-notification-service.ts";
import { NotificationThreadService } from "./notification-thread-service.ts";
import type { ProjectListClient } from "./project-list.ts";
import { ProjectListSyncService, parseProjectListSyncCommand } from "./project-list-service.ts";
import { PullRequestReviewService } from "./review-service.ts";
import { SlackLifecycleNotifier } from "./slack-lifecycle-notifier.ts";
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
    : new GitHubCliDependencies(repository, githubLogin, owners, project);
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
const projectListChannelId = optional("AR_SLACK_PROJECT_LIST_CHANNEL_ID");
const workNotificationChannelId = optional("AR_SLACK_WORK_CHANNEL_ID") ?? projectListChannelId;
const notificationThreads = new NotificationThreadService(store);
const slackLifecycleNotifier = workNotificationChannelId
  ? new SlackLifecycleNotifier(slackClient, workNotificationChannelId)
  : null;
const workNotificationService = workNotificationChannelId
  ? new WorkNotificationService(
      dependencies,
      store,
      new SlackWorkNotifier(slackClient, workNotificationChannelId),
      Date.now,
      resolveSlackUserId,
      positiveInteger(process.env.AR_DEADLINE_REMINDER_DAYS ?? "3", "AR_DEADLINE_REMINDER_DAYS"),
      notificationThreads,
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
        new SlackReviewNotifier(slackLifecycleNotifier, notificationThreads, resolveSlackUserId),
        {
          slackTeamId,
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
      )
    : null;
const webhookProcessor =
  reviewService || projectListChannelId || workNotificationService || lifecycleNotificationService
    ? new GitHubWebhookProcessor(
        reviewService,
        store,
        projectListChannelId ? () => projectListService.sync(projectListChannelId) : undefined,
        workNotificationService,
        lifecycleNotificationService,
      )
    : null;
const jobSecret = strongSecret("AR_JOB_SECRET");
const githubWebhookSecret = strongSecret("GITHUB_WEBHOOK_SECRET");
const jobQueue = createJobQueue(webhookProcessor, jobSecret);

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
    const identity = await identityService.complete(code, state);
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
    if (!projectListChannelId) {
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
      const result = await projectListService.sync(projectListChannelId);
      response.status(200).json({ ok: true, schemaVersion: 1, ...result });
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Project List同期に失敗しました。");
      response.status(500).json({ ok: false, error: "project_list_sync_failed" });
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
  issueMetadata,
  ...(googleCalendarService ? { googleCalendarService } : {}),
  syncProjectList: (channelId, requesterUserId) =>
    projectListService.sync(channelId, requesterUserId),
  tokenVerificationEnabled: process.env.AR_SLACK_TOKEN_VERIFICATION !== "off",
});

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
