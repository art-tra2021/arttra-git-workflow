import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GoogleCalendarFetch, GoogleCalendarService } from "../src/google-calendar-service.ts";
import type { GitHubIdentity } from "../src/identity-service.ts";
import { LocalStateStore } from "../src/state-store.ts";
import type { HumanWorkItem } from "../src/types.ts";

describe("Google Calendar同期", () => {
  test("OAuth tokenを暗号化し、本人担当の期限付き未完了項目だけを同期する", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-calendar-")));
    const requests: Array<{ url: string; method: string; body: string }> = [];
    const fetchStub: GoogleCalendarFetch = async (input, init = {}) => {
      const method = init.method ?? "GET";
      requests.push({ url: input, method, body: init.body?.toString() ?? "" });
      if (input.endsWith("/token") && init.body?.toString().includes("authorization_code")) {
        return json({ access_token: "access-initial", refresh_token: "refresh-sensitive" });
      }
      if (input.includes("userinfo")) {
        return json({ sub: "google-123", email: "alice@example.com", email_verified: true });
      }
      if (input.endsWith("/token")) return json({ access_token: "access-refreshed" });
      if (input.endsWith("/calendars")) return json({ id: "calendar@example.com" });
      if (input.includes("/events?") && method === "GET") {
        return json(
          [
            {
              id: "arttrastale",
              extendedProperties: {
                private: { managedBy: "arttra-work", githubUrl: "https://example.com/stale" },
              },
            },
          ],
          200,
          "items",
        );
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
      return json({ id: "created-event" });
    };
    const service = calendarService(store, fetchStub, [workItem("alice"), workItem("bob")]);

    const url = new URL(await service.connectUrl("T123", "U123"));
    expect(url.searchParams.get("scope")).toContain("calendar.app.created");
    const identity = await service.complete("oauth-code", url.searchParams.get("state") ?? "");
    expect(identity.googleEmail).toBe("alice@example.com");
    expect(identity.encryptedRefreshToken).not.toContain("refresh-sensitive");
    await store.set<GitHubIdentity>("github-identity", "T123:U123", {
      schemaVersion: 1,
      revision: 1,
      slackTeamId: "T123",
      slackUserId: "U123",
      githubUserId: 1,
      githubLogin: "alice",
      verifiedAt: "2026-08-02T00:00:00.000Z",
    });

    expect(await service.syncUser("T123", "U123")).toEqual({
      slackUserId: "U123",
      calendarId: "calendar@example.com",
      itemCount: 1,
      created: 1,
      updated: 0,
      deleted: 1,
    });
    const createdEvent = requests.find(
      (request) => request.method === "POST" && request.url.endsWith("/events"),
    );
    expect(JSON.parse(createdEvent?.body ?? "{}")).toEqual(
      expect.objectContaining({
        summary: "[P1] 自分の期限付きタスク",
        start: { date: "2026-08-10" },
        end: { date: "2026-08-11" },
        extendedProperties: {
          private: {
            managedBy: "arttra-work",
            githubUrl: "https://github.com/example/repo/issues/1",
          },
        },
      }),
    );
    expect(requests.some((request) => request.method === "DELETE")).toBe(true);
  });

  test("未連携ユーザーには日本語で次の操作を案内する", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-calendar-")));
    const service = calendarService(store, async () => json({}), []);

    await expect(service.syncUser("T123", "U123")).rejects.toThrow("/ar connect google");
  });

  test("連携解除後も専用カレンダー自体は削除しない", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-calendar-")));
    const service = calendarService(store, oauthFetch(), []);
    const url = new URL(await service.connectUrl("T123", "U123"));
    await service.complete("oauth-code", url.searchParams.get("state") ?? "");

    expect(await service.disconnect("T123", "U123")).toBe(true);
    expect(await service.get("T123", "U123")).toBeNull();
    expect(await service.disconnect("T123", "U123")).toBe(false);
  });
});

function calendarService(
  store: LocalStateStore,
  fetchStub: GoogleCalendarFetch,
  items: HumanWorkItem[],
): GoogleCalendarService {
  return new GoogleCalendarService({
    clientId: "google-client",
    clientSecret: "google-secret",
    stateSecret: "state-secret-that-is-longer-than-32-characters",
    tokenEncryptionSecret: "token-secret-that-is-longer-than-32-characters",
    publicBaseUrl: "https://work.example.com",
    store,
    source: { loadWorkItems: async () => items },
    fetch: fetchStub,
    now: () => Date.parse("2026-08-02T00:00:00.000Z"),
    nonce: () => "nonce-123",
    oauthBaseUrl: "https://oauth.example.com",
    calendarApiBaseUrl: "https://calendar.example.com",
    userInfoUrl: "https://userinfo.example.com",
  });
}

function oauthFetch(): GoogleCalendarFetch {
  return async (input) =>
    input.includes("userinfo")
      ? json({ sub: "google-123", email: "alice@example.com", email_verified: true })
      : json({ access_token: "access", refresh_token: "refresh" });
}

function workItem(owner: string): HumanWorkItem {
  return {
    schemaVersion: 1,
    issueNumber: owner === "alice" ? 1 : 2,
    title: owner === "alice" ? "自分の期限付きタスク" : "他人のタスク",
    url: `https://github.com/example/repo/issues/${owner === "alice" ? 1 : 2}`,
    status: "in-progress",
    priority: "P1",
    owner,
    targetDate: "2026-08-10",
    delivery: "digest",
    reasonCode: "ACTIVE_WORK",
    nextActor: owner,
    nextAction: "作業を進める",
    reason: "進行中",
    actions: ["open-github"],
  };
}

function json(value: unknown, status = 200, wrapper?: string): Response {
  return new Response(JSON.stringify(wrapper ? { [wrapper]: value } : value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
