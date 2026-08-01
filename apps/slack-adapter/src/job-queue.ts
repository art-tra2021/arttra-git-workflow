import { createHmac, timingSafeEqual } from "node:crypto";
import { CloudTasksClient, protos } from "@google-cloud/tasks";

export interface GitHubWebhookJob {
  schemaVersion: 1;
  deliveryId: string;
  event: string;
  payload: unknown;
}

export interface GitHubJobQueue {
  enqueue(job: GitHubWebhookJob): Promise<boolean>;
}

interface CloudTasksQueueConfig {
  projectId: string;
  location: string;
  queue: string;
  publicBaseUrl: string;
  jobSecret: string;
  serviceAccountEmail?: string;
  client?: CloudTasksClient;
}

export class CloudTasksGitHubJobQueue implements GitHubJobQueue {
  private readonly client: CloudTasksClient;
  private readonly config: CloudTasksQueueConfig;

  constructor(config: CloudTasksQueueConfig) {
    this.config = config;
    this.client = config.client ?? new CloudTasksClient();
  }

  async enqueue(job: GitHubWebhookJob): Promise<boolean> {
    const body = JSON.stringify(job);
    const task = {
      name: this.client.taskPath(
        this.config.projectId,
        this.config.location,
        this.config.queue,
        safeTaskId(job.deliveryId),
      ),
      httpRequest: {
        httpMethod: protos.google.cloud.tasks.v2.HttpMethod.POST,
        url: `${this.config.publicBaseUrl.replace(/\/$/, "")}/internal/github-events`,
        headers: {
          "Content-Type": "application/json",
          "X-Ar-Job-Signature": signJob(body, this.config.jobSecret),
        },
        body: Buffer.from(body).toString("base64"),
        ...(this.config.serviceAccountEmail
          ? {
              oidcToken: {
                serviceAccountEmail: this.config.serviceAccountEmail,
                audience: this.config.publicBaseUrl,
              },
            }
          : {}),
      },
    };
    try {
      await this.client.createTask({
        parent: this.client.queuePath(
          this.config.projectId,
          this.config.location,
          this.config.queue,
        ),
        task,
      });
      return true;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === 6 || code === "already-exists") {
        return false;
      }
      throw error;
    }
  }
}

export class LocalGitHubJobQueue implements GitHubJobQueue {
  private readonly handler: (job: GitHubWebhookJob) => Promise<void>;

  constructor(handler: (job: GitHubWebhookJob) => Promise<void>) {
    this.handler = handler;
  }

  async enqueue(job: GitHubWebhookJob): Promise<boolean> {
    setImmediate(() => {
      this.handler(job).catch((error) => {
        console.error(
          error instanceof Error ? error.message : "GitHub webhook jobに失敗しました。",
        );
      });
    });
    return true;
  }
}

export function signJob(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifyJobSignature(body: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(signJob(body, secret));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function safeTaskId(deliveryId: string): string {
  const id = deliveryId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 500);
  if (!id) {
    throw new Error("GitHub delivery IDが不正です。");
  }
  return `github-${id}`;
}
