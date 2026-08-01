import { describe, expect, test } from "bun:test";
import { type CanvasClient, syncWorkCanvas } from "../src/canvas.ts";
import { renderWorkCanvas } from "../src/presentation.ts";
import { toHumanWorkItem } from "../src/read-model.ts";
import { snapshot } from "./fixtures.ts";

describe("Slack Canvas", () => {
  test("生イベントではなく次の行動を表示する", () => {
    const markdown = renderWorkCanvas(
      [toHumanWorkItem(snapshot(), "reviewer")],
      "2026-08-01 12:00 JST",
    );
    expect(markdown).toContain("次に動く人");
    expect(markdown).toContain("次の完了条件を進める");
    expect(markdown).not.toContain("payload");
  });

  test("既存Canvasは全体置換で更新する", async () => {
    const calls: unknown[] = [];
    const client: CanvasClient = {
      canvases: { edit: async (input) => void calls.push(input) },
      conversations: { canvases: { create: async () => ({ canvas_id: "new-canvas" }) } },
    };
    const canvasId = await syncWorkCanvas(client, {
      channelId: "C123",
      canvasId: "F123",
      generatedAt: "2026-08-01 12:00 JST",
      items: [toHumanWorkItem(snapshot(), "reviewer")],
    });
    expect(canvasId).toBe("F123");
    expect(calls).toHaveLength(1);
  });
});
