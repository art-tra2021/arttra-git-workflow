import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DelegatingNotificationPayloadSender,
  type NotificationIntent,
  NotificationOutboxService,
  type NotificationOutboxState,
  type NotificationPayloadSender,
  notificationIntentId,
} from "../src/notification-outbox.ts";
import {
  type SlackConversationClient,
  SlackNotificationReconciler,
} from "../src/slack-notification-reconciler.ts";
import { LocalStateStore } from "../src/state-store.ts";

describe("NotificationOutboxService", () => {
  test("direct payloadはrecipient別senderへ委譲し、channel senderへ送らない", async () => {
    let channelSends = 0;
    const directRecipients: string[] = [];
    const sender = new DelegatingNotificationPayloadSender(
      {
        notify: async () => {
          channelSends += 1;
          return { messageTs: "channel" };
        },
      },
      {
        notify: async () => {
          channelSends += 1;
          return { messageTs: "channel" };
        },
        digest: async () => {
          channelSends += 1;
        },
      },
      (slackUserId) => ({
        lifecycle: {
          notify: async () => {
            directRecipients.push(slackUserId);
            return { messageTs: "direct" };
          },
        },
        work: {
          notify: async () => ({ messageTs: "unused" }),
          digest: async () => {},
        },
      }),
    );

    await expect(sender.send(directIntent("delegate-direct").payload)).resolves.toEqual({
      messageTs: "direct",
    });
    expect(channelSends).toBe(0);
    expect(directRecipients).toEqual(["UOWNER"]);
  });

  test("送信済みの旧Task平投稿はthreadTsだけの移行なら再投稿せず既送信として扱う", async () => {
    const store = await localStore("flat-task-migration");
    let sends = 0;
    const service = outbox(store, {
      send: async () => {
        sends += 1;
        return { messageTs: "119.1" };
      },
    });
    const flat = taskOpenedIntent("flat-task-migration", null, "delivery-legacy");
    const threaded = taskOpenedIntent("flat-task-migration", "95.1", "delivery-current");

    await expect(service.deliver(flat)).resolves.toEqual({ messageTs: "119.1" });
    await expect(service.deliver(threaded)).resolves.toEqual({ messageTs: "119.1" });
    await expect(service.deliver(threaded)).resolves.toEqual({ messageTs: "119.1" });

    expect(sends).toBe(1);
    expect(await service.get(flat.metadata.intentId)).toMatchObject({
      status: "sent",
      revision: 3,
      messageTs: "119.1",
      sourceDeliveryId: "delivery-legacy",
      payload: { kind: "lifecycle", threadTs: null },
    });
  });

  test("旧Task平投稿以外のpayload差分は引き続きfail-closedにする", async () => {
    const store = await localStore("flat-task-collision");
    const service = outbox(store, {
      send: async () => ({ messageTs: "119.2" }),
    });
    const flat = taskOpenedIntent("flat-task-collision", null, "delivery-legacy");
    await service.deliver(flat);

    const changed = taskOpenedIntent("flat-task-collision", "95.2", "delivery-current");
    if (changed.payload.kind !== "lifecycle") throw new Error("lifecycle intentではありません。");
    changed.payload.notification.detail = "thread以外も変更";
    await expect(service.deliver(changed)).rejects.toMatchObject({
      code: "notification_intent_collision",
    });

    const nonTask = intent("non-task-thread-change");
    await service.deliver(nonTask);
    if (nonTask.payload.kind !== "lifecycle") throw new Error("lifecycle intentではありません。");
    const threadedNonTask: NotificationIntent = {
      metadata: { ...nonTask.metadata, sourceDeliveryId: "delivery-current" },
      payload: {
        ...nonTask.payload,
        threadTs: "95.3",
        metadata: { ...nonTask.metadata, sourceDeliveryId: "delivery-current" },
      },
    };
    await expect(service.deliver(threadedNonTask)).rejects.toMatchObject({
      code: "notification_intent_collision",
    });
  });

  test("同じintentの並列workerはSlack送信を一度だけ実行する", async () => {
    const store = await localStore("parallel");
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sends = 0;
    const service = outbox(store, {
      send: async () => {
        sends += 1;
        entered();
        await gate;
        return { messageTs: "100.1" };
      },
    });
    const value = intent("parallel");

    const first = service.deliver(value);
    await started;
    await expect(service.deliver(value)).rejects.toMatchObject({
      code: "notification_intent_in_progress",
    });
    release();
    await expect(first).resolves.toEqual({ messageTs: "100.1" });
    await expect(service.deliver(value)).resolves.toEqual({ messageTs: "100.1" });

    expect(sends).toBe(1);
    expect(await service.get(value.metadata.intentId)).toMatchObject({
      status: "sent",
      revision: 3,
      attemptCount: 1,
      messageTs: "100.1",
    });
  });

  test("不確実な失敗を要確認、送信前と判断できるSlack拒否を失敗として残す", async () => {
    const uncertainStore = await localStore("uncertain");
    const uncertain = outbox(uncertainStore, {
      send: async () => {
        throw new Error("network timeout");
      },
    });
    const uncertainIntent = intent("uncertain");
    await expect(uncertain.deliver(uncertainIntent)).rejects.toThrow("network timeout");
    expect(await uncertain.get(uncertainIntent.metadata.intentId)).toMatchObject({
      status: "needs_review",
      failure: "Error",
    });

    const failedStore = await localStore("failed");
    const failed = outbox(failedStore, {
      send: async () => {
        throw { data: { error: "channel_not_found" } };
      },
    });
    const failedIntent = intent("failed");
    await expect(failed.deliver(failedIntent)).rejects.toEqual({
      data: { error: "channel_not_found" },
    });
    expect(await failed.get(failedIntent.metadata.intentId)).toMatchObject({
      status: "failed",
      failure: "channel_not_found",
    });
  });

  test("dry-runは照合だけを行い、確認付きreplayだけが再送と監査記録を行う", async () => {
    const store = await localStore("replay");
    let sends = 0;
    let reconciliations = 0;
    const service = outbox(
      store,
      {
        send: async () => {
          sends += 1;
          if (sends === 1) throw new Error("timeout");
          return { messageTs: "200.2" };
        },
      },
      {
        reconcile: async (state) => {
          reconciliations += 1;
          return {
            schemaVersion: 1,
            method: "slack-conversations-api",
            outcome: "message_not_found",
            checkedAt: "2026-08-03T00:05:00.000Z",
            channelId: state.channelId,
            scannedMessages: 12,
            complete: true,
            reason: "該当メッセージなし",
          };
        },
      },
    );
    const value = intent("replay");
    await expect(service.deliver(value)).rejects.toThrow("timeout");
    const failed = await requireState(service, value.metadata.intentId);

    const dryRun = await service.replay({
      schemaVersion: 1,
      intentId: value.metadata.intentId,
      expectedRevision: failed.revision,
      operatorId: "UADMIN",
      dryRun: true,
      confirmed: false,
    });
    expect(dryRun).toMatchObject({
      action: "replay",
      executed: false,
      beforeRevision: failed.revision,
      afterRevision: failed.revision,
    });
    expect(sends).toBe(1);
    expect((await requireState(service, value.metadata.intentId)).revision).toBe(failed.revision);

    const replayed = await service.replay({
      schemaVersion: 1,
      intentId: value.metadata.intentId,
      expectedRevision: failed.revision,
      operatorId: "UADMIN",
      dryRun: false,
      confirmed: true,
    });
    expect(replayed).toMatchObject({
      action: "replay",
      executed: true,
      status: "sent",
      messageTs: "200.2",
    });
    expect(sends).toBe(2);
    expect(reconciliations).toBe(2);
    expect(await store.list("notification-outbox-audit")).toHaveLength(3);
  });

  test("既存Slackメッセージを照合した場合は再送せず送信済みに直す", async () => {
    const store = await localStore("existing");
    let sends = 0;
    const service = outbox(
      store,
      {
        send: async () => {
          sends += 1;
          throw new Error("timeout");
        },
      },
      {
        reconcile: async (state) => ({
          schemaVersion: 1,
          method: "slack-conversations-api",
          outcome: "message_found",
          checkedAt: "2026-08-03T00:05:00.000Z",
          channelId: state.channelId,
          scannedMessages: 3,
          complete: true,
          messageTs: "300.3",
          reason: "既存メッセージあり",
        }),
      },
    );
    const value = intent("existing");
    await expect(service.deliver(value)).rejects.toThrow("timeout");
    const failed = await requireState(service, value.metadata.intentId);

    const result = await service.replay({
      schemaVersion: 1,
      intentId: value.metadata.intentId,
      expectedRevision: failed.revision,
      operatorId: "UADMIN",
      dryRun: false,
      confirmed: true,
    });

    expect(result).toMatchObject({
      action: "record_existing",
      executed: true,
      status: "sent",
      messageTs: "300.3",
    });
    expect(sends).toBe(1);
  });

  test("未許可operatorと不完全なSlack照合ではreplayしない", async () => {
    const store = await localStore("blocked");
    let reconciliations = 0;
    const service = outbox(
      store,
      {
        send: async () => {
          throw new Error("timeout");
        },
      },
      {
        reconcile: async (state) => {
          reconciliations += 1;
          return {
            schemaVersion: 1,
            method: "slack-conversations-api",
            outcome: "inconclusive",
            checkedAt: "2026-08-03T00:05:00.000Z",
            channelId: state.channelId,
            scannedMessages: 2_000,
            complete: false,
            reason: "全ページを確認できない",
          };
        },
      },
    );
    const value = intent("blocked");
    await expect(service.deliver(value)).rejects.toThrow("timeout");
    const failed = await requireState(service, value.metadata.intentId);

    await expect(
      service.replay({
        schemaVersion: 1,
        intentId: value.metadata.intentId,
        expectedRevision: failed.revision,
        operatorId: "UNAUTHORIZED",
        dryRun: true,
        confirmed: false,
      }),
    ).rejects.toMatchObject({ code: "notification_replay_forbidden" });
    expect(reconciliations).toBe(0);

    await expect(
      service.replay({
        schemaVersion: 1,
        intentId: value.metadata.intentId,
        expectedRevision: failed.revision,
        operatorId: "UADMIN",
        dryRun: true,
        confirmed: false,
      }),
    ).resolves.toMatchObject({ action: "blocked", executed: false });
    expect(reconciliations).toBe(1);
  });

  test("AI向け監査JSONに要確認intentと旧effects_started deliveryを分けて返す", async () => {
    const store = await localStore("audit");
    const service = outbox(store, {
      send: async () => {
        throw new Error("timeout");
      },
    });
    const value = intent("audit");
    await expect(service.deliver(value)).rejects.toThrow("timeout");
    await store.set("github-delivery", "legacy-delivery", {
      schemaVersion: 2,
      revision: 7,
      status: "effects_started",
      effectsStartedAt: "2026-08-02T00:00:00.000Z",
    });

    expect(await service.audit()).toMatchObject({
      schemaVersion: 1,
      summary: { actionable: 1, notificationIntents: 1, legacyDeliveries: 1 },
      items: [
        expect.objectContaining({
          kind: "legacy-github-delivery",
          id: "legacy-delivery",
          replayEligible: false,
        }),
        expect.objectContaining({
          kind: "notification-intent",
          id: value.metadata.intentId,
          replayEligible: true,
          replayCommand: {
            schemaVersion: 1,
            intentId: value.metadata.intentId,
            expectedRevision: 3,
            operatorId: null,
            dryRun: true,
            confirmed: false,
          },
        }),
      ],
    });
  });

  test("DM履歴にintentがあればrecord_existingで復旧し、再送しない", async () => {
    const store = await localStore("direct-record-existing");
    const value = directIntent("direct-record-existing");
    let sends = 0;
    const client: SlackConversationClient = {
      conversations: {
        open: async () => ({ channel: { id: "DDIRECT" } }),
        history: async () => ({
          messages: [
            {
              ts: "390.1",
              metadata: {
                event_type: "arttra_notification",
                event_payload: { intent_id: value.metadata.intentId },
              },
            },
          ],
        }),
        replies: async () => ({ messages: [] }),
      },
    };
    const service = new NotificationOutboxService(
      store,
      {
        send: async () => {
          sends += 1;
          throw new Error("timeout after Slack accepted the DM");
        },
      },
      {
        channelId: "UOWNER",
        replayOperatorIds: ["UADMIN"],
        reconciler: new SlackNotificationReconciler(client, store),
      },
    );

    await expect(service.deliver(value)).rejects.toThrow("timeout after Slack accepted");
    const failed = await requireState(service, value.metadata.intentId);
    await expect(
      service.replay({
        schemaVersion: 1,
        intentId: value.metadata.intentId,
        expectedRevision: failed.revision,
        operatorId: "UADMIN",
        dryRun: false,
        confirmed: true,
      }),
    ).resolves.toMatchObject({
      action: "record_existing",
      executed: true,
      status: "sent",
      messageTs: "390.1",
    });
    expect(sends).toBe(1);
  });

  test("DM履歴にintentがなければ確認付きreplayはDMだけを再送する", async () => {
    const store = await localStore("direct-replay-only");
    let channelSends = 0;
    let directSends = 0;
    const sender: NotificationPayloadSender = {
      send: async (payload) => {
        if (payload.kind === "lifecycle" && payload.delivery?.kind === "direct") {
          directSends += 1;
          if (directSends === 1) throw new Error("dm timeout");
          return { messageTs: "395.2" };
        }
        channelSends += 1;
        return { messageTs: "395.1" };
      },
    };
    const primary = new NotificationOutboxService(store, sender, { channelId: "CWORK" });
    await primary.deliver(intent("direct-replay-primary"));
    const client: SlackConversationClient = {
      conversations: {
        open: async () => ({ channel: { id: "DDIRECT" } }),
        history: async () => ({ messages: [] }),
        replies: async () => ({ messages: [] }),
      },
    };
    const direct = new NotificationOutboxService(store, sender, {
      channelId: "UOWNER",
      replayOperatorIds: ["UADMIN"],
      reconciler: new SlackNotificationReconciler(client, store),
    });
    const value = directIntent("direct-replay-only");
    await expect(direct.deliver(value)).rejects.toThrow("dm timeout");
    const failed = await requireState(direct, value.metadata.intentId);

    await expect(
      direct.replay({
        schemaVersion: 1,
        intentId: value.metadata.intentId,
        expectedRevision: failed.revision,
        operatorId: "UADMIN",
        dryRun: false,
        confirmed: true,
      }),
    ).resolves.toMatchObject({ action: "replay", executed: true, status: "sent" });
    expect(channelSends).toBe(1);
    expect(directSends).toBe(2);
  });
});

describe("SlackNotificationReconciler", () => {
  test("Slack message metadataのintent IDを照合する", async () => {
    const store = await localStore("reconcile-found");
    const value = intent("reconcile-found");
    const state = sendingState(value, "2026-08-03T00:00:00.000Z");
    const client: SlackConversationClient = {
      conversations: {
        history: async () => ({
          messages: [
            {
              ts: "400.4",
              metadata: {
                event_type: "arttra_notification",
                event_payload: { intent_id: value.metadata.intentId },
              },
            },
          ],
        }),
        replies: async () => ({ messages: [] }),
      },
    };

    await expect(
      new SlackNotificationReconciler(client, store, () =>
        Date.parse("2026-08-03T01:00:00.000Z"),
      ).reconcile(state),
    ).resolves.toMatchObject({
      outcome: "message_found",
      complete: true,
      messageTs: "400.4",
      scannedMessages: 1,
    });
  });

  test("Slack APIを上限まで読み切れない場合は不在と断定しない", async () => {
    const store = await localStore("reconcile-incomplete");
    const state = sendingState(intent("reconcile-incomplete"), "2026-08-03T00:00:00.000Z");
    let calls = 0;
    const client: SlackConversationClient = {
      conversations: {
        history: async () => {
          calls += 1;
          return {
            messages: [],
            has_more: true,
            response_metadata: { next_cursor: `page-${calls}` },
          };
        },
        replies: async () => ({ messages: [] }),
      },
    };

    await expect(
      new SlackNotificationReconciler(client, store).reconcile(state),
    ).resolves.toMatchObject({ outcome: "inconclusive", complete: false });
    expect(calls).toBe(10);
  });

  test("DM intentはIssue root stateがあってもDM履歴だけを照合する", async () => {
    const store = await localStore("reconcile-direct");
    const value = intent("reconcile-direct");
    if (value.payload.kind !== "lifecycle") throw new Error("lifecycle intentではありません。");
    value.payload.delivery = { kind: "direct", slackUserId: "UOWNER" };
    await store.set("work-thread", value.payload.notification.resource.url, {
      schemaVersion: 1,
      issueUrl: value.payload.notification.resource.url,
      rootTs: "500.1",
      createdAt: "2026-08-03T00:00:00.000Z",
    });
    const state = {
      ...sendingState(value, "2026-08-03T00:00:00.000Z"),
      channelId: "UOWNER",
    };
    let historyCalls = 0;
    let replyCalls = 0;
    const client: SlackConversationClient = {
      conversations: {
        open: async () => ({ channel: { id: "DDIRECT" } }),
        history: async () => {
          historyCalls += 1;
          return { messages: [] };
        },
        replies: async () => {
          replyCalls += 1;
          return { messages: [] };
        },
      },
    };

    await expect(
      new SlackNotificationReconciler(client, store).reconcile(state),
    ).resolves.toMatchObject({
      outcome: "message_not_found",
      complete: true,
      channelId: "DDIRECT",
    });
    expect(historyCalls).toBe(1);
    expect(replyCalls).toBe(0);
  });
});

async function localStore(name: string): Promise<LocalStateStore> {
  return new LocalStateStore(await mkdtemp(join(tmpdir(), `arttra-outbox-${name}-`)));
}

function outbox(
  store: LocalStateStore,
  sender: NotificationPayloadSender,
  reconciler?: ConstructorParameters<typeof NotificationOutboxService>[2]["reconciler"],
): NotificationOutboxService {
  return new NotificationOutboxService(store, sender, {
    channelId: "CWORK",
    replayOperatorIds: ["UADMIN"],
    ...(reconciler ? { reconciler } : {}),
    now: () => Date.parse("2026-08-03T00:05:00.000Z"),
    owner: () => "worker-1",
    staleMilliseconds: 60_000,
  });
}

function intent(name: string): NotificationIntent {
  const metadata = {
    intentId: notificationIntentId({ test: name }),
    sourceDeliveryId: `delivery-${name}`,
  };
  return {
    metadata,
    payload: {
      schemaVersion: 1,
      kind: "lifecycle",
      notification: {
        schemaVersion: 1,
        kind: "comment-created",
        resource: {
          kind: "issue",
          number: 54,
          title: "通知outbox",
          url: "https://github.example/example/repo/issues/54",
        },
        pullRequest: null,
        actorLogin: "alice",
        actorSlackUserId: "UALICE",
        slackUserIds: ["UALICE"],
        issueType: "work",
        summary: "コメントが追加されました。",
        detail: name,
        nextAction: "内容を確認する",
        actionUrl: "https://github.example/example/repo/issues/54#issuecomment-1",
      },
      threadTs: null,
      metadata,
    },
  };
}

function directIntent(name: string): NotificationIntent {
  const value = intent(name);
  if (value.payload.kind !== "lifecycle") throw new Error("lifecycle intentではありません。");
  value.payload.delivery = { kind: "direct", slackUserId: "UOWNER" };
  return value;
}

function taskOpenedIntent(
  name: string,
  threadTs: string | null,
  sourceDeliveryId: string,
): NotificationIntent {
  const metadata = {
    intentId: notificationIntentId({ test: name }),
    sourceDeliveryId,
  };
  return {
    metadata,
    payload: {
      schemaVersion: 1,
      kind: "lifecycle",
      notification: {
        schemaVersion: 1,
        kind: "issue-opened",
        resource: {
          kind: "issue",
          number: 102,
          title: "旧Task通知",
          url: "https://github.example/example/repo/issues/102",
        },
        pullRequest: null,
        actorLogin: "requester",
        actorSlackUserId: null,
        slackUserIds: ["UOWNER"],
        issueType: "task",
        summary: "Taskが作成されました。",
        detail: "移行前後で同じ内容",
        nextAction: "内容を確認する",
        actionUrl: "https://github.example/example/repo/issues/102",
        selfMergeControl: null,
      },
      threadTs,
      metadata,
    },
  };
}

function sendingState(value: NotificationIntent, updatedAt: string): NotificationOutboxState {
  return {
    schemaVersion: 1,
    revision: 2,
    intentId: value.metadata.intentId,
    status: "sending",
    channelId: "CWORK",
    sourceDeliveryId: value.metadata.sourceDeliveryId ?? null,
    payloadHash: "hash",
    payload: value.payload,
    owner: "worker-1",
    attemptCount: 1,
    replayCount: 0,
    createdAt: updatedAt,
    updatedAt,
    sendingStartedAt: updatedAt,
  };
}

async function requireState(
  service: NotificationOutboxService,
  intentId: string,
): Promise<NotificationOutboxState> {
  const state = await service.get(intentId);
  if (!state) throw new Error("通知outbox stateがありません。");
  return state;
}
