import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStateStore } from "../src/state-store.ts";

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
