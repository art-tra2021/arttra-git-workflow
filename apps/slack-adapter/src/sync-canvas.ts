import { resolve } from "node:path";
import { WebClient } from "@slack/web-api";
import type { CanvasClient } from "./canvas.ts";
import { CanvasSyncService } from "./canvas-service.ts";
import { GitHubCliDependencies } from "./github-cli.ts";

const botToken = required("SLACK_BOT_TOKEN");
const repository = required("AR_GITHUB_REPO");
const githubLogin = required("AR_GITHUB_LOGIN");
const channelId = argument("--channel") ?? required("AR_SLACK_CANVAS_CHANNEL_ID");
const owners = csv("AR_GITHUB_OWNERS");
const dependencies = new GitHubCliDependencies(
  repository,
  githubLogin,
  owners.length > 0 ? owners : undefined,
);
const stateDirectory = resolve(process.env.AR_SLACK_CANVAS_STATE_DIR ?? ".state");
const service = new CanvasSyncService(
  new WebClient(botToken) as unknown as CanvasClient,
  dependencies,
  stateDirectory,
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

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() || undefined : undefined;
}
