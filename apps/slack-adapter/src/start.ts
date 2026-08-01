import { ExpressReceiver } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { createSlackApp } from "./app.ts";
import type { CanvasClient } from "./canvas.ts";
import { CanvasSyncService } from "./canvas-service.ts";
import { GitHubAppDependencies } from "./github-app.ts";
import { GitHubCliDependencies } from "./github-cli.ts";
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
const canvasService = new CanvasSyncService(
  new WebClient(botToken) as unknown as CanvasClient,
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

receiver?.router.get("/healthz", (_request, response) => {
  response.status(200).json({ ok: true, schemaVersion: 1 });
});

const app = createSlackApp(dependencies, {
  token: botToken,
  ...(transport === "socket"
    ? { appToken: required("SLACK_APP_TOKEN"), socketMode: true }
    : { receiver: defined(receiver, "HTTP receiver") }),
  approverUserIds,
  selfApproverUserIds,
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
