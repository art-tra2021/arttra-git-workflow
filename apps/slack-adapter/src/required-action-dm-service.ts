import type { LifecycleNotification, LifecycleNotifier } from "./lifecycle-notification-service.ts";
import {
  type NotificationIntentMetadata,
  type NotificationOutboxStatus,
  type NotificationRequiredAction,
  type NotificationRequiredActionKind,
  notificationIntentId,
} from "./notification-outbox.ts";
import type { HumanWorkItem } from "./types.ts";
import type { WorkDiffDigest } from "./work-diff-digest.ts";
import type {
  WorkNotificationContext,
  WorkNotificationResult,
  WorkNotifier,
} from "./work-notification-service.ts";

const LIFECYCLE_DM_KINDS = new Set<NotificationRequiredActionKind>([
  "review-requested",
  "approval-wait",
  "ci-failed",
  "changes-requested",
  "revision-pushed",
  "approved",
  "mentioned",
  "assigned",
]);

const WORK_DM_KINDS = new Set<NotificationRequiredActionKind>([
  "blocker",
  "overdue",
  "due-today",
  "conflict",
]);

/**
 * check_runのsenderはpushした本人で、通常はPR作成者と同じである。
 * 自分のpushで起きたCI失敗や承認待ちも本人が直す対象なので、実行者を除外しない。
 */
const ACTOR_INCLUDED_KINDS = new Set<NotificationRequiredActionKind>([
  "ci-failed",
  "approval-wait",
]);

/** 実行者本人も対処者として宛先に残す種別か。 */
export function requiredActionIncludesActor(kind: NotificationRequiredActionKind): boolean {
  return ACTOR_INCLUDED_KINDS.has(kind);
}

export interface RequiredActionDirectNotifiers {
  lifecycle: LifecycleNotifier;
  work: WorkNotifier;
}

export type CreateRequiredActionDirectNotifiers = (
  slackUserId: string,
) => RequiredActionDirectNotifiers;

/**
 * 対応必須通知だけを、channel/thread通知とは別intentで現在の対処者へDMする。
 * primary送信の成否やdedupe stateを共有しないため、DM障害で既存通知を失わない。
 */
export class RequiredActionDmService {
  private readonly createDirectNotifiers: CreateRequiredActionDirectNotifiers;
  private readonly reportFailure: (input: {
    kind: NotificationRequiredActionKind;
    slackUserId: string;
    error: unknown;
  }) => void;

  constructor(
    createDirectNotifiers: CreateRequiredActionDirectNotifiers,
    reportFailure: (input: {
      kind: NotificationRequiredActionKind;
      slackUserId: string;
      error: unknown;
    }) => void = ({ kind, slackUserId, error }) => {
      const failure = error instanceof Error ? error.name : "unknown_error";
      console.error(`対応必須DMをoutboxへ記録しました: ${kind} / ${slackUserId} / ${failure}`);
    },
  ) {
    this.createDirectNotifiers = createDirectNotifiers;
    this.reportFailure = reportFailure;
  }

  async notifyLifecycle(
    notification: LifecycleNotification,
    channelMetadata: NotificationIntentMetadata,
  ): Promise<number> {
    const plan = channelMetadata.requiredAction;
    if (!plan || !LIFECYCLE_DM_KINDS.has(plan.kind)) return 0;
    const recipients = directRecipients(plan);
    let delivered = 0;
    for (const slackUserId of recipients) {
      try {
        await this.createDirectNotifiers(slackUserId).lifecycle.notify(
          { ...notification, slackUserIds: [slackUserId] },
          null,
          directMetadata(channelMetadata, plan, slackUserId),
        );
        delivered += 1;
      } catch (error) {
        this.reportFailure({ kind: plan.kind, slackUserId, error });
      }
    }
    return delivered;
  }

  async notifyWork(
    item: HumanWorkItem,
    context: WorkNotificationContext,
    channelMetadata: NotificationIntentMetadata,
  ): Promise<number> {
    const plan = channelMetadata.requiredAction;
    if (!plan || !WORK_DM_KINDS.has(plan.kind)) return 0;
    const recipients = directRecipients(plan);
    let delivered = 0;
    for (const slackUserId of recipients) {
      try {
        await this.createDirectNotifiers(slackUserId).work.notify(
          item,
          { ...context, threadTs: null, slackUserId },
          directMetadata(channelMetadata, plan, slackUserId),
        );
        delivered += 1;
      } catch (error) {
        this.reportFailure({ kind: plan.kind, slackUserId, error });
      }
    }
    return delivered;
  }
}

export class LifecycleNotifierWithRequiredActionDm implements LifecycleNotifier {
  private readonly primary: LifecycleNotifier;
  private readonly direct: RequiredActionDmService;

  constructor(primary: LifecycleNotifier, direct: RequiredActionDmService) {
    this.primary = primary;
    this.direct = direct;
  }

  async notify(
    notification: LifecycleNotification,
    threadTs: string | null,
    metadata: NotificationIntentMetadata = {
      intentId: notificationIntentId({ notification, threadTs }),
    },
  ): Promise<WorkNotificationResult> {
    const result = await this.primary.notify(notification, threadTs, metadata);
    await this.direct.notifyLifecycle(notification, metadata);
    return result;
  }

  /** 担当付与のように、channel/threadの投稿と独立して決まるDMだけを送る。 */
  async notifyRequiredActionOnly(
    notification: LifecycleNotification,
    metadata: NotificationIntentMetadata,
  ): Promise<number> {
    return this.direct.notifyLifecycle(notification, metadata);
  }
}

export class WorkNotifierWithRequiredActionDm implements WorkNotifier {
  private readonly primary: WorkNotifier;
  private readonly direct: RequiredActionDmService;

  constructor(primary: WorkNotifier, direct: RequiredActionDmService) {
    this.primary = primary;
    this.direct = direct;
  }

  async notify(
    item: HumanWorkItem,
    context: WorkNotificationContext,
    metadata: NotificationIntentMetadata = {
      intentId: notificationIntentId({ item, context }),
    },
  ): Promise<WorkNotificationResult> {
    const result = await this.primary.notify(item, context, metadata);
    await this.direct.notifyWork(item, context, metadata);
    return result;
  }

  /** channel/threadへ投稿せず、metadata.requiredActionの対応必須DMだけを送る。 */
  async notifyRequiredActionOnly(
    item: HumanWorkItem,
    context: WorkNotificationContext,
    metadata: NotificationIntentMetadata,
  ): Promise<number> {
    return this.direct.notifyWork(item, context, metadata);
  }

  async digest(items: HumanWorkItem[], metadata?: NotificationIntentMetadata): Promise<void> {
    await this.primary.digest(items, metadata);
  }

  async diffDigest(digest: WorkDiffDigest, metadata?: NotificationIntentMetadata): Promise<void> {
    if (!this.primary.diffDigest) {
      throw new Error("差分digestを投稿できるnotifierがありません。");
    }
    await this.primary.diffDigest(digest, metadata);
  }

  async diffDigestDeliveryStatus(intentId: string): Promise<NotificationOutboxStatus | null> {
    if (!this.primary.diffDigestDeliveryStatus) {
      throw new Error("差分digestの送信結果を確かめられるnotifierがありません。");
    }
    return this.primary.diffDigestDeliveryStatus(intentId);
  }
}

function directMetadata(
  channelMetadata: NotificationIntentMetadata,
  plan: NotificationRequiredAction,
  slackUserId: string,
): NotificationIntentMetadata {
  return {
    intentId: notificationIntentId({
      kind: "required-action-dm",
      sourceIntentId: channelMetadata.intentId,
      recipientSlackUserId: slackUserId,
      schemaVersion: 1,
    }),
    ...(channelMetadata.sourceDeliveryId
      ? { sourceDeliveryId: channelMetadata.sourceDeliveryId }
      : {}),
    // payload hashはmetadataのintentIdだけを見るため、DM文面の種別を足してもintentは変わらない。
    requiredAction: {
      kind: plan.kind,
      recipientSlackUserIds: [slackUserId],
      actorSlackUserId: plan.actorSlackUserId,
    },
  };
}

function isSlackUserId(value: string): boolean {
  return /^[UW][A-Z0-9]{2,31}$/.test(value);
}

function directRecipients(plan: NotificationRequiredAction): string[] {
  const includeActor = ACTOR_INCLUDED_KINDS.has(plan.kind);
  return [...new Set(plan.recipientSlackUserIds)]
    .filter((slackUserId) => includeActor || slackUserId !== plan.actorSlackUserId)
    .filter(isSlackUserId);
}
