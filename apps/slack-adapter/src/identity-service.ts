import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { StateStore } from "./state-store.ts";
import type { CreateIssueCommand } from "./types.ts";

const NONCE_NAMESPACE = "github-oauth-nonce";
const IDENTITY_NAMESPACE = "github-identity";
const REVERSE_IDENTITY_NAMESPACE = "github-identity-reverse";
const AUDIT_NAMESPACE = "github-identity-audit";

export type IdentityFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubIdentity {
  schemaVersion: 1;
  revision: number;
  slackTeamId: string;
  slackUserId: string;
  githubUserId: number;
  githubLogin: string;
  verifiedAt: string;
}

export class MissingGitHubIdentityError extends Error {
  readonly slackUserIds: string[];

  constructor(slackUserIds: string[]) {
    const mentions = slackUserIds.map((slackUserId) => `<@${slackUserId}>`).join(" ");
    super(
      `${mentions} はGitHub未連携です。本人がSlackで \`/ar connect github\` を実行してください。`,
    );
    this.name = "MissingGitHubIdentityError";
    this.slackUserIds = [...slackUserIds];
  }
}

interface OAuthState {
  schemaVersion: 1;
  slackTeamId: string;
  slackUserId: string;
  nonce: string;
  expiresAt: number;
}

interface OAuthNonce {
  revision: number;
  status: "pending" | "consumed";
  expiresAt: number;
}

interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  stateSecret: string;
  publicBaseUrl: string;
  store: StateStore;
  fetch?: IdentityFetch;
  now?: () => number;
  nonce?: () => string;
  githubBaseUrl?: string;
  githubApiBaseUrl?: string;
}

export class GitHubIdentityService {
  private readonly config: GitHubOAuthConfig;
  private readonly fetchImpl: IdentityFetch;
  private readonly now: () => number;
  private readonly nonce: () => string;
  private readonly githubBaseUrl: string;
  private readonly githubApiBaseUrl: string;

  constructor(config: GitHubOAuthConfig) {
    this.config = config;
    this.fetchImpl = config.fetch ?? fetch;
    this.now = config.now ?? Date.now;
    this.nonce = config.nonce ?? randomUUID;
    this.githubBaseUrl = (config.githubBaseUrl ?? "https://github.com").replace(/\/$/, "");
    this.githubApiBaseUrl = (config.githubApiBaseUrl ?? "https://api.github.com").replace(
      /\/$/,
      "",
    );
    assertPublicBaseUrl(config.publicBaseUrl);
    if (config.stateSecret.length < 32) {
      throw new Error("AR_OAUTH_STATE_SECRETは32文字以上で設定してください。");
    }
  }

  async connectUrl(slackTeamId: string, slackUserId: string): Promise<string> {
    const nonce = this.nonce();
    const expiresAt = this.now() + 10 * 60 * 1000;
    const created = await this.config.store.create<OAuthNonce>(NONCE_NAMESPACE, nonce, {
      revision: 1,
      status: "pending",
      expiresAt,
    });
    if (!created) {
      throw new Error("GitHub連携用IDが重複しました。もう一度実行してください。");
    }
    const state = this.signState({
      schemaVersion: 1,
      slackTeamId,
      slackUserId,
      nonce,
      expiresAt,
    });
    const query = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: `${this.config.publicBaseUrl.replace(/\/$/, "")}/github/callback`,
      state,
      allow_signup: "false",
    });
    return `${this.githubBaseUrl}/login/oauth/authorize?${query.toString()}`;
  }

  async complete(code: string, signedState: string): Promise<GitHubIdentity> {
    const state = this.verifyState(signedState);
    if (state.expiresAt <= this.now()) {
      throw new Error("GitHub連携の有効期限が切れました。Slackからもう一度実行してください。");
    }
    const nonce = await this.config.store.get<OAuthNonce>(NONCE_NAMESPACE, state.nonce);
    if (nonce === null) {
      throw new Error("GitHub連携URLは使用済みか無効です。Slackからもう一度実行してください。");
    }
    if (nonce.status !== "pending" || nonce.expiresAt !== state.expiresAt) {
      throw new Error("GitHub連携URLは使用済みか無効です。Slackからもう一度実行してください。");
    }
    const consumed: OAuthNonce = { ...nonce, revision: nonce.revision + 1, status: "consumed" };
    if (
      !(await this.config.store.compareAndSet(
        NONCE_NAMESPACE,
        state.nonce,
        nonce.revision,
        consumed,
      ))
    ) {
      throw new Error("GitHub連携URLはすでに使用されています。");
    }
    const token = await this.exchangeCode(code);
    const user = await this.githubUser(token);
    const previous = await this.get(state.slackTeamId, state.slackUserId);
    const reverse = await this.findByGitHubUserId(state.slackTeamId, user.id);
    if (reverse && reverse.slackUserId !== state.slackUserId) {
      throw new Error(
        `GitHub @${user.login} は別のSlackアカウントへ連携済みです。以前のSlackアカウントで \`/ar disconnect github\` を実行してください。`,
      );
    }
    const identity: GitHubIdentity = {
      schemaVersion: 1,
      revision: (previous?.revision ?? 0) + 1,
      slackTeamId: state.slackTeamId,
      slackUserId: state.slackUserId,
      githubUserId: user.id,
      githubLogin: user.login,
      verifiedAt: new Date(this.now()).toISOString(),
    };
    await this.config.store.set(
      IDENTITY_NAMESPACE,
      slackKey(state.slackTeamId, state.slackUserId),
      identity,
    );
    await this.config.store.set(
      REVERSE_IDENTITY_NAMESPACE,
      githubKey(state.slackTeamId, user.id),
      identity,
    );
    if (previous && previous.githubUserId !== user.id) {
      await this.config.store.remove(
        REVERSE_IDENTITY_NAMESPACE,
        githubKey(state.slackTeamId, previous.githubUserId),
      );
    }
    await this.audit(identity, previous ? "relinked" : "linked");
    return identity;
  }

  async disconnect(slackTeamId: string, slackUserId: string): Promise<boolean> {
    const identity = await this.get(slackTeamId, slackUserId);
    if (!identity) {
      return false;
    }
    await this.config.store.remove(IDENTITY_NAMESPACE, slackKey(slackTeamId, slackUserId));
    await this.config.store.remove(
      REVERSE_IDENTITY_NAMESPACE,
      githubKey(identity.slackTeamId, identity.githubUserId),
    );
    await this.audit(identity, "unlinked");
    return true;
  }

  async get(slackTeamId: string, slackUserId: string): Promise<GitHubIdentity | null> {
    return this.config.store.get<GitHubIdentity>(
      IDENTITY_NAMESPACE,
      slackKey(slackTeamId, slackUserId),
    );
  }

  async findByGitHubUserId(
    slackTeamId: string,
    githubUserId: number,
  ): Promise<GitHubIdentity | null> {
    return this.config.store.get<GitHubIdentity>(
      REVERSE_IDENTITY_NAMESPACE,
      githubKey(slackTeamId, githubUserId),
    );
  }

  async resolveCommand(
    command: CreateIssueCommand,
    slackTeamId: string,
  ): Promise<CreateIssueCommand> {
    const assignees = await this.resolveMany(slackTeamId, command.assigneeSlackUserIds ?? []);
    const reviewers = await this.resolveMany(slackTeamId, command.reviewerSlackUserIds ?? []);
    return {
      ...command,
      assigneeGitHubLogins: assignees.map((identity) => identity.githubLogin),
      reviewerGitHubLogins: reviewers.map((identity) => identity.githubLogin),
      reviewerGitHubUsers: reviewers.map((identity) => ({
        id: identity.githubUserId,
        login: identity.githubLogin,
      })),
    };
  }

  private async resolveMany(
    slackTeamId: string,
    slackUserIds: string[],
  ): Promise<GitHubIdentity[]> {
    const identities = await Promise.all(
      slackUserIds.map((slackUserId) => this.get(slackTeamId, slackUserId)),
    );
    const missing = slackUserIds.filter((_, index) => identities[index] === null);
    if (missing.length > 0) {
      throw new MissingGitHubIdentityError(missing);
    }
    return identities.filter((identity): identity is GitHubIdentity => identity !== null);
  }

  private signState(state: OAuthState): string {
    const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
    return `${payload}.${this.signature(payload)}`;
  }

  private verifyState(value: string): OAuthState {
    const [payload, signature] = value.split(".");
    if (!payload || !signature) {
      throw new Error("GitHub連携stateが不正です。");
    }
    const expected = Buffer.from(this.signature(payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new Error("GitHub連携stateの署名が一致しません。");
    }
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
    if (
      state.schemaVersion !== 1 ||
      !state.slackTeamId ||
      !state.slackUserId ||
      !state.nonce ||
      !Number.isSafeInteger(state.expiresAt)
    ) {
      throw new Error("GitHub連携stateを読み取れませんでした。");
    }
    return state;
  }

  private signature(payload: string): string {
    return createHmac("sha256", this.config.stateSecret).update(payload).digest("base64url");
  }

  private async exchangeCode(code: string): Promise<string> {
    const response = await this.fetchImpl(`${this.githubBaseUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: `${this.config.publicBaseUrl.replace(/\/$/, "")}/github/callback`,
      }),
    });
    const result = (await response.json()) as { access_token?: string; error_description?: string };
    if (!response.ok || !result.access_token) {
      throw new Error(
        `GitHub OAuth認証に失敗しました${result.error_description ? `: ${result.error_description}` : "。"}`,
      );
    }
    return result.access_token;
  }

  private async githubUser(token: string): Promise<{ id: number; login: string }> {
    const response = await this.fetchImpl(`${this.githubApiBaseUrl}/user`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "arttra-slack-adapter",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    const user = (await response.json()) as { id?: number; login?: string };
    if (
      !response.ok ||
      !Number.isSafeInteger(user.id) ||
      !user.login ||
      !/^[A-Za-z0-9-]{1,39}$/.test(user.login)
    ) {
      throw new Error("GitHub user IDとloginを検証できませんでした。");
    }
    return { id: user.id as number, login: user.login };
  }

  private async audit(identity: GitHubIdentity, action: "linked" | "relinked" | "unlinked") {
    await this.config.store.append(AUDIT_NAMESPACE, {
      schemaVersion: 1,
      action,
      at: new Date(this.now()).toISOString(),
      slackTeamId: identity.slackTeamId,
      slackUserId: identity.slackUserId,
      githubUserId: identity.githubUserId,
      githubLogin: identity.githubLogin,
    });
  }
}

function slackKey(teamId: string, userId: string): string {
  return `${teamId}:${userId}`;
}

function githubKey(teamId: string, userId: number): string {
  return `${teamId}:${userId}`;
}

function assertPublicBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("AR_PUBLIC_BASE_URLがURLではありません。");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
    throw new Error("AR_PUBLIC_BASE_URLはHTTPS URLを指定してください。");
  }
}
