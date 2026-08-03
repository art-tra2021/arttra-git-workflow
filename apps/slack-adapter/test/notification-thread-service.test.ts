import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotificationThreadService } from "../src/notification-thread-service.ts";
import { RetryableWorkError } from "../src/retryable-error.ts";
import { LocalStateStore } from "../src/state-store.ts";

describe("NotificationThreadService", () => {
  test("並行するinstanceのうち一つだけがrootを作り、retry後のreplyも同じthreadへ送る", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arttra-notification-thread-"));
    const first = new NotificationThreadService(new LocalStateStore(directory));
    const second = new NotificationThreadService(new LocalStateStore(directory));
    const resourceUrl = "https://github.example/example/repo/issues/44";
    const replies: string[] = [];
    let rootCreations = 0;
    let releaseRoot = () => {};
    const rootReleased = new Promise<void>((resolve) => {
      releaseRoot = resolve;
    });
    let rootClaimed = () => {};
    const claimed = new Promise<void>((resolve) => {
      rootClaimed = resolve;
    });

    const firstPublish = first.publishReply(
      resourceUrl,
      async () => {
        rootCreations += 1;
        rootClaimed();
        await rootReleased;
        return { messageTs: "100.1" };
      },
      async (threadTs) => {
        replies.push(threadTs);
        return { messageTs: "100.2" };
      },
    );
    await claimed;

    const competingPublish = second.publishReply(
      resourceUrl,
      async () => {
        rootCreations += 1;
        return { messageTs: "200.1" };
      },
      async (threadTs) => {
        replies.push(threadTs);
        return { messageTs: "200.2" };
      },
    );
    await expect(competingPublish).rejects.toMatchObject({
      name: "RetryableWorkError",
      code: "notification_thread_root_in_progress",
    });
    expect(rootCreations).toBe(1);
    expect(replies).toEqual([]);

    releaseRoot();
    await firstPublish;
    await second.publishReply(
      resourceUrl,
      async () => {
        throw new Error("readyなrootを再作成してはいけません。");
      },
      async (threadTs) => {
        replies.push(threadTs);
        return { messageTs: "100.3" };
      },
    );

    expect(rootCreations).toBe(1);
    expect(replies).toEqual(["100.1", "100.1"]);
  });

  test("root作成lease中はreplyを平投稿せずRetryableWorkErrorを返す", async () => {
    const store = new LocalStateStore(
      await mkdtemp(join(tmpdir(), "arttra-notification-thread-lease-")),
    );
    const first = new NotificationThreadService(store);
    const second = new NotificationThreadService(store);
    const resourceUrl = "https://github.example/example/repo/issues/45";
    let releaseRoot = () => {};
    const rootReleased = new Promise<void>((resolve) => {
      releaseRoot = resolve;
    });
    let rootClaimed = () => {};
    const claimed = new Promise<void>((resolve) => {
      rootClaimed = resolve;
    });
    const firstRoot = first.ensureRoot(resourceUrl, async () => {
      rootClaimed();
      await rootReleased;
      return { messageTs: "300.1" };
    });
    await claimed;
    let replyCalls = 0;

    const error = await second
      .publishReply(
        resourceUrl,
        async () => ({ messageTs: "400.1" }),
        async () => {
          replyCalls += 1;
          return { messageTs: "400.2" };
        },
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RetryableWorkError);
    expect((error as RetryableWorkError).code).toBe("notification_thread_root_in_progress");
    expect(replyCalls).toBe(0);
    releaseRoot();
    expect(await firstRoot).toBe("300.1");
  });
});
