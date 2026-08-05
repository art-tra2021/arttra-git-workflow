import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { parseGitHubWebhookJob, verifyGitHubWebhookSignature } from "../src/github-webhook.ts";
import { GitHubWebhookProcessor } from "../src/github-webhook-processor.ts";
import { CloudTasksGitHubJobQueue, signJob, verifyJobSignature } from "../src/job-queue.ts";
import type { LifecycleNotificationService } from "../src/lifecycle-notification-service.ts";
import { RetryableWorkError } from "../src/retryable-error.ts";
import type { PullRequestReviewService } from "../src/review-service.ts";
import type { StateStore } from "../src/state-store.ts";
import type { WorkNotificationService } from "../src/work-notification-service.ts";

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

  test("署名済みprojects_v2_itemをversion付きjobへ変換する", () => {
    const body = Buffer.from('{"action":"edited"}');
    const signature = `sha256=${createHmac("sha256", "webhook-secret").update(body).digest("hex")}`;

    expect(verifyGitHubWebhookSignature(body, signature, "webhook-secret")).toBe(true);
    expect(parseGitHubWebhookJob(body, "delivery-project-item", "projects_v2_item")).toEqual({
      schemaVersion: 1,
      deliveryId: "delivery-project-item",
      event: "projects_v2_item",
      payload: { action: "edited" },
    });
  });

  test.each([
    ["先頭数字", "2projects_v2_item"],
    ["記号", "projects-v2_item"],
    ["51文字", `a${"0".repeat(50)}`],
  ])("不正なevent名（%s）を拒否する", (_case, event) => {
    expect(() =>
      parseGitHubWebhookJob(Buffer.from('{"action":"edited"}'), "delivery-invalid", event),
    ).toThrow("GitHub event名が不正です。");
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
    const store = memoryStore();
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

  test("review_requestedで手動指定reviewerのreview処理を行う", async () => {
    const calls: string[] = [];
    const store = memoryStore();
    const reviews = {
      process: async (repository: string, number: number) => {
        calls.push(`${repository}#${number}`);
        return null;
      },
    } as unknown as PullRequestReviewService;
    const processor = new GitHubWebhookProcessor(reviews, store);
    const job = {
      schemaVersion: 1 as const,
      deliveryId: "delivery-review-requested",
      event: "pull_request",
      payload: {
        action: "review_requested",
        repository: { full_name: "example/repo" },
        pull_request: { number: 28 },
      },
    };

    await processor.process(job);
    await processor.process(job);

    expect(calls).toEqual(["example/repo#28"]);
  });

  test("ready_for_reviewの同一delivery再処理はreview処理を一度だけ行う", async () => {
    const calls: string[] = [];
    const store = memoryStore();
    const reviews = {
      process: async (repository: string, number: number) => {
        calls.push(`${repository}#${number}`);
        return null;
      },
    } as unknown as PullRequestReviewService;
    const processor = new GitHubWebhookProcessor(reviews, store);
    const job = {
      schemaVersion: 1 as const,
      deliveryId: "delivery-ready-for-review",
      event: "pull_request",
      payload: {
        action: "ready_for_review",
        repository: { full_name: "example/repo" },
        pull_request: { number: 119 },
      },
    };

    await processor.process(job);
    await processor.process(job);

    expect(calls).toEqual(["example/repo#119"]);
  });

  test("ProjectとIssueの変更でListを再取得し、同じdeliveryを重複処理しない", async () => {
    const store = memoryStore();
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

  test("CI結果はlifecycle通知へ一本化し、汎用作業通知を重ねない", async () => {
    const store = memoryStore();
    let notificationCount = 0;
    let lifecycleCount = 0;
    const notifications = {
      notifyImmediate: async () => {
        notificationCount += 1;
        return 1;
      },
    } as unknown as WorkNotificationService;
    const lifecycle = {
      process: async () => {
        lifecycleCount += 1;
        return 1;
      },
    } as unknown as LifecycleNotificationService;
    const processor = new GitHubWebhookProcessor(null, store, undefined, notifications, lifecycle);
    const job = {
      schemaVersion: 1 as const,
      deliveryId: "delivery-check",
      event: "check_run",
      payload: { action: "completed" },
    };

    await processor.process(job);
    await processor.process(job);

    expect(lifecycleCount).toBe(1);
    expect(notificationCount).toBe(0);
  });

  test("Issueコメントをライフサイクル通知へ一度だけ渡す", async () => {
    const store = memoryStore();
    const calls: string[] = [];
    const lifecycle = {
      process: async (job: { event: string }) => {
        calls.push(job.event);
        return 1;
      },
    } as unknown as LifecycleNotificationService;
    const processor = new GitHubWebhookProcessor(null, store, undefined, null, lifecycle);
    const job = {
      schemaVersion: 1 as const,
      deliveryId: "delivery-comment",
      event: "issue_comment",
      payload: { action: "created" },
    };

    await processor.process(job);
    await processor.process(job);

    expect(calls).toEqual(["issue_comment"]);
  });

  test("同じdeliveryの並列実行では副作用を一度だけ行う", async () => {
    const store = memoryStore();
    let lifecycleEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      lifecycleEntered = resolve;
    });
    let releaseLifecycle!: () => void;
    const lifecycleGate = new Promise<void>((resolve) => {
      releaseLifecycle = resolve;
    });
    let lifecycleCalls = 0;
    const lifecycle = {
      process: async () => {
        lifecycleCalls += 1;
        lifecycleEntered();
        await lifecycleGate;
        return 1;
      },
    } as unknown as LifecycleNotificationService;
    const processor = new GitHubWebhookProcessor(null, store, undefined, null, lifecycle);
    const job = {
      schemaVersion: 1 as const,
      deliveryId: "delivery-parallel",
      event: "issue_comment",
      payload: { action: "created" },
    };

    const first = processor.process(job);
    await entered;
    const second = processor.process(job);
    await second;
    releaseLifecycle();
    await first;

    expect(lifecycleCalls).toBe(1);
  });

  test("Project List同期競合の再試行では通知副作用を二重化しない", async () => {
    const store = memoryStore();
    let syncCalls = 0;
    let lifecycleCalls = 0;
    let notificationCalls = 0;
    const processor = new GitHubWebhookProcessor(
      null,
      store,
      async () => {
        syncCalls += 1;
        if (syncCalls === 1) {
          throw new RetryableWorkError(
            "project_list_sync_in_progress",
            "Slack Project Listの同期処理が進行中です。",
          );
        }
      },
      {
        notifyImmediate: async () => {
          notificationCalls += 1;
          return 1;
        },
      } as unknown as WorkNotificationService,
      {
        process: async () => {
          lifecycleCalls += 1;
          return 1;
        },
      } as unknown as LifecycleNotificationService,
    );
    const job = {
      schemaVersion: 1 as const,
      deliveryId: "delivery-sync-retry",
      event: "issues",
      payload: { action: "assigned" },
    };

    await expect(processor.process(job)).rejects.toMatchObject({
      code: "project_list_sync_in_progress",
    });
    expect(syncCalls).toBe(1);
    expect(lifecycleCalls).toBe(0);
    expect(notificationCalls).toBe(0);

    await processor.process(job);
    expect(syncCalls).toBe(2);
    expect(lifecycleCalls).toBe(1);
    expect(notificationCalls).toBe(1);
  });

  test("外部副作用開始後に失敗したdeliveryを再試行しても副作用を再実行しない", async () => {
    const store = memoryStore();
    let reviewCalls = 0;
    let lifecycleCalls = 0;
    const reviews = {
      process: async () => {
        reviewCalls += 1;
        return null;
      },
    } as unknown as PullRequestReviewService;
    const lifecycle = {
      process: async () => {
        lifecycleCalls += 1;
        throw new Error("Slack通知が一時的に失敗しました。");
      },
    } as unknown as LifecycleNotificationService;
    const processor = new GitHubWebhookProcessor(reviews, store, undefined, null, lifecycle);
    const job = {
      schemaVersion: 1 as const,
      deliveryId: "delivery-effects-failed",
      event: "pull_request",
      payload: {
        action: "opened",
        repository: { full_name: "example/repo" },
        pull_request: { number: 41 },
      },
    };

    await expect(processor.process(job)).rejects.toThrow("Slack通知が一時的に失敗");
    await processor.process(job);

    expect(reviewCalls).toBe(1);
    expect(lifecycleCalls).toBe(1);
    expect(await store.get("github-delivery", job.deliveryId)).toMatchObject({
      status: "failed",
    });
  });

  test("Issue thread root作成競合はdeliveryをretryableに戻して再試行する", async () => {
    const store = memoryStore();
    let lifecycleCalls = 0;
    const lifecycle = {
      process: async () => {
        lifecycleCalls += 1;
        if (lifecycleCalls === 1) {
          throw new RetryableWorkError(
            "notification_thread_root_in_progress",
            "Issue通知threadのrootを別workerが作成中です。",
          );
        }
        return 1;
      },
    } as unknown as LifecycleNotificationService;
    const processor = new GitHubWebhookProcessor(null, store, undefined, null, lifecycle);
    const job = {
      schemaVersion: 1 as const,
      deliveryId: "delivery-thread-retry",
      event: "issue_comment",
      payload: { action: "created" },
    };

    await expect(processor.process(job)).rejects.toMatchObject({
      code: "notification_thread_root_in_progress",
    });
    expect(await store.get("github-delivery", job.deliveryId)).toMatchObject({
      status: "retryable",
      failure: "notification_thread_root_in_progress",
    });

    await processor.process(job);
    expect(lifecycleCalls).toBe(2);
    expect(await store.get("github-delivery", job.deliveryId)).toMatchObject({
      status: "completed",
    });
  });

  test("schemaVersion 1のdelivery markerは完了済みとして扱う", async () => {
    const store = memoryStore();
    await store.set("github-delivery", "delivery-legacy", {
      schemaVersion: 1,
      processedAt: "2026-08-02T00:00:00.000Z",
      event: "issue_comment",
    });
    let lifecycleCalls = 0;
    const lifecycle = {
      process: async () => {
        lifecycleCalls += 1;
        return 1;
      },
    } as unknown as LifecycleNotificationService;
    const processor = new GitHubWebhookProcessor(null, store, undefined, null, lifecycle);

    await processor.process({
      schemaVersion: 1,
      deliveryId: "delivery-legacy",
      event: "issue_comment",
      payload: { action: "created" },
    });

    expect(lifecycleCalls).toBe(0);
    expect(await store.get("github-delivery", "delivery-legacy")).toMatchObject({
      schemaVersion: 1,
    });
  });

  test("effects_startedは期限切れでもdelivery権を奪わない", async () => {
    const store = memoryStore();
    await store.set("github-delivery", "delivery-effects-started", {
      schemaVersion: 2,
      revision: 7,
      status: "effects_started",
      owner: "previous-worker",
      event: "issue_comment",
      expiresAt: new Date(0).toISOString(),
      effectsStartedAt: "2026-08-01T23:00:00.000Z",
    });
    let lifecycleCalls = 0;
    const lifecycle = {
      process: async () => {
        lifecycleCalls += 1;
        return 1;
      },
    } as unknown as LifecycleNotificationService;
    const processor = new GitHubWebhookProcessor(null, store, undefined, null, lifecycle);

    await processor.process({
      schemaVersion: 1,
      deliveryId: "delivery-effects-started",
      event: "issue_comment",
      payload: { action: "created" },
    });

    expect(lifecycleCalls).toBe(0);
    expect(await store.get("github-delivery", "delivery-effects-started")).toMatchObject({
      status: "effects_started",
      owner: "previous-worker",
      revision: 7,
    });
  });
});

function memoryStore(): StateStore {
  const values = new Map<string, unknown>();
  const storageKey = (namespace: string, key: string) => `${namespace}:${key}`;
  return {
    get: async <T>(namespace: string, key: string) =>
      (values.get(storageKey(namespace, key)) as T | undefined) ?? null,
    list: async <T>(namespace: string) =>
      [...values.entries()]
        .filter(([key]) => key.startsWith(`${namespace}:`))
        .map(([, value]) => value as T),
    listEntries: async <T>(namespace: string) =>
      [...values.entries()]
        .filter(([key]) => key.startsWith(`${namespace}:`))
        .map(([key, value]) => ({ key: key.slice(namespace.length + 1), value: value as T })),
    set: async (namespace: string, key: string, value: unknown) => {
      values.set(storageKey(namespace, key), value);
    },
    create: async (namespace: string, key: string, value: unknown) => {
      const resolved = storageKey(namespace, key);
      if (values.has(resolved)) return false;
      values.set(resolved, value);
      return true;
    },
    compareAndSet: async (
      namespace: string,
      key: string,
      expectedRevision: number,
      value: { revision: number },
    ) => {
      const resolved = storageKey(namespace, key);
      const current = values.get(resolved) as { revision?: number } | undefined;
      if (!current || current.revision !== expectedRevision) return false;
      values.set(resolved, value);
      return true;
    },
    remove: async (namespace: string, key: string) => {
      values.delete(storageKey(namespace, key));
    },
    append: async () => "event-1",
  };
}
