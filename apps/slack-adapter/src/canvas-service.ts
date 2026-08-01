import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type CanvasClient, syncWorkCanvas } from "./canvas.ts";
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
  private readonly stateDirectory: string;

  constructor(client: CanvasClient, source: CanvasWorkSource, stateDirectory: string) {
    this.client = client;
    this.source = source;
    this.stateDirectory = stateDirectory;
  }

  async sync(channelId: string): Promise<CanvasSyncResult> {
    if (!/^[CG][A-Z0-9]+$/.test(channelId)) {
      throw new Error("Slack channel IDが不正です。");
    }
    const statePath = join(this.stateDirectory, `${channelId}.canvas-id`);
    const canvasId = await readOptionalFile(statePath);
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
    await writeAtomic(statePath, `${syncedCanvasId}\n`);
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

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeAtomic(path: string, value: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, value, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
}

function formatJst(date: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Tokyo",
  }).format(date);
}
