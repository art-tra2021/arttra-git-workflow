import { describe, expect, test } from "bun:test";
import type { StateStore } from "../src/state-store.ts";
import type { HumanWorkItem } from "../src/types.ts";
import {
  type WorkNotificationContext,
  WorkNotificationService,
} from "../src/work-notification-service.ts";

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
          return { messageTs: `100.${sent.length}` };
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
          return { messageTs: `200.${sent.length}` };
        },
        digest: async () => {},
      },
    );

    await service.notifyImmediate();
    items = [workItem("CONFLICTING", "immediate")];
    await service.notifyImmediate();
    expect(sent).toEqual(["CHECKS_FAILED", "CONFLICTING"]);
  });

  test("期限接近を一度だけ担当者へ通知する", async () => {
    const values = new Map<string, unknown>();
    const sent: Array<{ item: HumanWorkItem; context: WorkNotificationContext }> = [];
    const item = workItem("ACTIVE_WORK", "digest");
    item.targetDate = "2026-08-04";
    const service = new WorkNotificationService(
      { loadProjectItems: async () => [item] },
      memoryStore(values),
      {
        notify: async (current, context) => {
          sent.push({ item: current, context });
          return { messageTs: "300.1" };
        },
        digest: async () => {},
      },
      () => Date.parse("2026-08-02T03:00:00Z"),
      async (login) => (login === "alice" ? "UALICE" : null),
      3,
    );

    expect(await service.notifyDeadlines()).toBe(1);
    expect(await service.notifyDeadlines()).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.item.reasonCode).toBe("DUE_SOON");
    expect(sent[0]?.context).toEqual({
      kind: "deadline",
      threadTs: null,
      slackUserId: "UALICE",
    });
  });

  test("同じIssueの通知を同じSlackスレッドへ集約する", async () => {
    const values = new Map<string, unknown>();
    const contexts: WorkNotificationContext[] = [];
    let item = workItem("ACTIVE_WORK", "digest");
    item.targetDate = "2026-08-04";
    const service = new WorkNotificationService(
      { loadProjectItems: async () => [item] },
      memoryStore(values),
      {
        notify: async (_current, context) => {
          contexts.push(context);
          return { messageTs: context.threadTs ?? "400.1" };
        },
        digest: async () => {},
      },
      () => Date.parse("2026-08-02T03:00:00Z"),
    );

    expect(await service.notifyDeadlines()).toBe(1);
    item = workItem("BLOCKED", "immediate");
    item.targetDate = "2026-08-04";
    expect(await service.notifyImmediate()).toBe(1);
    expect(contexts.map((context) => context.threadTs)).toEqual([null, "400.1"]);
    expect(contexts.map((context) => context.kind)).toEqual(["deadline", "state"]);
  });

  test("期限当日と超過への遷移を同じスレッドで一度ずつ通知する", async () => {
    const values = new Map<string, unknown>();
    const sent: Array<{ code: HumanWorkItem["reasonCode"]; threadTs: string | null }> = [];
    let now = Date.parse("2026-08-02T03:00:00Z");
    const item = workItem("ACTIVE_WORK", "digest");
    item.targetDate = "2026-08-04";
    const service = new WorkNotificationService(
      { loadProjectItems: async () => [item] },
      memoryStore(values),
      {
        notify: async (current, context) => {
          sent.push({ code: current.reasonCode, threadTs: context.threadTs });
          return { messageTs: context.threadTs ?? "500.1" };
        },
        digest: async () => {},
      },
      () => now,
    );

    expect(await service.notifyDeadlines()).toBe(1);
    now = Date.parse("2026-08-04T03:00:00Z");
    expect(await service.notifyDeadlines()).toBe(1);
    expect(await service.notifyDeadlines()).toBe(0);
    now = Date.parse("2026-08-05T03:00:00Z");
    expect(await service.notifyDeadlines()).toBe(1);
    expect(sent).toEqual([
      { code: "DUE_SOON", threadTs: null },
      { code: "DUE_TODAY", threadTs: "500.1" },
      { code: "OVERDUE", threadTs: "500.1" },
    ]);
  });

  test("対象外の仕事を通知せず、期限変更後は再通知する", async () => {
    const values = new Map<string, unknown>();
    let sent = 0;
    const active = workItem("ACTIVE_WORK", "digest", 31);
    active.targetDate = "2026-08-04";
    const completed = workItem("COMPLETED", "digest", 32);
    completed.status = "done";
    completed.targetDate = "2026-08-03";
    const unassigned = workItem("ACTIVE_WORK", "digest", 33);
    unassigned.owner = null;
    unassigned.targetDate = "2026-08-03";
    const noDate = workItem("ACTIVE_WORK", "digest", 34);
    noDate.targetDate = null;
    const far = workItem("ACTIVE_WORK", "digest", 35);
    far.targetDate = "2026-08-20";
    let items = [active, completed, unassigned, noDate, far];
    const service = new WorkNotificationService(
      { loadProjectItems: async () => items },
      memoryStore(values),
      {
        notify: async (_current, context) => {
          sent += 1;
          return { messageTs: context.threadTs ?? `600.${sent}` };
        },
        digest: async () => {},
      },
      () => Date.parse("2026-08-02T03:00:00Z"),
    );

    expect(await service.notifyDeadlines()).toBe(1);
    active.targetDate = "2026-08-05";
    items = [active, completed, unassigned, noDate, far];
    expect(await service.notifyDeadlines()).toBe(1);
    expect(sent).toBe(2);
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
