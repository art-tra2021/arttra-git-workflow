import { renderWorkCanvas } from "./presentation.ts";
import type { HumanWorkItem } from "./types.ts";

export interface CanvasClient {
  canvases: {
    edit(input: {
      canvas_id: string;
      changes: Array<{
        operation: "replace";
        document_content: { type: "markdown"; markdown: string };
      }>;
    }): Promise<unknown>;
  };
  conversations: {
    canvases: {
      create(input: {
        channel_id: string;
        document_content: { type: "markdown"; markdown: string };
      }): Promise<{ canvas_id?: string }>;
    };
  };
}

export interface SyncWorkCanvasInput {
  channelId: string;
  canvasId?: string;
  generatedAt: string;
  items: HumanWorkItem[];
}

export async function syncWorkCanvas(
  client: CanvasClient,
  input: SyncWorkCanvasInput,
): Promise<string> {
  const markdown = renderWorkCanvas(input.items, input.generatedAt);

  if (input.canvasId) {
    await client.canvases.edit({
      canvas_id: input.canvasId,
      changes: [
        {
          operation: "replace",
          document_content: { type: "markdown", markdown },
        },
      ],
    });
    return input.canvasId;
  }

  const result = await client.conversations.canvases.create({
    channel_id: input.channelId,
    document_content: { type: "markdown", markdown },
  });
  if (!result.canvas_id) {
    throw new Error("Slack Canvasの作成結果にcanvas_idがありません");
  }
  return result.canvas_id;
}
