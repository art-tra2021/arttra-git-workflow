import { type CanvasClient, syncWorkCanvas } from "./canvas.ts";
import type { StateStore } from "./state-store.ts";
import type { HumanWorkItem } from "./types.ts";

export interface CanvasWorkSource {
  loadCanvasItems(): Promise<HumanWorkItem[]>;
}

export interface CanvasSyncResult {
  canvasId: string;
  itemCount: number;
}

export class CanvasSyncService {
  private readonly client: CanvasClient;
  private readonly source: CanvasWorkSource;
  private readonly store: StateStore;
  private readonly configuredCanvasId: string | null;

  constructor(
    client: CanvasClient,
    source: CanvasWorkSource,
    store: StateStore,
    configuredCanvasId: string | null = null,
  ) {
    this.client = client;
    this.source = source;
    this.store = store;
    if (configuredCanvasId && !/^F[A-Z0-9]+$/.test(configuredCanvasId)) {
      throw new Error("Slack Canvas IDが不正です。");
    }
    this.configuredCanvasId = configuredCanvasId;
  }

  async sync(channelId: string): Promise<CanvasSyncResult> {
    if (!/^[CG][A-Z0-9]+$/.test(channelId)) {
      throw new Error("Slack channel IDが不正です。");
    }
    const state = await this.store.get<{ canvasId: string }>("canvas", channelId);
    const canvasId = this.configuredCanvasId ?? state?.canvasId ?? undefined;
    const items = await this.source.loadCanvasItems();
    let syncedCanvasId: string;
    try {
      syncedCanvasId = await syncWorkCanvas(this.client, {
        channelId,
        ...(canvasId ? { canvasId } : {}),
        generatedAt: formatJst(new Date()),
        items,
      });
    } catch (error) {
      if (slackErrorCode(error) === "not_in_channel") {
        throw new Error(
          "ART-TRA Work Labが対象チャンネルに参加していません。Slackで `/invite @ART-TRA Work Lab` を実行してから再同期してください。",
        );
      }
      throw error;
    }
    await this.store.set("canvas", channelId, { canvasId: syncedCanvasId });
    return { canvasId: syncedCanvasId, itemCount: items.length };
  }
}

function slackErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("data" in error)) {
    return undefined;
  }
  const data = error.data;
  if (!data || typeof data !== "object" || !("error" in data)) {
    return undefined;
  }
  return typeof data.error === "string" ? data.error : undefined;
}

function formatJst(date: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Tokyo",
  }).format(date);
}
