import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { GitHubIdentity } from "./identity-service.ts";
import type { StateStore } from "./state-store.ts";
import type { HumanWorkItem } from "./types.ts";

const NONCE_NAMESPACE = "google-calendar-oauth-nonce";
const IDENTITY_NAMESPACE = "google-calendar-identity";
const REVERSE_IDENTITY_NAMESPACE = "google-calendar-identity-reverse";
const AUDIT_NAMESPACE = "google-calendar-audit";
const GITHUB_IDENTITY_NAMESPACE = "github-identity";
const MANAGED_BY = "arttra-work";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";

export type GoogleCalendarFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface GoogleCalendarIdentity {
  schemaVersion: 1;
  revision: number;
  slackTeamId: string;
  slackUserId: string;
  googleSubject: string;
  googleEmail: string;
  encryptedRefreshToken: string;
  calendarId: string | null;
  verifiedAt: string;
}

export interface CalendarSyncResult {
  slackUserId: string;
  calendarId: string;
  itemCount: number;
  created: number;
  updated: number;
  deleted: number;
}

export interface PersonalWorkSource {
  loadWorkItems(slackUserId: string): Promise<HumanWorkItem[]>;
}

interface GoogleCalendarConfig {
  clientId: string;
  clientSecret: string;
  stateSecret: string;
  tokenEncryptionSecret: string;
  publicBaseUrl: string;
  store: StateStore;
  source: PersonalWorkSource;
  fetch?: GoogleCalendarFetch;
  now?: () => number;
  nonce?: () => string;
  oauthBaseUrl?: string;
  calendarApiBaseUrl?: string;
  userInfoUrl?: string;
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

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error_description?: string;
}

interface GoogleEvent {
  id?: string;
  extendedProperties?: { private?: { managedBy?: string; githubUrl?: string } };
}

export class GoogleCalendarService {
  private readonly config: GoogleCalendarConfig;
  private readonly fetchImpl: GoogleCalendarFetch;
  private readonly now: () => number;
  private readonly nonce: () => string;
  private readonly oauthBaseUrl: string;
  private readonly calendarApiBaseUrl: string;
  private readonly userInfoUrl: string;
  private readonly encryptionKey: Buffer;

  constructor(config: GoogleCalendarConfig) {
    this.config = config;
    this.fetchImpl = config.fetch ?? fetch;
    this.now = config.now ?? Date.now;
    this.nonce = config.nonce ?? randomUUID;
    this.oauthBaseUrl = (config.oauthBaseUrl ?? "https://oauth2.googleapis.com").replace(/\/$/, "");
    this.calendarApiBaseUrl = (
      config.calendarApiBaseUrl ?? "https://www.googleapis.com/calendar/v3"
    ).replace(/\/$/, "");
    this.userInfoUrl = config.userInfoUrl ?? "https://openidconnect.googleapis.com/v1/userinfo";
    this.encryptionKey = createHash("sha256").update(config.tokenEncryptionSecret).digest();
    assertPublicBaseUrl(config.publicBaseUrl);
    if (config.stateSecret.length < 32) {
      throw new Error("AR_OAUTH_STATE_SECRETは32文字以上で設定してください。");
    }
    if (config.tokenEncryptionSecret.length < 32) {
      throw new Error("AR_GOOGLE_TOKEN_KEYは32文字以上で設定してください。");
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
      throw new Error("Google Calendar連携用IDが重複しました。もう一度実行してください。");
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
      redirect_uri: `${this.config.publicBaseUrl.replace(/\/$/, "")}/google/callback`,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      scope: `openid email ${CALENDAR_SCOPE}`,
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${query.toString()}`;
  }

  async complete(code: string, signedState: string): Promise<GoogleCalendarIdentity> {
    const state = this.verifyState(signedState);
    if (state.expiresAt <= this.now()) {
      throw new Error(
        "Google Calendar連携の有効期限が切れました。Slackからもう一度実行してください。",
      );
    }
    const nonce = await this.config.store.get<OAuthNonce>(NONCE_NAMESPACE, state.nonce);
    if (nonce?.status !== "pending" || nonce.expiresAt !== state.expiresAt) {
      throw new Error(
        "Google Calendar連携URLは使用済みか無効です。Slackからもう一度実行してください。",
      );
    }
    if (
      !(await this.config.store.compareAndSet(NONCE_NAMESPACE, state.nonce, nonce.revision, {
        ...nonce,
        revision: nonce.revision + 1,
        status: "consumed",
      }))
    ) {
      throw new Error("Google Calendar連携URLはすでに使用されています。");
    }

    const token = await this.exchangeCode(code);
    if (!token.refresh_token || !token.access_token) {
      throw new Error(
        "Googleから更新用tokenを取得できませんでした。連携を解除して、もう一度許可してください。",
      );
    }
    const user = await this.googleUser(token.access_token);
    const key = slackKey(state.slackTeamId, state.slackUserId);
    const previous = await this.get(state.slackTeamId, state.slackUserId);
    const reverse = await this.config.store.get<GoogleCalendarIdentity>(
      REVERSE_IDENTITY_NAMESPACE,
      googleKey(state.slackTeamId, user.sub),
    );
    if (reverse && reverse.slackUserId !== state.slackUserId) {
      throw new Error(
        `${user.email} は別のSlackアカウントへ連携済みです。以前のSlackアカウントで \`/ar disconnect google\` を実行してください。`,
      );
    }
    const identity: GoogleCalendarIdentity = {
      schemaVersion: 1,
      revision: (previous?.revision ?? 0) + 1,
      slackTeamId: state.slackTeamId,
      slackUserId: state.slackUserId,
      googleSubject: user.sub,
      googleEmail: user.email,
      encryptedRefreshToken: this.encrypt(token.refresh_token),
      calendarId: previous?.googleSubject === user.sub ? previous.calendarId : null,
      verifiedAt: new Date(this.now()).toISOString(),
    };
    await this.config.store.set(IDENTITY_NAMESPACE, key, identity);
    await this.config.store.set(
      REVERSE_IDENTITY_NAMESPACE,
      googleKey(state.slackTeamId, user.sub),
      identity,
    );
    if (previous && previous.googleSubject !== user.sub) {
      await this.config.store.remove(
        REVERSE_IDENTITY_NAMESPACE,
        googleKey(state.slackTeamId, previous.googleSubject),
      );
    }
    await this.audit(identity, previous ? "relinked" : "linked");
    return identity;
  }

  async disconnect(slackTeamId: string, slackUserId: string): Promise<boolean> {
    const identity = await this.get(slackTeamId, slackUserId);
    if (!identity) return false;
    await this.config.store.remove(IDENTITY_NAMESPACE, slackKey(slackTeamId, slackUserId));
    await this.config.store.remove(
      REVERSE_IDENTITY_NAMESPACE,
      googleKey(slackTeamId, identity.googleSubject),
    );
    await this.audit(identity, "unlinked");
    return true;
  }

  async get(slackTeamId: string, slackUserId: string): Promise<GoogleCalendarIdentity | null> {
    return this.config.store.get<GoogleCalendarIdentity>(
      IDENTITY_NAMESPACE,
      slackKey(slackTeamId, slackUserId),
    );
  }

  async syncUser(slackTeamId: string, slackUserId: string): Promise<CalendarSyncResult> {
    let identity = await this.get(slackTeamId, slackUserId);
    if (!identity) {
      throw new Error(
        "Google Calendarが未連携です。Slackで `/ar connect google` を実行してください。",
      );
    }
    const githubIdentity = await this.config.store.get<GitHubIdentity>(
      GITHUB_IDENTITY_NAMESPACE,
      slackKey(slackTeamId, slackUserId),
    );
    if (!githubIdentity) {
      throw new Error("GitHubが未連携です。先にSlackで `/ar connect github` を実行してください。");
    }
    const accessToken = await this.refreshAccessToken(identity);
    if (!identity.calendarId) {
      const calendarId = await this.createCalendar(accessToken);
      identity = { ...identity, revision: identity.revision + 1, calendarId };
      await this.config.store.set(IDENTITY_NAMESPACE, slackKey(slackTeamId, slackUserId), identity);
      await this.config.store.set(
        REVERSE_IDENTITY_NAMESPACE,
        googleKey(slackTeamId, identity.googleSubject),
        identity,
      );
    }
    const calendarId = identity.calendarId;
    if (!calendarId) throw new Error("Google Calendar IDを保存できませんでした。");

    const items = (await this.config.source.loadWorkItems(slackUserId)).filter(
      (item) =>
        item.delivery !== "silent" &&
        item.status !== "done" &&
        item.targetDate !== null &&
        item.owner?.toLowerCase() === githubIdentity.githubLogin.toLowerCase(),
    );
    const existing = await this.listManagedEvents(accessToken, calendarId);
    const existingById = new Map(
      existing.flatMap((event) => (event.id ? [[event.id, event]] : [])),
    );
    const desired = new Map(items.map((item) => [eventId(item.url), item]));
    let created = 0;
    let updated = 0;
    let deleted = 0;

    for (const [id, item] of desired) {
      const body = calendarEvent(id, item);
      if (existingById.has(id)) {
        await this.calendarRequest(
          accessToken,
          `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`,
          { method: "PUT", body: JSON.stringify(body) },
        );
        updated += 1;
      } else {
        await this.calendarRequest(
          accessToken,
          `/calendars/${encodeURIComponent(calendarId)}/events`,
          { method: "POST", body: JSON.stringify(body) },
        );
        created += 1;
      }
    }
    for (const event of existing) {
      if (!event.id || desired.has(event.id)) continue;
      await this.calendarRequest(
        accessToken,
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(event.id)}`,
        { method: "DELETE" },
      );
      deleted += 1;
    }

    return {
      slackUserId,
      calendarId,
      itemCount: items.length,
      created,
      updated,
      deleted,
    };
  }

  async syncAll(slackTeamId: string): Promise<CalendarSyncResult[]> {
    const identities = (
      await this.config.store.list<GoogleCalendarIdentity>(IDENTITY_NAMESPACE)
    ).filter((identity) => identity.slackTeamId === slackTeamId);
    return Promise.all(
      identities.map((identity) => this.syncUser(slackTeamId, identity.slackUserId)),
    );
  }

  private signState(state: OAuthState): string {
    const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
    return `${payload}.${this.signature(payload)}`;
  }

  private verifyState(value: string): OAuthState {
    const [payload, signature] = value.split(".");
    if (!payload || !signature) throw new Error("Google Calendar連携stateが不正です。");
    const expected = Buffer.from(this.signature(payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new Error("Google Calendar連携stateの署名が一致しません。");
    }
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
    if (
      state.schemaVersion !== 1 ||
      !state.slackTeamId ||
      !state.slackUserId ||
      !state.nonce ||
      !Number.isSafeInteger(state.expiresAt)
    ) {
      throw new Error("Google Calendar連携stateを読み取れませんでした。");
    }
    return state;
  }

  private signature(payload: string): string {
    return createHmac("sha256", this.config.stateSecret).update(payload).digest("base64url");
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext]
      .map((part) => part.toString("base64url"))
      .join(".");
  }

  private decrypt(value: string): string {
    const [ivValue, tagValue, ciphertextValue] = value.split(".");
    if (!ivValue || !tagValue || !ciphertextValue) {
      throw new Error("Google Calendar tokenを復号できませんでした。");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.encryptionKey,
      Buffer.from(ivValue, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }

  private async exchangeCode(code: string): Promise<GoogleTokenResponse> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: `${this.config.publicBaseUrl.replace(/\/$/, "")}/google/callback`,
    });
    const response = await this.fetchImpl(`${this.oauthBaseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const token = (await response.json()) as GoogleTokenResponse;
    if (!response.ok) {
      throw new Error(
        `Google OAuth認証に失敗しました${token.error_description ? `: ${token.error_description}` : "。"}`,
      );
    }
    return token;
  }

  private async refreshAccessToken(identity: GoogleCalendarIdentity): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.decrypt(identity.encryptedRefreshToken),
      grant_type: "refresh_token",
    });
    const response = await this.fetchImpl(`${this.oauthBaseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const token = (await response.json()) as GoogleTokenResponse;
    if (!response.ok || !token.access_token) {
      throw new Error(
        "Google Calendar認証を更新できませんでした。Slackで `/ar connect google` を再実行してください。",
      );
    }
    return token.access_token;
  }

  private async googleUser(accessToken: string): Promise<{ sub: string; email: string }> {
    const response = await this.fetchImpl(this.userInfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const user = (await response.json()) as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
    };
    if (!response.ok || !user.sub || !user.email || user.email_verified !== true) {
      throw new Error("Googleアカウントの本人確認に失敗しました。");
    }
    return { sub: user.sub, email: user.email };
  }

  private async createCalendar(accessToken: string): Promise<string> {
    const response = await this.calendarRequest(accessToken, "/calendars", {
      method: "POST",
      body: JSON.stringify({
        summary: "ART-TRA Work",
        description: "GitHub Projectsで自分が担当する未完了タスクの自動投影",
        timeZone: "Asia/Tokyo",
      }),
    });
    const calendar = (await response.json()) as { id?: string };
    if (!calendar.id) throw new Error("Google Calendarの作成結果にIDがありません。");
    return calendar.id;
  }

  private async listManagedEvents(accessToken: string, calendarId: string): Promise<GoogleEvent[]> {
    const events: GoogleEvent[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({
        maxResults: "2500",
        showDeleted: "false",
        privateExtendedProperty: `managedBy=${MANAGED_BY}`,
        ...(pageToken ? { pageToken } : {}),
      });
      const response = await this.calendarRequest(
        accessToken,
        `/calendars/${encodeURIComponent(calendarId)}/events?${query.toString()}`,
      );
      const page = (await response.json()) as { items?: GoogleEvent[]; nextPageToken?: string };
      events.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return events;
  }

  private async calendarRequest(
    accessToken: string,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const response = await this.fetchImpl(`${this.calendarApiBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(
        `Google Calendar APIが${response.status}を返しました${detail ? `: ${detail}` : "。"}`,
      );
    }
    return response;
  }

  private async audit(
    identity: GoogleCalendarIdentity,
    action: "linked" | "relinked" | "unlinked",
  ) {
    await this.config.store.append(AUDIT_NAMESPACE, {
      schemaVersion: 1,
      action,
      at: new Date(this.now()).toISOString(),
      slackTeamId: identity.slackTeamId,
      slackUserId: identity.slackUserId,
      googleSubject: identity.googleSubject,
      googleEmail: identity.googleEmail,
    });
  }
}

function calendarEvent(id: string, item: HumanWorkItem): Record<string, unknown> {
  const targetDate = defined(item.targetDate);
  return {
    id,
    summary: `${item.priority === "P2" ? "" : `[${item.priority}] `}${item.title}`,
    description: [
      `状態: ${statusLabel(item.status)}`,
      `次の行動: ${item.nextAction}`,
      item.url,
    ].join("\n"),
    start: { date: targetDate },
    end: { date: addDays(targetDate, 1) },
    transparency: "transparent",
    extendedProperties: { private: { managedBy: MANAGED_BY, githubUrl: item.url } },
  };
}

function eventId(url: string): string {
  return `arttra${createHash("sha256").update(url).digest("hex").slice(0, 40)}`;
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`期限日の形式が不正です: ${date}`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function statusLabel(status: HumanWorkItem["status"]): string {
  return {
    triage: "受付",
    todo: "着手待ち",
    "urgent-unstarted": "未着手・緊急",
    "in-progress": "進行中",
    blocked: "ブロック中",
    "in-review": "レビュー中",
    done: "完了",
  }[status];
}

function slackKey(teamId: string, userId: string): string {
  return `${teamId}:${userId}`;
}

function googleKey(teamId: string, subject: string): string {
  return `${teamId}:${subject}`;
}

function defined(value: string | null): string {
  if (!value) throw new Error("期限日がありません。");
  return value;
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
