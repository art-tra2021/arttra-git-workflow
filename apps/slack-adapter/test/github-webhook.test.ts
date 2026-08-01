import { describe, expect, test } from "bun:test";
import { parseGitHubWebhookJob, verifyGitHubWebhookSignature } from "../src/github-webhook.ts";
import { GitHubWebhookProcessor } from "../src/github-webhook-processor.ts";
import { CloudTasksGitHubJobQueue, signJob, verifyJobSignature } from "../src/job-queue.ts";
import type { PullRequestReviewService } from "../src/review-service.ts";
import type { StateStore } from "../src/state-store.ts";

describe("GitHub webhook gateway", () => {
  test("GitHub HMACとheaderを検証してversion付きjobへ変換する", () => {
    const body = Buffer.from('{"action":"opened"}');
    const signature = "sha256=931f7549cb28864ede02887873140d15dc87d237f31caea0af7e915b292dff26";
    expect(verifyGitHubWebhookSignature(body, signature, "webhook-secret")).toBe(true);
    expect(verifyGitHubWebhookSignature(body, `${signature}x`, "webhook-secret")).toBe(false);
    expect(parseGitHubWebhookJob(body, "delivery-1", "pull_request")).toEqual({
      schemaVersion: 1,
      deliveryId: "delivery-1",
      event: "pull_request",
      payload: { action: "opened" },
    });
  });

  test("Cloud Tasks worker用signatureの改ざんを拒否する", () => {
    const body = '{"schemaVersion":1}';
    const signature = signJob(body, "job-secret");
    expect(verifyJobSignature(body, signature, "job-secret")).toBe(true);
    expect(verifyJobSignature(`${body} `, signature, "job-secret")).toBe(false);
  });

  test("delivery IDをtask IDにして署名済みJSONをCloud Tasksへ積む", async () => {
    let request: unknown;
    const client = {
      taskPath: (_project: string, _location: string, _queue: string, id: string) => `tasks/${id}`,
      queuePath: () => "queues/reviews",
      createTask: async (value: unknown) => {
        request = value;
        return [{}];
      },
    };
    const queue = new CloudTasksGitHubJobQueue({
      projectId: "project",
      location: "asia-northeast1",
      queue: "reviews",
      publicBaseUrl: "https://slack.example",
      jobSecret: "job-secret",
      client: client as never,
    });
    const job = {
      schemaVersion: 1 as const,
      deliveryId: "delivery-3",
      event: "ping",
      payload: { zen: "safe" },
    };
    expect(await queue.enqueue(job)).toBe(true);
    const task = (
      request as {
        task: { name: string; httpRequest: { body: string; headers: Record<string, string> } };
      }
    ).task;
    const body = Buffer.from(task.httpRequest.body, "base64").toString("utf8");
    expect(task.name).toBe("tasks/github-delivery-3");
    expect(JSON.parse(body)).toEqual(job);
    expect(
      verifyJobSignature(body, task.httpRequest.headers["X-Ar-Job-Signature"] ?? "", "job-secret"),
    ).toBe(true);
  });
});

describe("GitHubWebhookProcessor", () => {
  test("review対象eventを一度だけ処理する", async () => {
    const calls: string[] = [];
    const values = new Map<string, unknown>();
    const store = {
      get: async (_namespace: string, key: string) => values.get(key) ?? null,
      create: async (_namespace: string, key: string, value: unknown) => {
        if (values.has(key)) return false;
        values.set(key, value);
        return true;
      },
    } as unknown as StateStore;
    const reviews = {
      process: async (repository: string, number: number) => {
        calls.push(`${repository}#${number}`);
        return null;
      },
    } as unknown as PullRequestReviewService;
    const processor = new GitHubWebhookProcessor(reviews, store);
    const job = {
      schemaVersion: 1 as const,
      deliveryId: "delivery-2",
      event: "pull_request",
      payload: {
        action: "opened",
        repository: { full_name: "example/repo" },
        pull_request: { number: 28 },
      },
    };
    await processor.process(job);
    await processor.process(job);
    expect(calls).toEqual(["example/repo#28"]);
  });

  test("ProjectとIssueの変更でListを再取得し、同じdeliveryを重複処理しない", async () => {
    const values = new Map<string, unknown>();
    const store = {
      get: async (_namespace: string, key: string) => values.get(key) ?? null,
      create: async (_namespace: string, key: string, value: unknown) => {
        if (values.has(key)) return false;
        values.set(key, value);
        return true;
      },
    } as unknown as StateStore;
    let syncCount = 0;
    const processor = new GitHubWebhookProcessor(null, store, async () => {
      syncCount += 1;
    });
    const projectJob = {
      schemaVersion: 1 as const,
      deliveryId: "delivery-project",
      event: "projects_v2_item",
      payload: { action: "edited" },
    };
    const issueJob = {
      schemaVersion: 1 as const,
      deliveryId: "delivery-issue",
      event: "issues",
      payload: { action: "assigned" },
    };

    await processor.process(projectJob);
    await processor.process(projectJob);
    await processor.process(issueJob);
    await processor.process({
      schemaVersion: 1,
      deliveryId: "delivery-ping",
      event: "ping",
      payload: { zen: "safe" },
    });

    expect(syncCount).toBe(2);
  });
});
