import { createHash, randomUUID } from "node:crypto";
import type { LifecycleNotification, LifecycleNotifier } from "./lifecycle-notification-service.ts";
import { RetryableWorkError } from "./retryable-error.ts";
import type { StateStore } from "./state-store.ts";
import type { HumanWorkItem } from "./types.ts";
import type {
  WorkNotificationContext,
  WorkNotificationResult,
  WorkNotifier,
} from "./work-notification-service.ts";

const OUTBOX_NAMESPACE = "notification-outbox";
const AUDIT_NAMESPACE = "notification-outbox-audit";
const LEGACY_DELIVERY_NAMESPACE = "github-delivery";
const DEFAULT_STALE_MILLISECONDS = 15 * 60_000;

export type NotificationOutboxStatus = "intent" | "sending" | "sent" | "needs_review" | "failed";

export interface NotificationIntentMetadata {
  intentId: string;
  sourceDeliveryId?: string;
}

interface LifecycleNotificationPayload {
  schemaVersion: 1;
  kind: "lifecycle";
  notification: LifecycleNotification;
  threadTs: string | null;
  metadata: NotificationIntentMetadata;
}

interface WorkNotificationPayload {
  schemaVersion: 1;
  kind: "work";
  item: HumanWorkItem;
  context: WorkNotificationContext;
  metadata: NotificationIntentMetadata;
}

interface WorkDigestPayload {
  schemaVersion: 1;
  kind: "work-digest";
  items: HumanWorkItem[];
  metadata: NotificationIntentMetadata;
}

export type NotificationPayload =
  | LifecycleNotificationPayload
  | WorkNotificationPayload
  | WorkDigestPayload;

export interface NotificationReconciliation {
  schemaVersion: 1;
  method: "slack-conversations-api";
  outcome: "message_found" | "message_not_found" | "inconclusive";
  checkedAt: string;
  channelId: string;
  scannedMessages: number;
  complete: boolean;
  messageTs?: string;
  reason: string;
}

export interface NotificationOutboxState {
  schemaVersion: 1;
  revision: number;
  intentId: string;
  status: NotificationOutboxStatus;
  channelId: string;
  sourceDeliveryId: string | null;
  payloadHash: string;
  payload: NotificationPayload;
  owner: string | null;
  attemptCount: number;
  replayCount: number;
  createdAt: string;
  updatedAt: string;
  sendingStartedAt?: string;
  sentAt?: string;
  messageTs?: string;
  failure?: string;
  lastReconciliation?: NotificationReconciliation;
}

export interface NotificationSendResult {
  messageTs: string | null;
}

export interface NotificationPayloadSender {
  send(payload: NotificationPayload): Promise<NotificationSendResult>;
}

export interface NotificationReconciler {
  reconcile(state: NotificationOutboxState): Promise<NotificationReconciliation>;
}

export interface NotificationOutboxOptions {
  channelId: string;
  replayOperatorIds?: readonly string[];
  reconciler?: NotificationReconciler;
  now?: () => number;
  owner?: () => string;
  staleMilliseconds?: number;
}

export interface NotificationIntent {
  metadata: NotificationIntentMetadata;
  payload: NotificationPayload;
}

export interface NotificationReplayCommand {
  schemaVersion: 1;
  intentId: string;
  expectedRevision: number;
  operatorId: string;
  dryRun: boolean;
  confirmed: boolean;
}

export interface NotificationReplayResult {
  schemaVersion: 1;
  intentId: string;
  beforeRevision: number;
  afterRevision: number;
  action: "none" | "record_existing" | "replay" | "blocked";
  executed: boolean;
  status: NotificationOutboxStatus;
  messageTs: string | null;
  reconciliation: NotificationReconciliation | null;
  reason: string;
}

export interface NotificationAuditItem {
  kind: "notification-intent" | "legacy-github-delivery";
  id: string;
  status: string;
  revision: number | null;
  sourceDeliveryId: string | null;
  channelId: string | null;
  updatedAt: string | null;
  failure: string | null;
  replayEligible: boolean;
  replayCommand:
    | (Omit<NotificationReplayCommand, "operatorId"> & {
        operatorId: null;
      })
    | null;
  reason: string;
}

export interface NotificationAuditResult {
  schemaVersion: 1;
  generatedAt: string;
  summary: {
    actionable: number;
    notificationIntents: number;
    legacyDeliveries: number;
  };
  items: NotificationAuditItem[];
}

interface LegacyGitHubDeliveryState {
  schemaVersion?: number;
  revision?: number;
  status?: string;
  event?: string;
  effectsStartedAt?: string;
  failedAt?: string;
  failure?: string;
}

interface NotificationOutboxAuditEvent {
  schemaVersion: 1;
  intentId: string;
  action:
    | "delivery_failed"
    | "delivery_uncertain"
    | "reconciled_existing"
    | "replay_started"
    | "replay_sent";
  operatorId: string | null;
  occurredAt: string;
  beforeRevision: number;
  afterRevision: number;
  reconciliation: NotificationReconciliation | null;
  failure: string | null;
}

export class NotificationOutboxError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NotificationOutboxError";
    this.code = code;
  }
}

export class NotificationOutboxService {
  private readonly store: StateStore;
  private readonly sender: NotificationPayloadSender;
  private readonly channelId: string;
  private readonly replayOperatorIds: Set<string>;
  private readonly reconciler: NotificationReconciler | null;
  private readonly now: () => number;
  private readonly owner: () => string;
  private readonly staleMilliseconds: number;

  constructor(
    store: StateStore,
    sender: NotificationPayloadSender,
    options: NotificationOutboxOptions,
  ) {
    if (!/^[A-Z0-9]{2,32}$/.test(options.channelId)) {
      throw new Error("通知outboxのSlack channel IDが不正です。");
    }
    const staleMilliseconds = options.staleMilliseconds ?? DEFAULT_STALE_MILLISECONDS;
    if (
      !Number.isSafeInteger(staleMilliseconds) ||
      staleMilliseconds < 60_000 ||
      staleMilliseconds > 24 * 60 * 60_000
    ) {
      throw new Error("通知outboxの送信中判定は1分から24時間で指定してください。");
    }
    this.store = store;
    this.sender = sender;
    this.channelId = options.channelId;
    this.replayOperatorIds = new Set(options.replayOperatorIds ?? []);
    this.reconciler = options.reconciler ?? null;
    this.now = options.now ?? Date.now;
    this.owner = options.owner ?? randomUUID;
    this.staleMilliseconds = staleMilliseconds;
  }

  async deliver(intent: NotificationIntent): Promise<NotificationSendResult> {
    validateIntent(intent);
    const current = await this.createOrLoad(intent);
    assertSameIntent(current, intent);
    if (current.status === "sent") {
      return { messageTs: current.messageTs ?? null };
    }
    if (current.status === "sending") {
      throw new RetryableWorkError(
        "notification_intent_in_progress",
        "同じSlack通知を送信中です。完了後に自動で再試行します。",
      );
    }
    if (current.status === "needs_review" || current.status === "failed") {
      throw new NotificationOutboxError(
        "notification_intent_requires_reconciliation",
        "Slack送信結果を確認できません。通知outboxを監査し、Slackとの照合後に手動再送してください。",
      );
    }
    return this.sendClaimed(await this.claim(current, false), null, null);
  }

  async get(intentId: string): Promise<NotificationOutboxState | null> {
    validateIntentId(intentId);
    return this.store.get<NotificationOutboxState>(OUTBOX_NAMESPACE, intentId);
  }

  async audit(includeAll = false): Promise<NotificationAuditResult> {
    const [outboxEntries, legacyEntries] = await Promise.all([
      this.store.listEntries<NotificationOutboxState>(OUTBOX_NAMESPACE),
      this.store.listEntries<LegacyGitHubDeliveryState>(LEGACY_DELIVERY_NAMESPACE),
    ]);
    const notificationItems = outboxEntries.flatMap<NotificationAuditItem>(({ key, value }) => {
      if (!isNotificationOutboxState(value)) {
        return [
          {
            kind: "notification-intent" as const,
            id: key,
            status: "invalid",
            revision: null,
            sourceDeliveryId: null,
            channelId: null,
            updatedAt: null,
            failure: "invalid_state",
            replayEligible: false,
            replayCommand: null,
            reason: "保存状態が不正です。自動変更せず保守担当者が確認してください。",
          },
        ];
      }
      const assessment = this.replayAssessment(value);
      if (!includeAll && !assessment.actionable) return [];
      return [
        {
          kind: "notification-intent" as const,
          id: value.intentId,
          status: value.status,
          revision: value.revision,
          sourceDeliveryId: value.sourceDeliveryId,
          channelId: value.channelId,
          updatedAt: value.updatedAt,
          failure: value.failure ?? null,
          replayEligible: assessment.eligible,
          replayCommand: assessment.eligible
            ? {
                schemaVersion: 1,
                intentId: value.intentId,
                expectedRevision: value.revision,
                operatorId: null,
                dryRun: true,
                confirmed: false,
              }
            : null,
          reason: assessment.reason,
        },
      ];
    });
    const legacyItems = legacyEntries.flatMap<NotificationAuditItem>(({ key, value }) => {
      if (value.status !== "effects_started" && value.status !== "failed") return [];
      return [
        {
          kind: "legacy-github-delivery" as const,
          id: key,
          status: value.status,
          revision: Number.isSafeInteger(value.revision) ? (value.revision ?? null) : null,
          sourceDeliveryId: key,
          channelId: null,
          updatedAt: value.failedAt ?? value.effectsStartedAt ?? null,
          failure: value.failure ?? null,
          replayEligible: false,
          replayCommand: null,
          reason:
            "旧deliveryには再送可能な通知payloadがありません。Slackを確認し、必要なら個別に復旧してください。",
        },
      ];
    });
    const items = [...notificationItems, ...legacyItems].sort(compareAuditItems);
    const generatedAt = isoNow(this.now);
    return {
      schemaVersion: 1,
      generatedAt,
      summary: {
        actionable: items.filter((item) => item.replayEligible).length,
        notificationIntents: notificationItems.length,
        legacyDeliveries: legacyItems.length,
      },
      items,
    };
  }

  async replay(command: NotificationReplayCommand): Promise<NotificationReplayResult> {
    validateReplayCommand(command);
    this.requireReplayOperator(command.operatorId);
    if (!this.reconciler) {
      throw new NotificationOutboxError(
        "notification_reconciler_required",
        "Slack照合機能が設定されていないため、通知を再送できません。",
      );
    }
    const current = await this.store.get<NotificationOutboxState>(
      OUTBOX_NAMESPACE,
      command.intentId,
    );
    if (!current || !isNotificationOutboxState(current)) {
      throw new NotificationOutboxError(
        "notification_intent_not_found",
        `通知intentが見つかりません: ${command.intentId}`,
      );
    }
    if (current.revision !== command.expectedRevision) {
      throw new NotificationOutboxError(
        "notification_intent_revision_conflict",
        `通知intentが更新されています。revision ${current.revision}で監査し直してください。`,
      );
    }
    if (current.status === "sent") {
      return replayResult(current, current, "none", false, null, "すでに送信済みです。");
    }
    const assessment = this.replayAssessment(current);
    if (!assessment.eligible) {
      return replayResult(current, current, "blocked", false, null, assessment.reason);
    }
    const reconciliation = await this.reconciler.reconcile(current);
    if (!reconciliation.complete || reconciliation.outcome === "inconclusive") {
      return replayResult(
        current,
        current,
        "blocked",
        false,
        reconciliation,
        "Slackの全候補を確認できなかったため、再送を停止しました。",
      );
    }
    const action = reconciliation.outcome === "message_found" ? "record_existing" : "replay";
    if (command.dryRun) {
      return replayResult(
        current,
        current,
        action,
        false,
        reconciliation,
        action === "record_existing"
          ? "既存のSlackメッセージを送信済みとして記録できます。"
          : "Slackに該当メッセージがないため、確認付きで再送できます。",
      );
    }
    if (action === "record_existing") {
      return this.recordExisting(current, command.operatorId, reconciliation);
    }
    const claimed = await this.claim(current, true, reconciliation);
    await this.appendAudit({
      intentId: current.intentId,
      action: "replay_started",
      operatorId: command.operatorId,
      beforeRevision: current.revision,
      afterRevision: claimed.revision,
      reconciliation,
      failure: null,
    });
    const sent = await this.sendClaimed(claimed, command.operatorId, reconciliation);
    const latest = await this.requireState(current.intentId);
    return replayResult(
      current,
      latest,
      "replay",
      true,
      reconciliation,
      sent.messageTs
        ? `Slack通知を再送しました（message ts: ${sent.messageTs}）。`
        : "Slack通知を再送しました。",
    );
  }

  private async createOrLoad(intent: NotificationIntent): Promise<NotificationOutboxState> {
    const timestamp = isoNow(this.now);
    const state: NotificationOutboxState = {
      schemaVersion: 1,
      revision: 1,
      intentId: intent.metadata.intentId,
      status: "intent",
      channelId: this.channelId,
      sourceDeliveryId: intent.metadata.sourceDeliveryId ?? null,
      payloadHash: payloadHash(intent.payload),
      payload: intent.payload,
      owner: null,
      attemptCount: 0,
      replayCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (await this.store.create(OUTBOX_NAMESPACE, state.intentId, state)) {
      return state;
    }
    const current = await this.store.get<NotificationOutboxState>(OUTBOX_NAMESPACE, state.intentId);
    if (!current || !isNotificationOutboxState(current)) {
      throw new NotificationOutboxError(
        "notification_intent_invalid_state",
        "通知outboxの保存状態が不正です。自動送信を停止しました。",
      );
    }
    return current;
  }

  private async claim(
    current: NotificationOutboxState,
    replay: boolean,
    reconciliation?: NotificationReconciliation,
  ): Promise<NotificationOutboxState> {
    const claimed: NotificationOutboxState = {
      ...current,
      revision: current.revision + 1,
      status: "sending",
      owner: this.owner(),
      attemptCount: current.attemptCount + 1,
      replayCount: current.replayCount + (replay ? 1 : 0),
      sendingStartedAt: isoNow(this.now),
      updatedAt: isoNow(this.now),
      ...(reconciliation ? { lastReconciliation: reconciliation } : {}),
    };
    if (
      !(await this.store.compareAndSet(
        OUTBOX_NAMESPACE,
        current.intentId,
        current.revision,
        claimed,
      ))
    ) {
      throw new RetryableWorkError(
        "notification_intent_claim_conflict",
        "Slack通知の送信権取得が競合しました。状態を再取得してください。",
      );
    }
    return claimed;
  }

  private async sendClaimed(
    claimed: NotificationOutboxState,
    operatorId: string | null,
    reconciliation: NotificationReconciliation | null,
  ): Promise<NotificationSendResult> {
    let result: NotificationSendResult;
    try {
      result = await this.sender.send(claimed.payload);
    } catch (error) {
      await this.recordSendFailure(claimed, error, operatorId, reconciliation);
      throw error;
    }
    const { failure: _failure, ...claimedWithoutFailure } = claimed;
    const sent: NotificationOutboxState = {
      ...claimedWithoutFailure,
      revision: claimed.revision + 1,
      status: "sent",
      owner: null,
      updatedAt: isoNow(this.now),
      sentAt: isoNow(this.now),
      ...(result.messageTs ? { messageTs: result.messageTs } : {}),
    };
    if (
      !(await this.store.compareAndSet(OUTBOX_NAMESPACE, claimed.intentId, claimed.revision, sent))
    ) {
      const latest = await this.store.get<NotificationOutboxState>(
        OUTBOX_NAMESPACE,
        claimed.intentId,
      );
      if (latest?.status === "sent") {
        return { messageTs: latest.messageTs ?? result.messageTs };
      }
      throw new NotificationOutboxError(
        "notification_completion_conflict",
        "Slack送信後の記録が競合しました。再送せず通知outboxを監査してください。",
      );
    }
    if (operatorId) {
      await this.appendAudit({
        intentId: claimed.intentId,
        action: "replay_sent",
        operatorId,
        beforeRevision: claimed.revision,
        afterRevision: sent.revision,
        reconciliation,
        failure: null,
      });
    }
    return result;
  }

  private async recordSendFailure(
    claimed: NotificationOutboxState,
    error: unknown,
    operatorId: string | null,
    reconciliation: NotificationReconciliation | null,
  ): Promise<void> {
    const failure = failureCode(error);
    const status = failureIsConclusive(error) ? "failed" : "needs_review";
    const failed: NotificationOutboxState = {
      ...claimed,
      revision: claimed.revision + 1,
      status,
      owner: null,
      updatedAt: isoNow(this.now),
      failure,
    };
    if (
      await this.store.compareAndSet(OUTBOX_NAMESPACE, claimed.intentId, claimed.revision, failed)
    ) {
      await this.appendAudit({
        intentId: claimed.intentId,
        action: status === "failed" ? "delivery_failed" : "delivery_uncertain",
        operatorId,
        beforeRevision: claimed.revision,
        afterRevision: failed.revision,
        reconciliation,
        failure,
      });
    }
  }

  private async recordExisting(
    current: NotificationOutboxState,
    operatorId: string,
    reconciliation: NotificationReconciliation,
  ): Promise<NotificationReplayResult> {
    if (!reconciliation.messageTs) {
      throw new NotificationOutboxError(
        "notification_reconciliation_message_required",
        "既存メッセージの照合結果にmessage tsがありません。",
      );
    }
    const { failure: _failure, ...currentWithoutFailure } = current;
    const sent: NotificationOutboxState = {
      ...currentWithoutFailure,
      revision: current.revision + 1,
      status: "sent",
      owner: null,
      updatedAt: isoNow(this.now),
      sentAt: reconciliation.checkedAt,
      messageTs: reconciliation.messageTs,
      lastReconciliation: reconciliation,
    };
    if (
      !(await this.store.compareAndSet(OUTBOX_NAMESPACE, current.intentId, current.revision, sent))
    ) {
      throw new NotificationOutboxError(
        "notification_intent_revision_conflict",
        "照合中に通知intentが更新されました。監査し直してください。",
      );
    }
    await this.appendAudit({
      intentId: current.intentId,
      action: "reconciled_existing",
      operatorId,
      beforeRevision: current.revision,
      afterRevision: sent.revision,
      reconciliation,
      failure: null,
    });
    return replayResult(
      current,
      sent,
      "record_existing",
      true,
      reconciliation,
      "既存のSlackメッセージを送信済みとして記録しました。",
    );
  }

  private replayAssessment(state: NotificationOutboxState): {
    actionable: boolean;
    eligible: boolean;
    reason: string;
  } {
    if (state.status === "sent") {
      return { actionable: false, eligible: false, reason: "送信済みです。" };
    }
    if (state.status === "needs_review" || state.status === "failed") {
      return {
        actionable: true,
        eligible: true,
        reason: "Slackとの照合後に手動で解決できます。",
      };
    }
    const updatedAt = Date.parse(state.updatedAt);
    const stale = Number.isFinite(updatedAt) && this.now() - updatedAt >= this.staleMilliseconds;
    if (state.status === "sending") {
      return stale
        ? {
            actionable: true,
            eligible: true,
            reason: "送信中のまま期限を超えています。Slackとの照合が必要です。",
          }
        : {
            actionable: false,
            eligible: false,
            reason: "現在送信中です。期限までは再送しません。",
          };
    }
    return stale
      ? {
          actionable: true,
          eligible: true,
          reason: "未送信intentが期限を超えています。Slackとの照合後に送信できます。",
        }
      : {
          actionable: false,
          eligible: false,
          reason: "送信待ちです。通常workerに任せてください。",
        };
  }

  private requireReplayOperator(operatorId: string): void {
    if (!this.replayOperatorIds.has(operatorId)) {
      throw new NotificationOutboxError(
        "notification_replay_forbidden",
        `Slack利用者 ${operatorId} には通知再送権限がありません。`,
      );
    }
  }

  private async requireState(intentId: string): Promise<NotificationOutboxState> {
    const state = await this.store.get<NotificationOutboxState>(OUTBOX_NAMESPACE, intentId);
    if (!state || !isNotificationOutboxState(state)) {
      throw new NotificationOutboxError(
        "notification_intent_not_found",
        `通知intentが見つかりません: ${intentId}`,
      );
    }
    return state;
  }

  private async appendAudit(
    event: Omit<NotificationOutboxAuditEvent, "schemaVersion" | "occurredAt">,
  ): Promise<void> {
    await this.store.append<NotificationOutboxAuditEvent>(AUDIT_NAMESPACE, {
      schemaVersion: 1,
      occurredAt: isoNow(this.now),
      ...event,
    });
  }
}

export class DelegatingNotificationPayloadSender implements NotificationPayloadSender {
  private readonly lifecycle: LifecycleNotifier;
  private readonly work: WorkNotifier;

  constructor(lifecycle: LifecycleNotifier, work: WorkNotifier) {
    this.lifecycle = lifecycle;
    this.work = work;
  }

  async send(payload: NotificationPayload): Promise<NotificationSendResult> {
    switch (payload.kind) {
      case "lifecycle": {
        const result = await this.lifecycle.notify(
          payload.notification,
          payload.threadTs,
          payload.metadata,
        );
        return { messageTs: result.messageTs };
      }
      case "work": {
        const result = await this.work.notify(payload.item, payload.context, payload.metadata);
        return { messageTs: result.messageTs };
      }
      case "work-digest":
        await this.work.digest(payload.items, payload.metadata);
        return { messageTs: null };
    }
  }
}

export class OutboxLifecycleNotifier implements LifecycleNotifier {
  private readonly outbox: NotificationOutboxService;

  constructor(outbox: NotificationOutboxService) {
    this.outbox = outbox;
  }

  async notify(
    notification: LifecycleNotification,
    threadTs: string | null,
    metadata: NotificationIntentMetadata = {
      intentId: notificationIntentId({ notification, threadTs }),
    },
  ): Promise<WorkNotificationResult> {
    const payload: LifecycleNotificationPayload = {
      schemaVersion: 1,
      kind: "lifecycle",
      notification,
      threadTs,
      metadata,
    };
    const result = await this.outbox.deliver({ metadata, payload });
    if (!result.messageTs) {
      throw new NotificationOutboxError(
        "notification_message_ts_required",
        "Slackライフサイクル通知のmessage tsを復元できませんでした。",
      );
    }
    return { messageTs: result.messageTs };
  }
}

export class OutboxWorkNotifier implements WorkNotifier {
  private readonly outbox: NotificationOutboxService;

  constructor(outbox: NotificationOutboxService) {
    this.outbox = outbox;
  }

  async notify(
    item: HumanWorkItem,
    context: WorkNotificationContext,
    metadata: NotificationIntentMetadata = {
      intentId: notificationIntentId({ item, context }),
    },
  ): Promise<WorkNotificationResult> {
    const payload: WorkNotificationPayload = {
      schemaVersion: 1,
      kind: "work",
      item,
      context,
      metadata,
    };
    const result = await this.outbox.deliver({ metadata, payload });
    if (!result.messageTs) {
      throw new NotificationOutboxError(
        "notification_message_ts_required",
        "Slack作業通知のmessage tsを復元できませんでした。",
      );
    }
    return { messageTs: result.messageTs };
  }

  async digest(
    items: HumanWorkItem[],
    metadata: NotificationIntentMetadata = {
      intentId: notificationIntentId({ kind: "work-digest", items }),
    },
  ): Promise<void> {
    const payload: WorkDigestPayload = {
      schemaVersion: 1,
      kind: "work-digest",
      items,
      metadata,
    };
    await this.outbox.deliver({ metadata, payload });
  }
}

export function notificationIntentId(value: unknown): string {
  return `notification-${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function validateIntent(intent: NotificationIntent): void {
  validateIntentId(intent.metadata.intentId);
  if (
    !isNotificationPayload(intent.payload) ||
    intent.payload.metadata.intentId !== intent.metadata.intentId
  ) {
    throw new NotificationOutboxError(
      "notification_intent_invalid",
      "通知intentのversionまたはIDが一致しません。",
    );
  }
  if (
    intent.metadata.sourceDeliveryId !== undefined &&
    !/^[A-Za-z0-9-]{1,100}$/.test(intent.metadata.sourceDeliveryId)
  ) {
    throw new NotificationOutboxError(
      "notification_source_delivery_invalid",
      "通知intentのGitHub delivery IDが不正です。",
    );
  }
}

function validateIntentId(intentId: string): void {
  if (!/^notification-[a-f0-9]{64}$/.test(intentId)) {
    throw new NotificationOutboxError(
      "notification_intent_id_invalid",
      "通知intent IDが不正です。",
    );
  }
}

function validateReplayCommand(command: NotificationReplayCommand): void {
  if (command.schemaVersion !== 1) {
    throw new NotificationOutboxError(
      "notification_replay_schema_invalid",
      "通知replay commandのschemaVersionが不正です。",
    );
  }
  validateIntentId(command.intentId);
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1) {
    throw new NotificationOutboxError(
      "notification_replay_revision_invalid",
      "通知replayには1以上のexpectedRevisionが必要です。",
    );
  }
  if (!/^[A-Z0-9]{2,32}$/.test(command.operatorId)) {
    throw new NotificationOutboxError(
      "notification_replay_operator_invalid",
      "通知replayのSlack operator IDが不正です。",
    );
  }
  if (command.dryRun === command.confirmed) {
    throw new NotificationOutboxError(
      "notification_replay_confirmation_invalid",
      "通知replayはdry-runまたは確認済み実行のどちらか一方を指定してください。",
    );
  }
}

function assertSameIntent(current: NotificationOutboxState, intent: NotificationIntent): void {
  if (
    current.intentId === intent.metadata.intentId &&
    current.channelId.length > 0 &&
    (current.payloadHash === payloadHash(intent.payload) ||
      isSentFlatTaskIssueOpenedMigration(current, intent))
  ) {
    return;
  }
  throw new NotificationOutboxError(
    "notification_intent_collision",
    "同じ通知intent IDに異なる内容が保存されています。自動送信を停止しました。",
  );
}

function isSentFlatTaskIssueOpenedMigration(
  current: NotificationOutboxState,
  intent: NotificationIntent,
): boolean {
  if (
    current.status !== "sent" ||
    !current.messageTs ||
    current.payload.kind !== "lifecycle" ||
    intent.payload.kind !== "lifecycle" ||
    current.payload.notification.kind !== "issue-opened" ||
    intent.payload.notification.kind !== "issue-opened" ||
    current.payload.notification.issueType !== "task" ||
    intent.payload.notification.issueType !== "task" ||
    current.payload.threadTs !== null ||
    !isSlackMessageTs(intent.payload.threadTs) ||
    !isSlackMessageTs(current.messageTs)
  ) {
    return false;
  }

  // Work thread集約前に送信済みのTask概要は再投稿しない。
  // sourceDeliveryIdを除き、threadTsだけが旧平投稿から変わる場合に限って既送信とみなす。
  return current.payloadHash === payloadHash({ ...intent.payload, threadTs: null });
}

function isSlackMessageTs(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d+\.\d+$/.test(value);
}

function isNotificationOutboxState(value: unknown): value is NotificationOutboxState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<NotificationOutboxState>;
  return (
    state.schemaVersion === 1 &&
    Number.isSafeInteger(state.revision) &&
    Number(state.revision) >= 1 &&
    typeof state.intentId === "string" &&
    /^notification-[a-f0-9]{64}$/.test(state.intentId) &&
    ["intent", "sending", "sent", "needs_review", "failed"].includes(state.status ?? "") &&
    typeof state.channelId === "string" &&
    /^[A-Z0-9]{2,32}$/.test(state.channelId) &&
    (state.sourceDeliveryId === null ||
      (typeof state.sourceDeliveryId === "string" &&
        /^[A-Za-z0-9-]{1,100}$/.test(state.sourceDeliveryId))) &&
    (state.owner === null || typeof state.owner === "string") &&
    Number.isSafeInteger(state.attemptCount) &&
    Number(state.attemptCount) >= 0 &&
    Number.isSafeInteger(state.replayCount) &&
    Number(state.replayCount) >= 0 &&
    typeof state.payloadHash === "string" &&
    isNotificationPayload(state.payload) &&
    state.payloadHash === payloadHash(state.payload) &&
    state.payload.metadata.intentId === state.intentId &&
    typeof state.createdAt === "string" &&
    Number.isFinite(Date.parse(state.createdAt)) &&
    typeof state.updatedAt === "string" &&
    Number.isFinite(Date.parse(state.updatedAt))
  );
}

function isNotificationPayload(value: unknown): value is NotificationPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Partial<NotificationPayload>;
  if (
    payload.schemaVersion !== 1 ||
    !payload.metadata ||
    typeof payload.metadata.intentId !== "string" ||
    !/^notification-[a-f0-9]{64}$/.test(payload.metadata.intentId)
  ) {
    return false;
  }
  if (payload.kind === "lifecycle") {
    return (
      payload.notification?.schemaVersion === 1 &&
      typeof payload.notification.resource?.url === "string" &&
      (payload.threadTs === null || typeof payload.threadTs === "string")
    );
  }
  if (payload.kind === "work") {
    return (
      payload.item?.schemaVersion === 1 &&
      typeof payload.item.url === "string" &&
      (payload.context?.kind === "state" || payload.context?.kind === "deadline") &&
      (payload.context.threadTs === null || typeof payload.context.threadTs === "string")
    );
  }
  if (payload.kind === "work-digest") {
    return (
      Array.isArray(payload.items) &&
      payload.items.every((item) => item.schemaVersion === 1 && typeof item.url === "string")
    );
  }
  return false;
}

function payloadHash(payload: NotificationPayload): string {
  const comparable = {
    ...payload,
    metadata: { intentId: payload.metadata.intentId },
  };
  return createHash("sha256").update(stableJson(comparable)).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}

function failureCode(error: unknown): string {
  if (error && typeof error === "object") {
    const data = (error as { data?: { error?: unknown } }).data;
    if (typeof data?.error === "string" && data.error) return data.error;
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  if (error instanceof Error && error.name) return error.name;
  return "unknown_error";
}

function failureIsConclusive(error: unknown): boolean {
  return new Set([
    "account_inactive",
    "channel_not_found",
    "invalid_arguments",
    "invalid_auth",
    "invalid_blocks",
    "metadata_too_large",
    "missing_scope",
    "msg_too_long",
    "not_in_channel",
    "token_revoked",
  ]).has(failureCode(error));
}

function replayResult(
  before: NotificationOutboxState,
  after: NotificationOutboxState,
  action: NotificationReplayResult["action"],
  executed: boolean,
  reconciliation: NotificationReconciliation | null,
  reason: string,
): NotificationReplayResult {
  return {
    schemaVersion: 1,
    intentId: before.intentId,
    beforeRevision: before.revision,
    afterRevision: after.revision,
    action,
    executed,
    status: after.status,
    messageTs: after.messageTs ?? null,
    reconciliation,
    reason,
  };
}

function compareAuditItems(left: NotificationAuditItem, right: NotificationAuditItem): number {
  return (
    (left.updatedAt ?? "").localeCompare(right.updatedAt ?? "") || left.id.localeCompare(right.id)
  );
}

function isoNow(now: () => number): string {
  return new Date(now()).toISOString();
}
