import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LifecycleNotification,
  LifecycleNotifier,
} from "../src/lifecycle-notification-service.ts";
import {
  NotificationOutboxService,
  type NotificationOutboxState,
  type NotificationPayload,
  type NotificationPayloadSender,
  notificationIntentId,
  OutboxLifecycleNotifier,
  OutboxWorkNotifier,
} from "../src/notification-outbox.ts";
import {
  LifecycleNotifierWithRequiredActionDm,
  RequiredActionDmService,
  WorkNotifierWithRequiredActionDm,
} from "../src/required-action-dm-service.ts";
import { LocalStateStore } from "../src/state-store.ts";
import type { HumanWorkItem } from "../src/types.ts";
import type { WorkNotifier } from "../src/work-notification-service.ts";

describe("RequiredActionDmService", () => {
  test("review依頼は既存thread通知の後、実行者を除いた対処者へ一度ずつDMする", async () => {
    const order: string[] = [];
    const directRecipients: string[] = [];
    const primary = lifecycleNotifier(async () => {
      order.push("channel");
      return { messageTs: "100.1" };
    });
    const direct = new RequiredActionDmService((slackUserId) => ({
      lifecycle: lifecycleNotifier(async (value, threadTs, metadata) => {
        order.push("dm");
        directRecipients.push(slackUserId);
        expect(value.slackUserIds).toEqual([slackUserId]);
        expect(threadTs).toBeNull();
        expect(metadata?.intentId).toMatch(/^notification-[a-f0-9]{64}$/);
        return { messageTs: "200.1" };
      }),
      work: workNotifier(),
    }));
    const notifier = new LifecycleNotifierWithRequiredActionDm(primary, direct);

    await notifier.notify(
      notification("review-requested", ["UACTOR", "UREVIEWER", "UREVIEWER"]),
      "90.1",
      {
        intentId: "notification-channel",
        sourceDeliveryId: "delivery-1",
        requiredAction: {
          kind: "review-requested",
          recipientSlackUserIds: ["UACTOR", "UREVIEWER", "UREVIEWER"],
          actorSlackUserId: "UACTOR",
        },
      },
    );

    expect(order).toEqual(["channel", "dm"]);
    expect(directRecipients).toEqual(["UREVIEWER"]);
  });

  test.each(["review-requested", "approval-wait", "ci-failed"] as const)(
    "%sをDM対象にする",
    async (kind) => {
      const recipients: string[] = [];
      const service = new RequiredActionDmService((slackUserId) => ({
        lifecycle: lifecycleNotifier(async () => {
          recipients.push(slackUserId);
          return { messageTs: "210.1" };
        }),
        work: workNotifier(),
      }));

      expect(
        await service.notifyLifecycle(
          notification(kind === "review-requested" ? kind : "ci-failed", ["URESPONDER"]),
          {
            intentId: `notification-channel-${kind}`,
            requiredAction: {
              kind,
              recipientSlackUserIds: ["URESPONDER"],
              actorSlackUserId: "UACTOR",
            },
          },
        ),
      ).toBe(1);
      expect(recipients).toEqual(["URESPONDER"]);
    },
  );

  test("情報通知と自己操作はDMしない", async () => {
    let directCount = 0;
    const service = new RequiredActionDmService(() => ({
      lifecycle: lifecycleNotifier(async () => {
        directCount += 1;
        return { messageTs: "220.1" };
      }),
      work: workNotifier(),
    }));

    expect(
      await service.notifyLifecycle(notification("comment-created", ["UOTHER"]), {
        intentId: "notification-channel-comment",
      }),
    ).toBe(0);
    expect(
      await service.notifyLifecycle(notification("ci-failed", ["UACTOR"]), {
        intentId: "notification-channel-self",
        requiredAction: {
          kind: "ci-failed",
          recipientSlackUserIds: ["UACTOR"],
          actorSlackUserId: "UACTOR",
        },
      }),
    ).toBe(0);
    expect(directCount).toBe(0);
  });

  test.each([
    ["BLOCKED", "blocker"],
    ["OVERDUE", "overdue"],
  ] as const)("%sは現在のownerへDMし、既存thread通知を維持する", async (reasonCode, kind) => {
    const order: string[] = [];
    const primary = workNotifier(async () => {
      order.push("channel");
      return { messageTs: "300.1" };
    });
    const direct = new RequiredActionDmService((slackUserId) => ({
      lifecycle: lifecycleNotifier(),
      work: workNotifier(async (_item, context) => {
        order.push(`dm:${slackUserId}`);
        expect(context.threadTs).toBeNull();
        return { messageTs: "310.1" };
      }),
    }));
    const notifier = new WorkNotifierWithRequiredActionDm(primary, direct);

    await notifier.notify(
      item(reasonCode),
      {
        kind: "state",
        threadTs: "290.1",
        slackUserId: "UOWNER",
        actorSlackUserId: "UACTOR",
      },
      {
        intentId: `notification-channel-${reasonCode}`,
        requiredAction: {
          kind,
          recipientSlackUserIds: ["UOWNER"],
          actorSlackUserId: "UACTOR",
        },
      },
    );

    expect(order).toEqual(["channel", "dm:UOWNER"]);
  });

  test("同じeventとrecipientのDM intentはoutboxで一件にする", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-required-dm-")));
    const sent: NotificationPayload[] = [];
    const sender: NotificationPayloadSender = {
      send: async (payload) => {
        sent.push(payload);
        return { messageTs: `400.${sent.length}` };
      },
    };
    const direct = new RequiredActionDmService((slackUserId) => {
      const outbox = new NotificationOutboxService(store, sender, { channelId: slackUserId });
      const delivery = { kind: "direct" as const, slackUserId };
      return {
        lifecycle: new OutboxLifecycleNotifier(outbox, delivery),
        work: new OutboxWorkNotifier(outbox, delivery),
      };
    });
    const value = notification("ci-failed", ["UOWNER"]);
    const metadata = {
      intentId: "notification-channel-ci",
      sourceDeliveryId: "delivery-ci",
      requiredAction: {
        kind: "ci-failed" as const,
        recipientSlackUserIds: ["UOWNER"],
        actorSlackUserId: "UACTOR",
      },
    };

    expect(await direct.notifyLifecycle(value, metadata)).toBe(1);
    expect(await direct.notifyLifecycle(value, metadata)).toBe(1);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: "lifecycle",
      delivery: { kind: "direct", slackUserId: "UOWNER" },
      threadTs: null,
      metadata: { sourceDeliveryId: "delivery-ci" },
    });
  });

  test("同じeventとrecipientを並列処理してもDM送信は一度だけ", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-required-parallel-")));
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sends = 0;
    const sender: NotificationPayloadSender = {
      send: async () => {
        sends += 1;
        entered();
        await gate;
        return { messageTs: "450.1" };
      },
    };
    const direct = new RequiredActionDmService(
      (slackUserId) => {
        const outbox = new NotificationOutboxService(store, sender, { channelId: slackUserId });
        return {
          lifecycle: new OutboxLifecycleNotifier(outbox, { kind: "direct", slackUserId }),
          work: new OutboxWorkNotifier(outbox, { kind: "direct", slackUserId }),
        };
      },
      () => {},
    );
    const metadata = {
      intentId: "notification-channel-parallel",
      requiredAction: {
        kind: "ci-failed" as const,
        recipientSlackUserIds: ["UOWNER"],
        actorSlackUserId: "UACTOR",
      },
    };

    const first = direct.notifyLifecycle(notification("ci-failed", ["UOWNER"]), metadata);
    await started;
    await expect(
      direct.notifyLifecycle(notification("ci-failed", ["UOWNER"]), metadata),
    ).resolves.toBe(0);
    release();
    await expect(first).resolves.toBe(1);
    expect(sends).toBe(1);
  });

  test("DM timeoutでもprimary outboxをsentに保ち、DM childだけneeds_reviewにする", async () => {
    const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-required-timeout-")));
    let channelSends = 0;
    let directSends = 0;
    const sender: NotificationPayloadSender = {
      send: async (payload) => {
        if (payload.kind === "lifecycle" && payload.delivery?.kind === "direct") {
          directSends += 1;
          throw new Error("dm network timeout");
        }
        channelSends += 1;
        return { messageTs: "480.1" };
      },
    };
    const primaryOutbox = new NotificationOutboxService(store, sender, { channelId: "CWORK" });
    const direct = new RequiredActionDmService(
      (slackUserId) => {
        const outbox = new NotificationOutboxService(store, sender, { channelId: slackUserId });
        return {
          lifecycle: new OutboxLifecycleNotifier(outbox, { kind: "direct", slackUserId }),
          work: new OutboxWorkNotifier(outbox, { kind: "direct", slackUserId }),
        };
      },
      () => {},
    );
    const notifier = new LifecycleNotifierWithRequiredActionDm(
      new OutboxLifecycleNotifier(primaryOutbox),
      direct,
    );

    await expect(
      notifier.notify(notification("ci-failed", ["UOWNER"]), "470.1", {
        intentId: notificationIntentId({ test: "channel-timeout" }),
        sourceDeliveryId: "delivery-timeout",
        requiredAction: {
          kind: "ci-failed",
          recipientSlackUserIds: ["UOWNER"],
          actorSlackUserId: "UACTOR",
        },
      }),
    ).resolves.toEqual({ messageTs: "480.1" });

    const states = await store.list<NotificationOutboxState>("notification-outbox");
    expect(channelSends).toBe(1);
    expect(directSends).toBe(1);
    expect(states.find((state) => state.channelId === "CWORK")).toMatchObject({
      status: "sent",
      messageTs: "480.1",
    });
    expect(states.find((state) => state.channelId === "UOWNER")).toMatchObject({
      status: "needs_review",
      failure: "Error",
      payload: { delivery: { kind: "direct", slackUserId: "UOWNER" } },
    });
  });

  test("DM障害時も先に送った既存thread通知を取り消さない", async () => {
    let primaryCount = 0;
    const primary = lifecycleNotifier(async () => {
      primaryCount += 1;
      return { messageTs: "500.1" };
    });
    const failures: string[] = [];
    const direct = new RequiredActionDmService(
      () => ({
        lifecycle: lifecycleNotifier(async () => {
          throw new Error("dm unavailable");
        }),
        work: workNotifier(),
      }),
      ({ slackUserId }) => failures.push(slackUserId),
    );
    const notifier = new LifecycleNotifierWithRequiredActionDm(primary, direct);

    await expect(
      notifier.notify(notification("ci-failed", ["UOWNER"]), "490.1", {
        intentId: "notification-channel-failure",
        requiredAction: {
          kind: "ci-failed",
          recipientSlackUserIds: ["UOWNER"],
          actorSlackUserId: "UACTOR",
        },
      }),
    ).resolves.toEqual({ messageTs: "500.1" });
    expect(primaryCount).toBe(1);
    expect(failures).toEqual(["UOWNER"]);
  });
});

function notification(
  kind: LifecycleNotification["kind"],
  slackUserIds: string[],
): LifecycleNotification {
  return {
    schemaVersion: 1,
    kind,
    resource: {
      kind: "issue",
      number: 161,
      title: "対応必須通知をDMする",
      url: "https://github.com/art-tra2021/arttra-git-workflow/issues/161",
    },
    pullRequest: {
      number: 162,
      title: "DM通知を追加",
      url: "https://github.com/art-tra2021/arttra-git-workflow/pull/162",
    },
    actorLogin: "actor",
    actorSlackUserId: "UACTOR",
    slackUserIds,
    issueType: "task",
    summary: "対応が必要です。",
    detail: "CIが失敗しました。",
    nextAction: "内容を確認する",
    actionUrl: "https://github.com/art-tra2021/arttra-git-workflow/pull/162",
  };
}

function item(reasonCode: HumanWorkItem["reasonCode"]): HumanWorkItem {
  return {
    schemaVersion: 1,
    repository: "art-tra2021/arttra-git-workflow",
    issueNumber: 161,
    title: "対応必須通知をDMする",
    url: "https://github.com/art-tra2021/arttra-git-workflow/issues/161",
    status: reasonCode === "BLOCKED" ? "blocked" : "in-progress",
    priority: "P1",
    owner: "owner",
    targetDate: "2026-08-05",
    delivery: "immediate",
    reasonCode,
    nextActor: "owner",
    nextAction: "内容を確認する",
    reason: "対応が必要です。",
    actions: ["open-github"],
  };
}

function lifecycleNotifier(
  notify: LifecycleNotifier["notify"] = async () => ({ messageTs: "1.1" }),
): LifecycleNotifier {
  return { notify };
}

function workNotifier(
  notify: WorkNotifier["notify"] = async () => ({ messageTs: "1.2" }),
): WorkNotifier {
  return { notify, digest: async () => {} };
}
