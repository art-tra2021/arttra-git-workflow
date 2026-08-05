import { createHmac, timingSafeEqual } from "node:crypto";
import type { GitHubWebhookJob } from "./job-queue.ts";

export function verifyGitHubWebhookSignature(
  body: Buffer,
  signature: string,
  secret: string,
): boolean {
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function parseGitHubWebhookJob(
  body: Buffer,
  deliveryId: string,
  event: string,
): GitHubWebhookJob {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(deliveryId)) {
    throw new Error("GitHub delivery IDが不正です。");
  }
  if (!/^[a-z_][a-z0-9_]{0,49}$/.test(event)) {
    throw new Error("GitHub event名が不正です。");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("GitHub webhook JSONを読み取れませんでした。");
  }
  return { schemaVersion: 1, deliveryId, event, payload };
}
