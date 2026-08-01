import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanvasClient } from "../src/canvas.ts";
import { CanvasSyncService } from "../src/canvas-service.ts";
import { toHumanWorkItem } from "../src/read-model.ts";
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
    const service = new CanvasSyncService(client, source, directory);

    expect((await service.sync("C123")).canvasId).toBe("F-CANVAS");
    expect((await service.sync("C123")).canvasId).toBe("F-CANVAS");
    expect(created).toEqual(["C123"]);
    expect(edited).toEqual(["F-CANVAS"]);
    expect(await readFile(join(directory, "C123.canvas-id"), "utf8")).toBe("F-CANVAS\n");
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
    const service = new CanvasSyncService(client, { loadCanvasItems: async () => [] }, directory);

    expect(service.sync("C123")).rejects.toThrow("/invite @ART-TRA Work Lab");
  });
});
