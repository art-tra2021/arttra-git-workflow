import type { LifecycleNotification, LifecycleNotifier } from "./lifecycle-notification-service.ts";
import {
  type NotificationIntentMetadata,
  type NotificationRequiredActionKind,
  notificationIntentId,
} from "./notification-outbox.ts";
import type { HumanWorkItem } from "./types.ts";
import type {
  WorkNotificationContext,
  WorkNotificationResult,
  WorkNotifier,
} from "./work-notification-service.ts";

const LIFECYCLE_DM_KINDS = new Set<NotificationRequiredActionKind>([
  "review-requested",
  "approval-wait",
  "ci-failed",
]);

const WORK_DM_KINDS = new Set<NotificationRequiredActionKind>(["blocker", "overdue"]);

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
    const recipients = directRecipients(plan.recipientSlackUserIds, plan.actorSlackUserId);
    let delivered = 0;
    for (const slackUserId of recipients) {
      try {
        await this.createDirectNotifiers(slackUserId).lifecycle.notify(
          { ...notification, slackUserIds: [slackUserId] },
          null,
          directMetadata(channelMetadata, slackUserId),
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
    const recipients = directRecipients(plan.recipientSlackUserIds, plan.actorSlackUserId);
    let delivered = 0;
    for (const slackUserId of recipients) {
      try {
        await this.createDirectNotifiers(slackUserId).work.notify(
          item,
          { ...context, threadTs: null, slackUserId },
          directMetadata(channelMetadata, slackUserId),
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

  async digest(items: HumanWorkItem[], metadata?: NotificationIntentMetadata): Promise<void> {
    await this.primary.digest(items, metadata);
  }
}

function directMetadata(
  channelMetadata: NotificationIntentMetadata,
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
  };
}

function isSlackUserId(value: string): boolean {
  return /^[UW][A-Z0-9]{2,31}$/.test(value);
}

function directRecipients(values: string[], actorSlackUserId: string | null): string[] {
  return [...new Set(values)]
    .filter((slackUserId) => slackUserId !== actorSlackUserId)
    .filter(isSlackUserId);
}
