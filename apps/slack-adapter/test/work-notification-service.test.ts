import { describe, expect, test } from "bun:test";
import type { StateStore } from "../src/state-store.ts";
import type { HumanWorkItem } from "../src/types.ts";
import { WorkNotificationService } from "../src/work-notification-service.ts";

describe("WorkNotificationService", () => {
  test("即時通知だけを変更時に一度送り、通常作業はdigestへまとめる", async () => {
    const values = new Map<string, unknown>();
    const sent: string[] = [];
    const digests: number[] = [];
    let items = [workItem("BLOCKED", "immediate"), workItem("ACTIVE_WORK", "digest", 24)];
    const service = new WorkNotificationService(
      { loadProjectItems: async () => items },
      memoryStore(values),
      {
        notify: async (item) => {
          sent.push(`${item.issueNumber}:${item.reasonCode}`);
        },
        digest: async (current) => {
          digests.push(current.length);
        },
      },
      () => Date.parse("2026-08-01T00:00:00Z"),
    );

    expect(await service.notifyImmediate()).toBe(1);
    expect(await service.notifyImmediate()).toBe(0);
    expect(sent).toEqual(["23:BLOCKED"]);
    expect(await service.sendDigest()).toBe(2);
    expect(digests).toEqual([2]);

    items = [workItem("ACTIVE_WORK", "digest")];
    expect(await service.notifyImmediate()).toBe(0);
    items = [workItem("BLOCKED", "immediate")];
    expect(await service.notifyImmediate()).toBe(1);
    expect(sent).toEqual(["23:BLOCKED", "23:BLOCKED"]);
  });

  test("通知理由が変われば同じIssueを再通知する", async () => {
    const values = new Map<string, unknown>();
    const sent: string[] = [];
    let items = [workItem("CHECKS_FAILED", "immediate")];
    const service = new WorkNotificationService(
      { loadProjectItems: async () => items },
      memoryStore(values),
      {
        notify: async (item) => {
          sent.push(item.reasonCode);
        },
        digest: async () => {},
      },
    );

    await service.notifyImmediate();
    items = [workItem("CONFLICTING", "immediate")];
    await service.notifyImmediate();
    expect(sent).toEqual(["CHECKS_FAILED", "CONFLICTING"]);
  });
});

function workItem(
  reasonCode: HumanWorkItem["reasonCode"],
  delivery: HumanWorkItem["delivery"],
  issueNumber = 23,
): HumanWorkItem {
  return {
    schemaVersion: 1,
    issueNumber,
    title: `Issue ${issueNumber}`,
    url: `https://github.com/art-tra2021/service/issues/${issueNumber}`,
    status: reasonCode === "BLOCKED" ? "blocked" : "in-progress",
    priority: issueNumber === 23 ? "P0" : "P2",
    owner: "alice",
    targetDate: "2026-08-10",
    delivery,
    reasonCode,
    nextActor: "alice",
    nextAction: reasonCode,
    reason: reasonCode,
    actions: ["open-github"],
  };
}

function memoryStore(values: Map<string, unknown>): StateStore {
  const storageKey = (namespace: string, key: string) => `${namespace}:${key}`;
  return {
    get: async <T>(namespace: string, key: string) =>
      (values.get(storageKey(namespace, key)) as T | undefined) ?? null,
    list: async <T>() => [...values.values()] as T[],
    set: async (namespace: string, key: string, value: unknown) => {
      values.set(storageKey(namespace, key), value);
    },
    create: async (namespace: string, key: string, value: unknown) => {
      const resolved = storageKey(namespace, key);
      if (values.has(resolved)) return false;
      values.set(resolved, value);
      return true;
    },
    compareAndSet: async () => false,
    remove: async (namespace: string, key: string) => {
      values.delete(storageKey(namespace, key));
    },
    append: async () => "event-1",
  };
}
