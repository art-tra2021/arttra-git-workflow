import { WebClient } from "@slack/web-api";
import type { CanvasClient } from "./canvas.ts";
import { CanvasSyncService } from "./canvas-service.ts";
import { GitHubCliDependencies } from "./github-cli.ts";
import { createStateStoreFromEnvironment } from "./state-store-factory.ts";

const botToken = required("SLACK_BOT_TOKEN");
const repository = required("AR_GITHUB_REPO");
const githubLogin = required("AR_GITHUB_LOGIN");
const channelId = argument("--channel") ?? required("AR_SLACK_CANVAS_CHANNEL_ID");
const owners = csv("AR_GITHUB_OWNERS");
const project = projectConfig();
const dependencies = new GitHubCliDependencies(
  repository,
  githubLogin,
  owners.length > 0 ? owners : undefined,
  project,
);
const service = new CanvasSyncService(
  new WebClient(botToken) as unknown as CanvasClient,
  dependencies,
  createStateStoreFromEnvironment(),
  optional("AR_SLACK_CANVAS_ID"),
);
const result = await service.sync(channelId);

console.log(
  `Slack Canvasを同期しました: channel=${channelId} canvas=${result.canvasId} items=${result.itemCount}`,
);

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

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() || undefined : undefined;
}
