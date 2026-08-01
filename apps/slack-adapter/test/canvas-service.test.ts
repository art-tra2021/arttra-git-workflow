import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanvasClient } from "../src/canvas.ts";
import { CanvasSyncService } from "../src/canvas-service.ts";
import { toHumanWorkItem } from "../src/read-model.ts";
import { LocalStateStore } from "../src/state-store.ts";
import { snapshot } from "./fixtures.ts";

describe("CanvasSyncService", () => {
  test("作成したCanvas IDを保存し、次回は同じCanvasを更新する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arttra-canvas-"));
    const created: string[] = [];
    const edited: string[] = [];
    const client: CanvasClient = {
      canvases: {
        edit: async (input) => {
          edited.push(input.canvas_id);
        },
      },
      conversations: {
        canvases: {
          create: async (input) => {
            created.push(input.channel_id);
            return { canvas_id: "F-CANVAS" };
          },
        },
      },
    };
    const source = { loadCanvasItems: async () => [toHumanWorkItem(snapshot(), "reviewer")] };
    const store = new LocalStateStore(directory);
    const service = new CanvasSyncService(client, source, store);

    expect((await service.sync("C123")).canvasId).toBe("F-CANVAS");
    expect((await service.sync("C123")).canvasId).toBe("F-CANVAS");
    expect(created).toEqual(["C123"]);
    expect(edited).toEqual(["F-CANVAS"]);
    expect(await store.get<{ canvasId: string }>("canvas", "C123")).toEqual({
      canvasId: "F-CANVAS",
    });
  });

  test("未参加channelでは招待commandを日本語で案内する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arttra-canvas-"));
    const client: CanvasClient = {
      canvases: { edit: async () => {} },
      conversations: {
        canvases: {
          create: async () => {
            throw { data: { error: "not_in_channel" } };
          },
        },
      },
    };
    const service = new CanvasSyncService(
      client,
      { loadCanvasItems: async () => [] },
      new LocalStateStore(directory),
    );

    expect(service.sync("C123")).rejects.toThrow("/invite @ART-TRA Work Lab");
  });

  test("設定済みCanvas IDはchannel参加前でも直接更新する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arttra-canvas-"));
    const edited: string[] = [];
    const client: CanvasClient = {
      canvases: {
        edit: async (input) => {
          edited.push(input.canvas_id);
        },
      },
      conversations: {
        canvases: {
          create: async () => {
            throw new Error("既存Canvas指定時は作成しない");
          },
        },
      },
    };
    const store = new LocalStateStore(directory);
    const service = new CanvasSyncService(
      client,
      { loadCanvasItems: async () => [] },
      store,
      "F0BM88NUQAZ",
    );

    await store.set("canvas", "C0BK0RGD87J", { canvasId: "F-OLD" });
    expect((await service.sync("C0BK0RGD87J")).canvasId).toBe("F0BM88NUQAZ");
    expect(edited).toEqual(["F0BM88NUQAZ"]);
    expect(await store.get<{ canvasId: string }>("canvas", "C0BK0RGD87J")).toEqual({
      canvasId: "F0BM88NUQAZ",
    });
  });
});
