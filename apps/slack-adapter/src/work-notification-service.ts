import { createHash } from "node:crypto";
import {
  parseIssueReferenceUrl,
  resolveNotificationThreadRootIssue,
} from "./lifecycle-notification-service.ts";
import {
  channelNoticeMetadata,
  type NotificationMode,
  partitionDirectRecipients,
  type UnreachableRecipient,
  unreachableUsers,
} from "./notification-mode.ts";
import {
  type NotificationIntentMetadata,
  type NotificationOutboxStatus,
  type NotificationRequiredActionKind,
  notificationIntentId,
} from "./notification-outbox.ts";
import { NotificationThreadService } from "./notification-thread-service.ts";
import type { GitHubLifecycleClient } from "./review-types.ts";
import type { StateStore } from "./state-store.ts";
import type { HumanWorkItem } from "./types.ts";
import {
  buildWorkDiffDigest,
  type DigestMode,
  type DigestSnapshot,
  type DigestSnapshotItem,
  diffDigestItems,
  digestLineCount,
  incompleteSourceReason,
  normalizeDigestItem,
  snapshotItems,
  type WorkDiffDigest,
} from "./work-diff-digest.ts";

const NOTIFICATION_NAMESPACE = "work-notification";
const DEADLINE_NAMESPACE = "work-deadline-notification";
const DIGEST_SNAPSHOT_NAMESPACE = "work-digest-snapshot";
const DIGEST_SNAPSHOT_POINTER_NAMESPACE = "work-digest-snapshot-pointer";
const DIGEST_SNAPSHOT_POINTER_KEY = "latest";
const DIFF_DIGEST_NAMESPACE = "work-diff-digest";
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

export interface WorkItemSource {
  loadProjectItems(): Promise<HumanWorkItem[]>;
  /**
   * 差分digest用の項目。closeしたIssueもstatus doneで含め、issueTypeとparentUrlを埋める。
   * AR_DIGEST_MODE=diffで必要になる。loadProjectItemsでは代わりにしない
   * （closeしたIssueが「Projectから外れた」に、種別がすべてWorkになるため）。
   */
  loadProjectDigestItems?(): Promise<HumanWorkItem[]>;
}

export interface WorkNotifier {
  notify(
    item: HumanWorkItem,
    context: WorkNotificationContext,
    metadata?: NotificationIntentMetadata,
  ): Promise<WorkNotificationResult>;
  digest(items: HumanWorkItem[], metadata?: NotificationIntentMetadata): Promise<void>;
  /** 前回からの差分digestをchannelへ投稿する。AR_DIGEST_MODE=diffで必要になる。 */
  diffDigest?(digest: WorkDiffDigest, metadata?: NotificationIntentMetadata): Promise<void>;
  /**
   * 差分digestのintentの通知outboxでの状態を返す。intentが無ければnull。
   * 前回の投稿が失敗したかを確かめて、比較の基準を進めてよいかを決めるために使う。
   */
  diffDigestDeliveryStatus?(intentId: string): Promise<NotificationOutboxStatus | null>;
  /**
   * channel/threadへ投稿せず、metadata.requiredActionの対応必須DMだけを送る。
   * DM経路を持たないnotifierは実装しない。
   */
  notifyRequiredActionOnly?(
    item: HumanWorkItem,
    context: WorkNotificationContext,
    metadata: NotificationIntentMetadata,
  ): Promise<number>;
}

export interface WorkNotificationContext {
  kind: "state" | "deadline";
  threadTs: string | null;
  slackUserId: string | null;
  actorSlackUserId?: string | null;
  /** directモードのchannel単独投稿。旧payloadには無く、既存intentのhashを変えない。 */
  standalone?: boolean;
  /** directモードで、DMを送れないためchannelで知らせる宛先。 */
  unreachableRecipients?: UnreachableRecipient[];
}

export interface WorkNotificationResult {
  messageTs: string;
}

export type ResolveSlackUserId = (githubLogin: string) => Promise<string | null>;

interface WorkNotificationState {
  schemaVersion: 1;
  issueUrl: string;
  fingerprint: string;
  notifiedAt: string;
}

type DeadlineStage = "due-soon" | "due-today" | "overdue";

/**
 * 差分digestの比較の基準と、送信結果を待っている投稿。
 * dateは比較の基準にするスナップショットの日付で、投稿がoutboxでsentになった時か、
 * 投稿が要らないと判断した時（初回、変化なし）にだけ進める。
 */
interface DigestSnapshotPointer {
  schemaVersion: 1;
  date: string;
  /** dateのスナップショットの比較元。初回はnull。 */
  baselineDate: string | null;
  /** dateの日に基準を進めた理由。同じ日の再実行の返り値に使う。 */
  outcome: "baseline-saved" | "no-changes" | "posted";
  /** 投稿記録を作ったが、outboxでsentになったと確かめていない投稿。 */
  pending: DiffDigestRecordKey | null;
}

interface DiffDigestRecordKey {
  date: string;
  attempt: number;
}

/**
 * 差分digestの投稿記録。keyは日付と試行回数（例: 2026-11-14#1）。
 * 送信がsentになるまで比較の基準を進めないため、基準にする予定のスナップショット（items）も持つ。
 */
interface DiffDigestRecord {
  schemaVersion: 1;
  date: string;
  /** 同じ日に送り直した回数を含む試行の番号。1から始まる。 */
  attempt: number;
  baselineDate: string;
  intentId: string;
  digest: WorkDiffDigest;
  lineCount: number;
  items: DigestSnapshotItem[];
  /** supersededは送信に失敗し、次の実行の差分へまとめ直したことを表す。 */
  status: "pending" | "sent" | "superseded";
  createdAt: string;
  sentAt?: string;
  supersededAt?: string;
}

export interface DiffDigestResult {
  /** 実行した日付（JST）。 */
  date: string;
  /** 比較元にしたスナップショットの日付。初回はnull。 */
  baselineDate: string | null;
  /**
   * baseline-savedは初回のため基準だけを保存した、no-changesは変化がなく投稿しなかった、
   * postedは投稿した、already-postedは同じ日に投稿済みのため何もしなかった、
   * source-incompleteは取得結果が欠けていそうなため投稿も基準の更新もしなかったことを表す。
   */
  outcome: "baseline-saved" | "no-changes" | "posted" | "already-posted" | "source-incomplete";
  /** この実行で投稿した差分の行数。 */
  lineCount: number;
  /** source-incompleteの理由。 */
  reason?: string;
}

interface WorkDeadlineNotificationState {
  schemaVersion: 1;
  issueUrl: string;
  targetDate: string;
  stage: DeadlineStage;
  notifiedAt: string;
}

export class WorkNotificationService {
  private readonly source: WorkItemSource;
  private readonly store: StateStore;
  private readonly notifier: WorkNotifier;
  private readonly now: () => number;
  private readonly resolveSlackUserId: ResolveSlackUserId;
  private readonly deadlineLeadDays: number;
  private readonly threads: NotificationThreadService;
  private readonly github: Pick<GitHubLifecycleClient, "loadIssueContext"> | null;
  private readonly mode: NotificationMode;
  private readonly digestMode: DigestMode;

  constructor(
    source: WorkItemSource,
    store: StateStore,
    notifier: WorkNotifier,
    now: () => number = Date.now,
    resolveSlackUserId: ResolveSlackUserId = async () => null,
    deadlineLeadDays = 3,
    threads: NotificationThreadService = new NotificationThreadService(store, now),
    github: Pick<GitHubLifecycleClient, "loadIssueContext"> | null = null,
    options: { mode?: NotificationMode; digestMode?: DigestMode } = {},
  ) {
    if (!Number.isSafeInteger(deadlineLeadDays) || deadlineLeadDays < 1 || deadlineLeadDays > 30) {
      throw new Error("期限通知の日数は1日から30日で指定してください。");
    }
    this.source = source;
    this.store = store;
    this.notifier = notifier;
    this.now = now;
    this.resolveSlackUserId = resolveSlackUserId;
    this.deadlineLeadDays = deadlineLeadDays;
    this.threads = threads;
    this.github = github;
    this.mode = options.mode ?? "thread";
    this.digestMode = options.digestMode ?? "list";
    if (
      this.digestMode === "diff" &&
      (!notifier.diffDigest || !notifier.diffDigestDeliveryStatus)
    ) {
      throw new Error("AR_DIGEST_MODE=diffには差分digestを投稿できるnotifierが必要です。");
    }
    if (this.digestMode === "diff" && !source.loadProjectDigestItems) {
      throw new Error(
        "AR_DIGEST_MODE=diffにはGitHub Projectから差分digest用の項目を読む取得元が必要です。",
      );
    }
  }

  async notifyImmediate(sourceDeliveryId?: string, actorLogin?: string | null): Promise<number> {
    const items = await this.source.loadProjectItems();
    const actorSlackUserId = actorLogin ? await this.resolveSlackUserId(actorLogin) : null;
    let notified = 0;
    for (const item of items) {
      // CI失敗はcheck_run/check_suiteのlifecycle通知だけが扱う。周辺eventから再通知しない。
      if (item.delivery !== "immediate" || item.reasonCode === "CHECKS_FAILED") {
        await this.store.remove(NOTIFICATION_NAMESPACE, item.url);
        continue;
      }
      const fingerprint = workFingerprint(item);
      const previous = await this.store.get<WorkNotificationState>(
        NOTIFICATION_NAMESPACE,
        item.url,
      );
      if (previous?.fingerprint === fingerprint) {
        continue;
      }
      const sent = await this.notifyThreaded(
        item,
        "state",
        {
          intentId: notificationIntentId({
            kind: "work-state",
            issueUrl: item.url,
            fingerprint,
          }),
          ...(sourceDeliveryId ? { sourceDeliveryId } : {}),
        },
        actorSlackUserId,
        actorLogin ?? null,
      );
      if (!sent) continue;
      await this.store.set<WorkNotificationState>(NOTIFICATION_NAMESPACE, item.url, {
        schemaVersion: 1,
        issueUrl: item.url,
        fingerprint,
        notifiedAt: new Date(this.now()).toISOString(),
      });
      notified += 1;
    }
    return notified;
  }

  async notifyDeadlines(): Promise<number> {
    const items = await this.source.loadProjectItems();
    const today = dateInTokyo(this.now());
    let notified = 0;
    for (const item of items) {
      const stage = deadlineStage(item, today, this.deadlineLeadDays);
      if (!stage || !item.targetDate) {
        await this.store.remove(DEADLINE_NAMESPACE, item.url);
        continue;
      }
      const previous = await this.store.get<WorkDeadlineNotificationState>(
        DEADLINE_NAMESPACE,
        item.url,
      );
      if (previous?.targetDate === item.targetDate && previous.stage === stage) {
        continue;
      }
      const sent = await this.notifyThreaded(deadlineWorkItem(item, stage, today), "deadline", {
        intentId: notificationIntentId({
          kind: "work-deadline",
          issueUrl: item.url,
          targetDate: item.targetDate,
          stage,
        }),
      });
      if (!sent) continue;
      await this.store.set<WorkDeadlineNotificationState>(DEADLINE_NAMESPACE, item.url, {
        schemaVersion: 1,
        issueUrl: item.url,
        targetDate: item.targetDate,
        stage,
        notifiedAt: new Date(this.now()).toISOString(),
      });
      notified += 1;
    }
    return notified;
  }

  /**
   * 日次digestを投稿する。listモードは未完了一覧の件数、diffモードは投稿した差分の行数を返す。
   */
  async sendDigest(): Promise<number> {
    if (this.digestMode === "diff") {
      return (await this.sendDiffDigest()).lineCount;
    }
    const items = (await this.source.loadProjectItems())
      .filter((item) => item.delivery !== "silent")
      .sort(compareWorkItems);
    if (items.length > 0) {
      await this.notifier.digest(items.map(notificationPayloadItem), {
        intentId: notificationIntentId({
          kind: "work-digest",
          date: dateInTokyo(this.now()),
          items: items.map((item) => ({
            url: item.url,
            reasonCode: item.reasonCode,
            nextAction: item.nextAction,
          })),
        }),
      });
    }
    return items.length;
  }

  /**
   * Project #8のスナップショットを日付（JST）キーで保存し、比較の基準との差分を投稿する。
   *
   * - 初回は投稿せず、基準のスナップショットだけを保存する。
   * - 変化のない日は投稿せず、その日のスナップショットを基準にする。
   * - 投稿する日は、送信がoutboxでsentになった時にだけ、その日のスナップショットを基準にする。
   *   送信に失敗したら基準を進めず、次の実行（同じ日でも翌日でも）が最後に成功した基準と比べる。
   * - 基準を進めた日の再実行は何もしない。その後の変化は翌日の差分に入る。
   * - 取得結果が欠けていそうな日は、投稿も基準の更新もしない。
   */
  async sendDiffDigest(): Promise<DiffDigestResult> {
    const date = dateInTokyo(this.now());
    let pointer = await this.loadDigestPointer();
    let attempt = 1;
    if (pointer?.pending) {
      const pending = await this.store.get<DiffDigestRecord>(
        DIFF_DIGEST_NAMESPACE,
        diffDigestRecordKey(pointer.pending),
      );
      if (pending?.status === "pending") {
        const settled = await this.settlePendingDiffDigest(pending, date);
        if (settled.result) return settled.result;
        attempt = settled.nextAttempt;
        pointer = await this.loadDigestPointer();
      } else if (pending?.status === "superseded" && pending.date === date) {
        // まとめ直した記録を残したままpointerの更新だけが失敗した場合も、次の試行番号で作り直す。
        attempt = pending.attempt + 1;
      }
    }
    if (pointer && pointer.date === date && !pointer.pending) {
      return {
        date,
        baselineDate: pointer.baselineDate,
        outcome: pointer.outcome === "posted" ? "already-posted" : pointer.outcome,
        lineCount: 0,
      };
    }

    const loadDigestItems = this.source.loadProjectDigestItems;
    if (!loadDigestItems) {
      throw new Error("差分digest用の項目を読む取得元がありません。");
    }
    const current = (await loadDigestItems.call(this.source)).map(normalizeDigestItem);
    const baseline = pointer
      ? await this.store.get<DigestSnapshot>(DIGEST_SNAPSHOT_NAMESPACE, pointer.date)
      : null;
    if (!baseline) {
      await this.commitDigestBaseline(date, null, snapshotItems(current), "baseline-saved");
      return {
        date,
        baselineDate: null,
        outcome: "baseline-saved",
        lineCount: 0,
      };
    }

    const reason = incompleteSourceReason(baseline, current);
    if (reason) {
      console.warn(
        `差分digestを投稿せず、比較の基準（${baseline.date}）も進めませんでした。取得結果が欠けている可能性があります: ${reason}`,
      );
      return {
        date,
        baselineDate: baseline.date,
        outcome: "source-incomplete",
        lineCount: 0,
        reason,
      };
    }

    const digest = buildWorkDiffDigest(diffDigestItems(baseline, current, date), {
      date,
      baselineDate: baseline.date,
      knownItems: [...current, ...baseline.items],
    });
    if (!digest) {
      await this.commitDigestBaseline(date, baseline.date, snapshotItems(current), "no-changes");
      return {
        date,
        baselineDate: baseline.date,
        outcome: "no-changes",
        lineCount: 0,
      };
    }
    const record: DiffDigestRecord = {
      schemaVersion: 1,
      date,
      attempt,
      baselineDate: baseline.date,
      intentId: diffDigestIntentId(date, attempt),
      digest,
      lineCount: digestLineCount(digest),
      items: snapshotItems(current),
      status: "pending",
      createdAt: new Date(this.now()).toISOString(),
    };
    const key = diffDigestRecordKey(record);
    // 同時に走った実行があれば、先に記録した方の中身を同じintentで送る。outboxが一度だけ投稿する。
    if (!(await this.store.create(DIFF_DIGEST_NAMESPACE, key, record))) {
      const existing = await this.store.get<DiffDigestRecord>(DIFF_DIGEST_NAMESPACE, key);
      if (!existing) throw new Error("差分digestの投稿記録を読み取れませんでした。");
      if (existing.status === "sent") {
        return {
          date,
          baselineDate: existing.baselineDate,
          outcome: "already-posted",
          lineCount: 0,
        };
      }
      if (existing.status === "superseded") {
        throw new Error("差分digestの投稿記録が同時に更新されました。再実行してください。");
      }
      await this.markDigestPending(existing);
      return this.deliverDiffDigest(existing);
    }
    await this.markDigestPending(record);
    return this.deliverDiffDigest(record);
  }

  /**
   * 送信結果を確かめていない投稿を片づける。
   * outboxでsentなら基準を進め、送っていない・確実に失敗したなら次の差分へまとめ直す。
   * 送れたか分からない（送信中、要照合）なら、二重に投稿しないよう止める。
   */
  private async settlePendingDiffDigest(
    record: DiffDigestRecord,
    today: string,
  ): Promise<{ result: DiffDigestResult | null; nextAttempt: number }> {
    const status = await this.diffDigestDeliveryStatus(record.intentId);
    if (status === "sent") {
      await this.commitPostedDiffDigest(record);
      if (record.date !== today) return { result: null, nextAttempt: 1 };
      return {
        result: {
          date: today,
          baselineDate: record.baselineDate,
          outcome: "already-posted",
          lineCount: 0,
        },
        nextAttempt: 1,
      };
    }
    if (status === "sending" || status === "needs_review") {
      throw new Error(
        `${record.date}の差分digest（intent ${record.intentId}）の送信結果が確定していません。通知outboxを監査し、Slackと照合してから再実行してください。`,
      );
    }
    if (record.date === today && status !== "failed") {
      // 記録後に送信まで進まなかった同じ日の投稿は、同じ中身を同じintentで送り直す。
      return { result: await this.deliverDiffDigest(record), nextAttempt: 1 };
    }
    // 確実に失敗した投稿と、前日以前に送れなかった投稿は送り直さず、
    // 最後に成功した基準からの差分（失敗した日の分を含む）として今回の投稿にまとめる。
    await this.store.set<DiffDigestRecord>(DIFF_DIGEST_NAMESPACE, diffDigestRecordKey(record), {
      ...record,
      status: "superseded",
      supersededAt: new Date(this.now()).toISOString(),
    });
    const pointer = await this.loadDigestPointer();
    if (pointer) {
      await this.saveDigestPointer({ ...pointer, pending: null });
    }
    return {
      result: null,
      nextAttempt: record.date === today ? record.attempt + 1 : 1,
    };
  }

  private async deliverDiffDigest(record: DiffDigestRecord): Promise<DiffDigestResult> {
    const diffDigest = this.notifier.diffDigest;
    if (!diffDigest) {
      throw new Error("差分digestを投稿できるnotifierがありません。");
    }
    await diffDigest.call(this.notifier, record.digest, {
      intentId: record.intentId,
    });
    await this.commitPostedDiffDigest(record);
    return {
      date: record.date,
      baselineDate: record.baselineDate,
      outcome: "posted",
      lineCount: record.lineCount,
    };
  }

  private async diffDigestDeliveryStatus(
    intentId: string,
  ): Promise<NotificationOutboxStatus | null> {
    const status = this.notifier.diffDigestDeliveryStatus;
    if (!status) {
      throw new Error("差分digestの送信結果を確かめられるnotifierがありません。");
    }
    return status.call(this.notifier, intentId);
  }

  /** 投稿記録を作ったことをpointerへ残す。翌日以降の実行が送信結果を確かめられるようにする。 */
  private async markDigestPending(record: DiffDigestRecord): Promise<void> {
    const pointer = await this.loadDigestPointer();
    if (!pointer) throw new Error("差分digestの比較の基準を読み取れませんでした。");
    await this.saveDigestPointer({
      ...pointer,
      pending: { date: record.date, attempt: record.attempt },
    });
  }

  /** outboxでsentになった投稿のスナップショットを、比較の基準にする。 */
  private async commitPostedDiffDigest(record: DiffDigestRecord): Promise<void> {
    await this.commitDigestBaseline(record.date, record.baselineDate, record.items, "posted");
    await this.store.set<DiffDigestRecord>(DIFF_DIGEST_NAMESPACE, diffDigestRecordKey(record), {
      ...record,
      status: "sent",
      sentAt: new Date(this.now()).toISOString(),
    });
  }

  private async commitDigestBaseline(
    date: string,
    baselineDate: string | null,
    items: DigestSnapshotItem[],
    outcome: DigestSnapshotPointer["outcome"],
  ): Promise<void> {
    await this.store.set<DigestSnapshot>(DIGEST_SNAPSHOT_NAMESPACE, date, {
      schemaVersion: 1,
      date,
      takenAt: new Date(this.now()).toISOString(),
      baselineDate,
      items,
    });
    await this.saveDigestPointer({
      schemaVersion: 1,
      date,
      baselineDate,
      outcome,
      pending: null,
    });
  }

  private async loadDigestPointer(): Promise<DigestSnapshotPointer | null> {
    return this.store.get<DigestSnapshotPointer>(
      DIGEST_SNAPSHOT_POINTER_NAMESPACE,
      DIGEST_SNAPSHOT_POINTER_KEY,
    );
  }

  private async saveDigestPointer(pointer: DigestSnapshotPointer): Promise<void> {
    await this.store.set<DigestSnapshotPointer>(
      DIGEST_SNAPSHOT_POINTER_NAMESPACE,
      DIGEST_SNAPSHOT_POINTER_KEY,
      pointer,
    );
  }

  private async notifyThreaded(
    item: HumanWorkItem,
    kind: WorkNotificationContext["kind"],
    metadata: NotificationIntentMetadata,
    actorSlackUserId: string | null = null,
    actorLogin: string | null = null,
  ): Promise<boolean> {
    if (this.mode === "direct") {
      await this.notifyDirect(item, kind, metadata, actorSlackUserId, actorLogin);
      return true;
    }
    const slackUserId = item.owner ? await this.resolveSlackUserId(item.owner) : null;
    const requiredAction = workRequiredAction(item);
    const notificationMetadata: NotificationIntentMetadata = {
      ...metadata,
      ...(requiredAction
        ? {
            requiredAction: {
              kind: requiredAction.kind,
              recipientSlackUserIds: await this.resolveSlackUserIds(requiredAction.recipientLogins),
              actorSlackUserId,
            },
          }
        : {}),
    };
    // 宛先計算用の全担当者とPR作成者は、既存intentのpayload hashを変えないよう送信前に外す。
    const payloadItem = notificationPayloadItem(item);
    const context: Omit<WorkNotificationContext, "threadTs"> = {
      kind,
      slackUserId,
      ...(actorSlackUserId ? { actorSlackUserId } : {}),
    };
    if (this.github) {
      const reference = parseIssueReferenceUrl(item.url);
      if (!reference) return false;
      const issue = await this.github.loadIssueContext(reference.repository, reference.number);
      const threadRootIssue = await resolveNotificationThreadRootIssue(
        issue,
        this.github,
        new Set([(item.repository ?? reference.repository).toLowerCase()]),
      );
      if (!threadRootIssue) return false;
      if (threadRootIssue.url !== issue.url) {
        const threadTs = await this.threads.rootTs(threadRootIssue.url);
        if (!threadTs) return false;
        await this.notifier.notify(payloadItem, { ...context, threadTs }, notificationMetadata);
        return true;
      }
    }
    await this.threads.publish(item.url, (threadTs) =>
      this.notifier.notify(payloadItem, { ...context, threadTs }, notificationMetadata),
    );
    return true;
  }

  /**
   * directモードの送り分け。Issueごとのthreadは使わない。
   * 急ぎの未割当はTaskも含めて全員向けのchannel単独投稿にする。
   * blocker・期限・conflictは宛先本人へDMし、DMを送れない宛先がいるときだけchannelで知らせる。
   * それ以外（期限接近、進行中の更新など）はSlackへ出さない。
   */
  private async notifyDirect(
    item: HumanWorkItem,
    kind: WorkNotificationContext["kind"],
    metadata: NotificationIntentMetadata,
    actorSlackUserId: string | null,
    actorLogin: string | null,
  ): Promise<void> {
    const payloadItem = notificationPayloadItem(item);
    if (item.reasonCode === "URGENT_UNASSIGNED") {
      await this.notifier.notify(
        payloadItem,
        { kind, threadTs: null, slackUserId: null, standalone: true },
        channelNoticeMetadata(metadata),
      );
      return;
    }
    const requiredAction = workRequiredAction(item);
    if (!requiredAction) return;
    if (requiredAction.recipientLogins.length === 0) {
      // 担当者のいないblocker・期限超過や、PR作成者が分からないconflictは、DMの宛先がなく誰にも届かない。
      // 拾う人がいないこと自体をチームが知る必要があるため、全員向けのchannel単独投稿にする。
      if (requiredAction.kind !== "due-today") {
        await this.notifier.notify(
          payloadItem,
          { kind, threadTs: null, slackUserId: null, standalone: true },
          channelNoticeMetadata(metadata),
        );
      }
      return;
    }
    const { slackUserIds, unreachableLogins } = await partitionDirectRecipients(
      requiredAction.recipientLogins,
      this.resolveSlackUserId,
      { kind: requiredAction.kind, actorLogin },
    );
    const unreachable = [...unreachableLogins];
    if (slackUserIds.length > 0) {
      if (this.notifier.notifyRequiredActionOnly) {
        // 従来方式と同じcontextとintentを渡し、DM intentを再配信やモード切り替えで増やさない。
        const slackUserId = item.owner ? await this.resolveSlackUserId(item.owner) : null;
        await this.notifier.notifyRequiredActionOnly(
          payloadItem,
          {
            kind,
            threadTs: null,
            slackUserId,
            ...(actorSlackUserId ? { actorSlackUserId } : {}),
          },
          {
            ...metadata,
            requiredAction: {
              kind: requiredAction.kind,
              recipientSlackUserIds: slackUserIds,
              actorSlackUserId,
            },
          },
        );
      } else {
        const all = await partitionDirectRecipients(
          requiredAction.recipientLogins,
          async () => null,
          { kind: requiredAction.kind, actorLogin },
        );
        unreachable.push(...all.unreachableLogins);
      }
    }
    if (unreachable.length > 0) {
      const unreachableRecipients = unreachableUsers([...new Set(unreachable)]);
      await this.notifier.notify(
        payloadItem,
        {
          kind,
          threadTs: null,
          slackUserId: null,
          standalone: true,
          unreachableRecipients,
        },
        channelNoticeMetadata(metadata, unreachableRecipients),
      );
    }
  }

  private async resolveSlackUserIds(logins: string[]): Promise<string[]> {
    const uniqueLogins = [...new Map(logins.map((login) => [login.toLowerCase(), login])).values()];
    const resolved = await Promise.all(uniqueLogins.map((login) => this.resolveSlackUserId(login)));
    return [...new Set(resolved.filter((value): value is string => value !== null))];
  }
}

/**
 * work通知のうちDMする種別と、次に動く人のGitHub login。
 * blocker・期限は全担当者、conflictはPR作成者へ送る。旧read modelは先頭担当者だけで代替する。
 */
function workRequiredAction(
  item: HumanWorkItem,
): { kind: NotificationRequiredActionKind; recipientLogins: string[] } | null {
  const assignees = item.assignees ?? (item.owner ? [item.owner] : []);
  switch (item.reasonCode) {
    case "BLOCKED":
      return { kind: "blocker", recipientLogins: assignees };
    case "OVERDUE":
      return { kind: "overdue", recipientLogins: assignees };
    case "DUE_TODAY":
      return { kind: "due-today", recipientLogins: assignees };
    case "CONFLICTING":
      return {
        kind: "conflict",
        recipientLogins: item.pullRequestAuthor ? [item.pullRequestAuthor] : [],
      };
    default:
      return null;
  }
}

function notificationPayloadItem(item: HumanWorkItem): HumanWorkItem {
  const {
    assignees: _assignees,
    pullRequestAuthor: _pullRequestAuthor,
    issueType: _issueType,
    parentUrl: _parentUrl,
    ...payload
  } = item;
  return payload;
}

function deadlineStage(item: HumanWorkItem, today: string, leadDays: number): DeadlineStage | null {
  if (item.status === "done" || item.delivery === "silent" || !item.owner || !item.targetDate) {
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(item.targetDate)) return null;
  const target = Date.parse(`${item.targetDate}T00:00:00Z`);
  const current = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(target) || !Number.isFinite(current)) return null;
  const remainingDays = Math.round((target - current) / DAY_MILLISECONDS);
  if (remainingDays < 0) return "overdue";
  if (remainingDays === 0) return "due-today";
  if (remainingDays <= leadDays) return "due-soon";
  return null;
}

function deadlineWorkItem(item: HumanWorkItem, stage: DeadlineStage, today: string): HumanWorkItem {
  const content: Record<
    DeadlineStage,
    Pick<HumanWorkItem, "reasonCode" | "nextAction" | "reason">
  > = {
    "due-soon": {
      reasonCode: "DUE_SOON",
      nextAction: "期限までに完了できるか確認する",
      reason: `目標日 ${item.targetDate} が近づいています。`,
    },
    "due-today": {
      reasonCode: "DUE_TODAY",
      nextAction: "今日中に完了するか、期限を見直す",
      reason: `目標日は今日（${today}）です。`,
    },
    overdue: {
      reasonCode: "OVERDUE",
      nextAction: "進捗を確認し、完了または期限変更を行う",
      reason: `目標日 ${item.targetDate} を過ぎています。`,
    },
  };
  return {
    ...item,
    delivery: "immediate",
    ...content[stage],
  };
}

function dateInTokyo(nowMilliseconds: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMilliseconds));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function workFingerprint(item: HumanWorkItem): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        reasonCode: item.reasonCode,
        status: item.status,
        owner: item.owner,
        targetDate: item.targetDate,
        nextActor: item.nextActor,
        nextAction: item.nextAction,
        reason: item.reason,
      }),
    )
    .digest("hex");
}

function compareWorkItems(left: HumanWorkItem, right: HumanWorkItem): number {
  const delivery = { immediate: 0, digest: 1, silent: 2 } as const;
  const priority = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;
  return (
    delivery[left.delivery] - delivery[right.delivery] ||
    priority[left.priority] - priority[right.priority] ||
    (left.targetDate ?? "9999-12-31").localeCompare(right.targetDate ?? "9999-12-31") ||
    left.issueNumber - right.issueNumber
  );
}

function diffDigestRecordKey(key: DiffDigestRecordKey): string {
  return `${key.date}#${key.attempt}`;
}

/**
 * 差分digestのintent ID。種別と日付で決め、同じ日に送り直す2回目以降だけ試行の番号を足す。
 * outboxは同じintentに別の中身を受け付けないため、まとめ直した投稿は別のintentにする。
 */
function diffDigestIntentId(date: string, attempt: number): string {
  return notificationIntentId(
    attempt === 1
      ? { kind: "work-diff-digest", date }
      : { kind: "work-diff-digest", date, attempt },
  );
}
