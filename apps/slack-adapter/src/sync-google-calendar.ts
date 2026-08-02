import { GitHubCliDependencies } from "./github-cli.ts";
import { GoogleCalendarService } from "./google-calendar-service.ts";
import { createStateStoreFromEnvironment } from "./state-store-factory.ts";

const slackUserId = argument("--user") ?? required("AR_SLACK_CALENDAR_USER_ID");
const authorizedSlackUserId = required("AR_SLACK_CLI_USER_ID");
const owners = csv("AR_GITHUB_OWNERS");
const service = new GoogleCalendarService({
  clientId: required("GOOGLE_OAUTH_CLIENT_ID"),
  clientSecret: required("GOOGLE_OAUTH_CLIENT_SECRET"),
  stateSecret: required("AR_OAUTH_STATE_SECRET"),
  tokenEncryptionSecret: required("AR_GOOGLE_TOKEN_KEY"),
  publicBaseUrl: required("AR_PUBLIC_BASE_URL"),
  store: createStateStoreFromEnvironment(),
  source: new GitHubCliDependencies(
    required("AR_GITHUB_REPO"),
    required("AR_GITHUB_LOGIN"),
    owners.length > 0 ? owners : undefined,
    projectConfig(),
    authorizedSlackUserId,
  ),
});
const result = await service.syncUser(required("AR_SLACK_TEAM_ID"), slackUserId);

console.log(JSON.stringify({ schemaVersion: 1, kind: "calendar.sync.result", ...result }));

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
