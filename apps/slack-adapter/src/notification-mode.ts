import {
  type NotificationIntentMetadata,
  type NotificationRequiredActionKind,
  notificationIntentId,
} from "./notification-outbox.ts";
import { requiredActionIncludesActor } from "./required-action-dm-service.ts";

/**
 * Slack通知の出し方。
 * threadはIssueごとの親投稿とthreadへ続報を集約する従来方式、
 * directは親投稿とthreadを作らず、対応必須の本人DMと全員向けの単独投稿だけを出す方式。
 */
export type NotificationMode = "thread" | "direct";

export const NOTIFICATION_MODE_ENV = "AR_SLACK_NOTIFICATION_MODE";

/** 未設定は既存の挙動を守るためthreadにする。それ以外の値は起動時に拒否する。 */
export function parseNotificationMode(value: string | undefined): NotificationMode {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return "thread";
  if (normalized === "thread" || normalized === "direct") return normalized;
  throw new Error(`${NOTIFICATION_MODE_ENV}にはthreadまたはdirectを指定してください。`);
}

/** DMを送れない宛先。GitHub未連携の利用者と、DM先を持たないGitHub teamがある。 */
export interface UnreachableRecipient {
  kind: "github-user" | "github-team";
  name: string;
}

/**
 * directモードでchannelへ出す単独投稿のintent。
 * 元の出来事のintent IDとDMを送れない宛先から決まるため、Webhookの再配信でも同じintentへまとまる。
 * 再処理までにGitHub連携が進んで宛先が変わった場合は別intentにし、同じIDで中身が食い違って
 * outboxが停止しないようにする。
 * 従来方式のchannel/thread intentとは別のIDにし、既存intentの内容と衝突させない。
 */
export function channelNoticeMetadata(
  source: NotificationIntentMetadata,
  recipients: readonly UnreachableRecipient[] = [],
): NotificationIntentMetadata {
  return {
    intentId: notificationIntentId({
      kind: "channel-notice",
      sourceIntentId: source.intentId,
      ...(recipients.length > 0
        ? {
            recipients: recipients
              .map((recipient) => `${recipient.kind}:${recipient.name.toLowerCase()}`)
              .sort(),
          }
        : {}),
      schemaVersion: 1,
    }),
    ...(source.sourceDeliveryId ? { sourceDeliveryId: source.sourceDeliveryId } : {}),
  };
}

/**
 * 対応必須の宛先を、DMできるSlack user IDとDMできないGitHub loginへ分ける。
 * Slack user IDへの変換は検証済みmappingだけを使い、推測しない。
 * 実行者本人はCI失敗と承認待ち以外では宛先から外す。botはDMもchannel案内もしない。
 * fallbackLoginsを渡した場合、DMできない宛先はその中にいる人だけに絞る。
 */
export async function partitionDirectRecipients(
  logins: readonly string[],
  resolveSlackUserId: (githubLogin: string) => Promise<string | null>,
  options: {
    kind: NotificationRequiredActionKind;
    actorLogin: string | null;
    fallbackLogins?: readonly string[];
  },
): Promise<{ slackUserIds: string[]; unreachableLogins: string[] }> {
  const actor = options.actorLogin?.toLowerCase() ?? null;
  const includeActor = requiredActionIncludesActor(options.kind);
  const fallback = options.fallbackLogins
    ? new Set(options.fallbackLogins.map((login) => login.toLowerCase()))
    : null;
  const unique = [...new Map(logins.map((login) => [login.toLowerCase(), login])).entries()];
  const slackUserIds: string[] = [];
  const unreachableLogins: string[] = [];
  for (const [normalized, login] of unique) {
    if (isBotLogin(normalized)) continue;
    if (!includeActor && normalized === actor) continue;
    const slackUserId = await resolveSlackUserId(login);
    if (slackUserId) {
      if (!slackUserIds.includes(slackUserId)) slackUserIds.push(slackUserId);
    } else if (!fallback || fallback.has(normalized)) {
      unreachableLogins.push(login);
    }
  }
  return { slackUserIds, unreachableLogins };
}

export function unreachableUsers(logins: readonly string[]): UnreachableRecipient[] {
  return logins.map((name) => ({ kind: "github-user" as const, name }));
}

/** channelの単独投稿に添える、DMを送れない宛先の表示行。 */
export function unreachableRecipientLines(recipients: readonly UnreachableRecipient[]): string[] {
  const labels = recipients.map((recipient) =>
    recipient.kind === "github-team"
      ? `@${recipient.name}（GitHub team）`
      : `@${recipient.name}（Slack未連携）`,
  );
  return [
    `*DMを送れない宛先:* ${labels.join("、")}`,
    ...(recipients.some((recipient) => recipient.kind === "github-user")
      ? ["Slackで `/ar connect github` を実行してGitHubと連携すると、次からはDMで届きます。"]
      : []),
  ];
}

function isBotLogin(login: string): boolean {
  return login.endsWith("[bot]");
}
