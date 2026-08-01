import { createSlackApp } from "./app.ts";
import { GitHubCliDependencies } from "./github-cli.ts";

const botToken = required("SLACK_BOT_TOKEN");
const appToken = required("SLACK_APP_TOKEN");
const repository = required("AR_GITHUB_REPO");
const githubLogin = required("AR_GITHUB_LOGIN");
const owners = (process.env.AR_GITHUB_OWNERS ?? repository.split("/")[0] ?? githubLogin)
  .split(",")
  .map((owner) => owner.trim())
  .filter(Boolean);
const approverUserIds = csv("AR_SLACK_APPROVER_IDS");
const selfApproverUserIds = csv("AR_SLACK_SELF_APPROVER_IDS");

const app = createSlackApp(new GitHubCliDependencies(repository, githubLogin, owners), {
  token: botToken,
  appToken,
  socketMode: true,
  approverUserIds,
  selfApproverUserIds,
});

await app.start();
console.log(`⚡ Slack adapterを起動しました: ${repository}`);

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
