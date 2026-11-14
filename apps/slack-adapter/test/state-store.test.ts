import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Firestore } from "@google-cloud/firestore";
import { FirestoreStateStore, LocalStateStore } from "../src/state-store.ts";

describe("LocalStateStore", () => {
  test("set、get、removeを同じversion付き形式で扱う", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-state-")));
    await store.set("canvas", "C123", { canvasId: "F123" });
    expect(await store.get<{ canvasId: string }>("canvas", "C123")).toEqual({
      canvasId: "F123",
    });
    await store.remove("canvas", "C123");
    expect(await store.get("canvas", "C123")).toBeNull();
  });

  test("createは同じkeyを上書きしない", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-state-")));
    expect(await store.create("dedupe", "event-1", { result: "first" })).toBe(true);
    expect(await store.create("dedupe", "event-1", { result: "second" })).toBe(false);
    expect(await store.get<{ result: string }>("dedupe", "event-1")).toEqual({
      result: "first",
    });
    expect(await store.list("dedupe")).toEqual([{ result: "first" }]);
    expect(await store.listEntries("dedupe")).toEqual([
      { key: "event-1", value: { result: "first" } },
    ]);
  });

  test("compareAndSetは同じrevisionを一度だけ更新する", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-state-")));
    await store.set("approval", "A1", { revision: 1, status: "pending" });
    const [first, second] = await Promise.all([
      store.compareAndSet("approval", "A1", 1, { revision: 2, status: "approved" }),
      store.compareAndSet("approval", "A1", 1, { revision: 2, status: "rejected" }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect((await store.get<{ revision: number }>("approval", "A1"))?.revision).toBe(2);
  });
});

describe("expireAt", () => {
  test("Firestoreではdocumentの最上位にDateとして置き、TTL policyが見られるようにする", async () => {
    const written: Array<{ collection: string; data: Record<string, unknown> }> = [];
    const fake = {
      collection: (collection: string) => ({
        doc: () => ({
          create: async (data: Record<string, unknown>) => {
            written.push({ collection, data });
          },
          set: async (data: Record<string, unknown>) => {
            written.push({ collection, data });
          },
        }),
      }),
    } as unknown as Firestore;
    const store = new FirestoreStateStore(fake, "arttra_prod");
    const expireAt = new Date("2026-12-14T03:00:00.000Z");
    await store.create("scheduled-job-run", "calendar-sync:2026-11-14T03Z", { a: 1 }, { expireAt });
    await store.set("scheduled-job-run", "calendar-sync:2026-11-14T03Z", { a: 2 });
    expect(written[0]?.collection).toBe("arttra_prod_scheduled_job_run");
    expect(written[0]?.data.expireAt).toBe(expireAt);
    expect(written[0]?.data.value).toEqual({ a: 1 });
    expect("expireAt" in (written[1]?.data ?? {})).toBe(false);
  });

  test("localでは記録に残すだけで、valueの読み書きは変えない", async () => {
    const root = await mkdtemp(join(tmpdir(), "arttra-state-"));
    const store = new LocalStateStore(root);
    await store.create("ttl", "k", { revision: 1 }, { expireAt: new Date("2026-12-14T00:00:00Z") });
    expect(await store.get<{ revision: number }>("ttl", "k")).toEqual({ revision: 1 });
    const [directory] = await readdir(root);
    const [file] = await readdir(join(root, directory ?? ""));
    const stored = JSON.parse(await readFile(join(root, directory ?? "", file ?? ""), "utf8"));
    expect(stored.expireAt).toBe("2026-12-14T00:00:00.000Z");
  });
});
