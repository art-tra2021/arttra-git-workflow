import { ExpressReceiver } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { raw } from "express";
import { createSlackApp } from "./app.ts";
import { IssueApprovalService } from "./approval.ts";
import type { CanvasClient } from "./canvas.ts";
import { CanvasSyncService } from "./canvas-service.ts";
import { GitHubAppDependencies } from "./github-app.ts";
import { GitHubCliDependencies } from "./github-cli.ts";
import { parseGitHubWebhookJob, verifyGitHubWebhookSignature } from "./github-webhook.ts";
import { GitHubWebhookProcessor } from "./github-webhook-processor.ts";
import { GitHubIdentityService } from "./identity-service.ts";
import {
  CloudTasksGitHubJobQueue,
  type GitHubJobQueue,
  type GitHubWebhookJob,
  LocalGitHubJobQueue,
  verifyJobSignature,
} from "./job-queue.ts";
import { PullRequestReviewService } from "./review-service.ts";
import { SlackReviewNotifier } from "./slack-review-notifier.ts";
import { createStateStoreFromEnvironment } from "./state-store-factory.ts";

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
const approverUserIds = csv("AR_SLACK_APPROVER_IDS");
const selfApproverUserIds = csv("AR_SLACK_SELF_APPROVER_IDS");
const githubBackend = (process.env.AR_GITHUB_BACKEND ?? "cli").trim().toLowerCase();
if (githubBackend !== "cli" && githubBackend !== "app") {
  throw new Error("AR_GITHUB_BACKENDはcliまたはappを指定してください。");
}
const dependencies =
  githubBackend === "app"
    ? new GitHubAppDependencies({
        appId: required("GITHUB_APP_ID"),
        installationId: required("GITHUB_APP_INSTALLATION_ID"),
        privateKey: required("GITHUB_APP_PRIVATE_KEY"),
        repository,
        githubLogin,
        owners,
      })
    : new GitHubCliDependencies(repository, githubLogin, owners);
const store = createStateStoreFromEnvironment();
const slackClient = new WebClient(botToken);
const identityService = new GitHubIdentityService({
  clientId: required("GITHUB_OAUTH_CLIENT_ID"),
  clientSecret: required("GITHUB_OAUTH_CLIENT_SECRET"),
  stateSecret: required("AR_OAUTH_STATE_SECRET"),
  publicBaseUrl: required("AR_PUBLIC_BASE_URL"),
  store,
});
const approvalService = new IssueApprovalService(store, {
  ttlMilliseconds:
    positiveInteger(process.env.AR_APPROVAL_TTL_MINUTES ?? "1440", "AR_APPROVAL_TTL_MINUTES") *
    60_000,
});
const canvasService = new CanvasSyncService(
  slackClient as unknown as CanvasClient,
  dependencies,
  store,
);
const receiver =
  transport === "http"
    ? new ExpressReceiver({
        signingSecret: required("SLACK_SIGNING_SECRET"),
        endpoints: "/slack/events",
        processBeforeResponse: false,
      })
    : undefined;
const reviewService =
  dependencies instanceof GitHubAppDependencies
    ? new PullRequestReviewService(
        dependencies,
        identityService,
        store,
        new SlackReviewNotifier(slackClient, required("AR_SLACK_REVIEW_CHANNEL_ID")),
        {
          slackTeamId: required("AR_SLACK_TEAM_ID"),
          reminderMilliseconds:
            positiveInteger(
              process.env.AR_REVIEW_REMINDER_MINUTES ?? "1440",
              "AR_REVIEW_REMINDER_MINUTES",
            ) * 60_000,
        },
      )
    : null;
const webhookProcessor = reviewService ? new GitHubWebhookProcessor(reviewService, store) : null;
const jobSecret = strongSecret("AR_JOB_SECRET");
const githubWebhookSecret = strongSecret("GITHUB_WEBHOOK_SECRET");
const jobQueue = createJobQueue(webhookProcessor, jobSecret);

receiver?.router.get("/healthz", (_request, response) => {
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
  approvalService,
  identityService,
  syncCanvas: (channelId) => canvasService.sync(channelId),
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
