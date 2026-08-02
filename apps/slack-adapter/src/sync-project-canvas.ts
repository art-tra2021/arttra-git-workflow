import { WebClient } from "@slack/web-api";
import { type CanvasClient, CanvasProjectionService } from "./canvas-service.ts";
import { GitHubCliDependencies } from "./github-cli.ts";
import { requireStoredGitHubLogin } from "./identity-service.ts";
import {
  allAccessibleScope,
  assertSharedProjectionBinding,
  filterItemsByAccessibleRepositories,
  projectionTarget,
  repositoryScope,
} from "./project-scope.ts";
import { createStateStoreFromEnvironment } from "./state-store-factory.ts";

const botToken = required("SLACK_BOT_TOKEN");
const defaultRepository = required("AR_GITHUB_REPO");
const githubLogin = required("AR_GITHUB_LOGIN");
const slackTeamId = required("AR_SLACK_TEAM_ID");
const repository = argument("--repo");
const scope = repository ? repositoryScope(repository) : allAccessibleScope();
const userId = argument("--user");
const channelId = argument("--channel");
const sharedRepository = optional("AR_SLACK_SHARED_REPOSITORY");
if (!userId && !channelId) {
  throw new Error("--userまたは--channelを指定してください。");
}
if (userId && channelId) {
  throw new Error("--userと--channelは同時に指定できません。");
}
if (scope.kind === "all-accessible" && !userId) {
  throw new Error("all-accessible Canvasは共有channelへ公開できません。--userを指定してください。");
}
if (channelId && !sharedRepository) {
  throw new Error(
    "共有Slack channelへCanvasを投影する場合はAR_SLACK_SHARED_REPOSITORYを設定してください。",
  );
}
if (channelId && (!repository || repository.toLowerCase() !== sharedRepository?.toLowerCase())) {
  throw new Error(
    `共有Slack channelへ投影できるrepositoryは${sharedRepository ?? "未設定"}だけです。--repoで明示してください。`,
  );
}
if (channelId && repository && sharedRepository) {
  assertSharedProjectionBinding({
    channelId,
    configuredChannelId: required("AR_SLACK_CANVAS_CHANNEL_ID"),
    repository,
    configuredRepository: sharedRepository,
  });
}

const store = createStateStoreFromEnvironment();
const viewerGitHubLogin = userId
  ? await requireStoredGitHubLogin(store, slackTeamId, userId)
  : githubLogin;

const owners = csv("AR_GITHUB_OWNERS");
const dependencies = new GitHubCliDependencies(
  defaultRepository,
  githubLogin,
  owners.length > 0 ? owners : undefined,
  projectConfig(),
);
const accessibleRepositories = await dependencies.listRepositoriesForViewer(viewerGitHubLogin);
if (
  repository &&
  !accessibleRepositories.some((candidate) => candidate.toLowerCase() === repository.toLowerCase())
) {
  throw new Error(`GitHub @${viewerGitHubLogin} は${repository}を参照できません。`);
}
const items = filterItemsByAccessibleRepositories(
  await dependencies.loadProjectItems(),
  accessibleRepositories,
);
const target = userId
  ? projectionTarget("user", userId)
  : projectionTarget("channel", channelId ?? "");
const result = await new CanvasProjectionService(
  new WebClient(botToken) as unknown as CanvasClient,
  store,
).sync({
  teamId: slackTeamId,
  viewerId: userId ?? null,
  target,
  scope,
  items,
  accessibleRepositories,
});

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      kind: "project-canvas.sync.result",
      scope,
      target,
      accessibleRepositoryCount: accessibleRepositories.length,
      ...result,
    }),
  );
} else {
  console.log(
    `Slack Canvasを同期しました: canvas=${result.canvasId} items=${result.itemCount} created=${result.created} updated=${result.updated} unchanged=${result.unchanged}`,
  );
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name}が未設定です。apps/slack-adapter/.env.exampleを確認してください。`);
  }
  return value;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() || undefined : undefined;
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
