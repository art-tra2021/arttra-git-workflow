import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlackRequirementNotifier } from "../src/slack-requirement-notifier.ts";
import { LocalStateStore } from "../src/state-store.ts";

describe("SlackRequirementNotifier", () => {
  test("GitHub未連携者をnative mentionし、24時間は同じ要求を連投しない", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let now = Date.parse("2026-08-02T07:00:00Z");
    const notifier = new SlackRequirementNotifier(
      {
        chat: {
          postMessage: async (arguments_: Record<string, unknown>) => {
            calls.push(arguments_);
            return { ok: true, ts: "100.1" };
          },
        },
      } as unknown as ConstructorParameters<typeof SlackRequirementNotifier>[0],
      new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-requirement-"))),
      () => now,
    );
    const requirement = {
      channelId: "CWORK",
      slackTeamId: "TWORK",
      slackUserIds: ["URUKI", "URUKI"],
    };

    expect(await notifier.requireGitHubConnection(requirement)).toBe(1);
    expect(await notifier.requireGitHubConnection(requirement)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("🧩");
    expect(JSON.stringify(calls[0]?.blocks)).toContain("<@URUKI>");
    expect(JSON.stringify(calls[0]?.blocks)).toContain("/ar connect github");

    now += 24 * 60 * 60 * 1000;
    expect(await notifier.requireGitHubConnection(requirement)).toBe(1);
    expect(calls).toHaveLength(2);
  });
});
