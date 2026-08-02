import { describe, expect, test } from "bun:test";
import { completeGoogleCalendarCallback } from "../src/google-calendar-callback.ts";
import type { GoogleCalendarIdentity } from "../src/google-calendar-service.ts";

const identity: GoogleCalendarIdentity = {
  schemaVersion: 1,
  revision: 1,
  slackTeamId: "T123",
  slackUserId: "U123",
  googleSubject: "google-123",
  googleEmail: "alice@example.com",
  encryptedRefreshToken: "encrypted",
  calendarId: null,
  verifiedAt: "2026-08-02T00:00:00.000Z",
};

describe("Google Calendar callback", () => {
  test("連携と初回同期が成功した結果を返す", async () => {
    const result = await completeGoogleCalendarCallback(
      {
        complete: async () => identity,
        syncUser: async () => ({
          slackUserId: "U123",
          calendarId: "calendar@example.com",
          itemCount: 1,
          created: 1,
          updated: 0,
          deleted: 0,
        }),
      },
      "code",
      "state",
    );

    expect(result.sync?.calendarId).toBe("calendar@example.com");
    expect(result.syncWarning).toBeNull();
  });

  test("連携成功後の初回同期失敗は警告として返す", async () => {
    const result = await completeGoogleCalendarCallback(
      {
        complete: async () => identity,
        syncUser: async () => {
          throw new Error("GitHubアカウントが未連携です。");
        },
      },
      "code",
      "state",
    );

    expect(result.identity).toEqual(identity);
    expect(result.sync).toBeNull();
    expect(result.syncWarning).toBe("GitHubアカウントが未連携です。");
  });

  test("OAuth連携自体の失敗は呼び出し元へ返す", async () => {
    await expect(
      completeGoogleCalendarCallback(
        {
          complete: async () => {
            throw new Error("OAuth token交換に失敗しました。");
          },
          syncUser: async () => {
            throw new Error("呼ばれない");
          },
        },
        "code",
        "state",
      ),
    ).rejects.toThrow("OAuth token交換に失敗しました。");
  });
});
