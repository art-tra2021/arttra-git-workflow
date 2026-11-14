import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { ProjectCanvasSyncBatchResult } from "./project-canvas-schedule.ts";
import type { StateStore } from "./state-store.ts";

/**
 * 定期処理をprocess内で回すかどうか。
 * offはCloud Scheduler等の外部からHTTPで呼ばれる従来方式、
 * inprocessは常駐processがtimerで自分の中から呼ぶ方式。本番では常駐VMだけに設定する。
 */
export type SchedulerMode = "off" | "inprocess";

export const SCHEDULER_ENV = "AR_SCHEDULER";

/** 未設定はoff。それ以外の値は、意図しない二重実行や停止を避けるため起動時に拒否する。 */
export function parseSchedulerMode(value: string | undefined): SchedulerMode {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return "off";
  if (normalized === "off" || normalized === "inprocess") return normalized;
  throw new Error(`${SCHEDULER_ENV}にはoffまたはinprocessを指定してください。`);
}

/** 定期処理の名前。HTTPの`/internal/<name>`と同じ綴りにする。 */
export const SCHEDULED_JOB_NAMES = [
  "work-digest",
  "deadline-reminders",
  "issue-metadata-sync",
  "project-list-sync",
  "project-canvas-sync",
  "calendar-sync",
  "review-reminders",
] as const;

export type ScheduledJobName = (typeof SCHEDULED_JOB_NAMES)[number];

/**
 * 実行の周期。hourlyはUTCの毎時0分から、dailyJstはJSTの毎日hour:minuteからを1枠とする。
 * 枠ごとに一度だけ実行する。
 */
export type JobCadence = { kind: "hourly" } | { kind: "dailyJst"; hour: number; minute: number };

/** 各ジョブの周期。間隔と時刻はここだけで決め、テストでは差し替える。 */
export const DEFAULT_JOB_CADENCES: Readonly<Record<ScheduledJobName, JobCadence>> = {
  "work-digest": { kind: "dailyJst", hour: 9, minute: 0 },
  "deadline-reminders": { kind: "dailyJst", hour: 9, minute: 5 },
  "issue-metadata-sync": { kind: "hourly" },
  "project-list-sync": { kind: "hourly" },
  "project-canvas-sync": { kind: "hourly" },
  "calendar-sync": { kind: "hourly" },
  "review-reminders": { kind: "hourly" },
};

export interface SchedulerTiming {
  /** 次に起きるまでの最長の待ち時間。時計のずれやsleepからの復帰を拾い直すために上限を置く。 */
  maxSleepMilliseconds: number;
  /** 次に起きるまでの最短の待ち時間。計算の誤りで空回りしないようにする。 */
  minSleepMilliseconds: number;
  /** 実行権の記録（Firestore）に失敗したときに、同じ枠でもう一度実行権を取りに行くまでの時間。 */
  claimRetryMilliseconds: number;
  /**
   * ジョブ1回の制限時間。周期の種類ごとに決める。
   * 超えたらその枠を失敗（reason: timeout）として次のジョブへ進む。
   */
  jobTimeoutMilliseconds: Readonly<Record<JobCadence["kind"], number>>;
  /**
   * runningのままの記録を、止まった実行とみなすまでに制限時間へ足す余裕。
   * 実行中にprocessが落ちた（resetやOOM）記録を、この時間の後に奪い直して実行し直す。
   */
  staleRunGraceMilliseconds: number;
  /** 同じ枠を実行してよい回数（初回を含む）。超えたら諦めて失敗（reason: attempts-exhausted）とする。 */
  maxAttempts: number;
  /** 日次ジョブを予定時刻から遅れて実行してよい長さ。過ぎたらその日は実行しない（reason: too-late）。 */
  dailyLateLimitMilliseconds: number;
  /** 実行記録を残す長さ。記録の`expireAt`をこの分だけ先にし、FirestoreのTTL policyが消す。 */
  recordRetentionMilliseconds: number;
}

/** schedulerの時間の既定値。制限時間、奪い直し、遅延の上限、記録の保存期間はここだけで決める。 */
export const DEFAULT_SCHEDULER_TIMING: Readonly<SchedulerTiming> = {
  maxSleepMilliseconds: 10 * 60_000,
  minSleepMilliseconds: 1_000,
  claimRetryMilliseconds: 5 * 60_000,
  jobTimeoutMilliseconds: { hourly: 10 * 60_000, dailyJst: 15 * 60_000 },
  staleRunGraceMilliseconds: 5 * 60_000,
  maxAttempts: 3,
  dailyLateLimitMilliseconds: 3 * 60 * 60_000,
  recordRetentionMilliseconds: 30 * 24 * 60 * 60_000,
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const JST_OFFSET = 9 * HOUR;

export interface JobWindow {
  /** 枠を表すkey。hourlyは`2026-11-14T03Z`（UTC）、dailyJstは`2026-11-14`（JSTの日付）。 */
  key: string;
  /** この枠で実行を始めてよい最初の時刻（epoch ms）。 */
  runAt: number;
  /** 次の枠の実行時刻（epoch ms）。 */
  nextRunAt: number;
}

/** nowを含む枠を返す。dailyJstは予定時刻より前でも、その日の枠（まだ実行時刻前）を返す。 */
export function jobWindow(cadence: JobCadence, now: number): JobWindow {
  if (cadence.kind === "hourly") {
    const start = Math.floor(now / HOUR) * HOUR;
    return {
      key: `${new Date(start).toISOString().slice(0, 13)}Z`,
      runAt: start,
      nextRunAt: start + HOUR,
    };
  }
  const jstDayStart = Math.floor((now + JST_OFFSET) / DAY) * DAY;
  const runAt = jstDayStart - JST_OFFSET + cadence.hour * HOUR + cadence.minute * MINUTE;
  return {
    key: new Date(jstDayStart).toISOString().slice(0, 10),
    runAt,
    nextRunAt: runAt + DAY,
  };
}

export type ScheduledJobOutcome =
  | { status: "success"; summary?: string }
  | { status: "failed"; reason: string; summary?: string };

export interface ScheduledJob {
  name: ScheduledJobName;
  cadence: JobCadence;
  run: () => Promise<ScheduledJobOutcome>;
}

/**
 * 実行できるジョブだけを、決まった順に並べる。
 * 前提条件（channel、Google Calendar設定、GitHub App等）が無いジョブはnullで渡し、登録しない。
 */
export function defineScheduledJobs(
  runners: Partial<Record<ScheduledJobName, (() => Promise<ScheduledJobOutcome>) | null>>,
  cadences: Readonly<Record<ScheduledJobName, JobCadence>> = DEFAULT_JOB_CADENCES,
): ScheduledJob[] {
  return SCHEDULED_JOB_NAMES.flatMap((name) => {
    const run = runners[name];
    return run ? [{ name, cadence: cadences[name], run }] : [];
  });
}

export type JobRunSource = "inprocess" | "http";

/** 実行権の記録。Firestoreでは`<prefix>_scheduled_job_run`へ、ジョブ名と枠のkeyで1件ずつ置く。 */
export interface JobRunRecord {
  schemaVersion: 1;
  job: ScheduledJobName;
  window: string;
  source: JobRunSource;
  owner: string;
  /** skippedは、実行せずに見送った枠（日次ジョブの予定時刻から遅れすぎたときなど）。 */
  status: "running" | "success" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string | null;
  reason: string | null;
  summary: string | null;
  /** 書き換えるたびに1増やす。compareAndSetで、他のprocessの書き換えと重ならないようにする。 */
  revision: number;
  /** この枠を実行し始めた回数。奪い直すたびに1増やす。見送った記録は0。 */
  attempt: number;
  /** 記録を消してよい時刻（UTC）。Firestoreではdocumentの最上位にもDate型で置き、TTL policyが見る。 */
  expireAt: string;
}

export const JOB_RUN_NAMESPACE = "scheduled-job-run";

export function jobRunKey(job: ScheduledJobName, window: string): string {
  return `${job}:${window}`;
}

export interface JobRunClaim {
  key: string;
  record: JobRunRecord;
}

/**
 * ジョブ名と枠ごとの実行権を、state storeの原子的なcreateで取る。
 * 先に作れたprocessだけが実行し、再起動、二重起動、HTTP経由の実行と重なっても同じ枠は一度だけになる。
 * 作った後の書き換え（結果、奪い直し）はrevisionを使うcompareAndSetで行い、他のprocessの書き換えを上書きしない。
 */
export class JobRunLedger {
  private readonly store: StateStore;
  private readonly owner: string;
  private readonly now: () => number;
  private readonly retentionMilliseconds: number;

  constructor(
    store: StateStore,
    owner: string,
    now: () => number = Date.now,
    retentionMilliseconds: number = DEFAULT_SCHEDULER_TIMING.recordRetentionMilliseconds,
  ) {
    this.store = store;
    this.owner = owner;
    this.now = now;
    this.retentionMilliseconds = retentionMilliseconds;
  }

  /** 実行権を取れたら記録を返す。既に誰かが取っていればnull。storeの失敗は例外で返す。 */
  async claim(
    job: ScheduledJobName,
    window: string,
    source: JobRunSource,
  ): Promise<JobRunClaim | null> {
    const key = jobRunKey(job, window);
    const { now, expireAt } = this.stamp();
    const record: JobRunRecord = {
      schemaVersion: 1,
      job,
      window,
      source,
      owner: this.owner,
      status: "running",
      startedAt: now,
      finishedAt: null,
      reason: null,
      summary: null,
      revision: 1,
      attempt: 1,
      expireAt: expireAt.toISOString(),
    };
    return (await this.store.create(JOB_RUN_NAMESPACE, key, record, { expireAt }))
      ? { key, record }
      : null;
  }

  /** 実行せずに見送った枠として記録する。既に記録があればfalse。storeの失敗は例外で返す。 */
  async skip(
    job: ScheduledJobName,
    window: string,
    source: JobRunSource,
    reason: string,
  ): Promise<boolean> {
    const { now, expireAt } = this.stamp();
    const record: JobRunRecord = {
      schemaVersion: 1,
      job,
      window,
      source,
      owner: this.owner,
      status: "skipped",
      startedAt: now,
      finishedAt: now,
      reason,
      summary: null,
      revision: 1,
      attempt: 0,
      expireAt: expireAt.toISOString(),
    };
    return this.store.create(JOB_RUN_NAMESPACE, jobRunKey(job, window), record, { expireAt });
  }

  /** 枠の記録を読む。storeの失敗は例外で返す。 */
  async read(job: ScheduledJobName, window: string): Promise<JobRunRecord | null> {
    return this.store.get<JobRunRecord>(JOB_RUN_NAMESPACE, jobRunKey(job, window));
  }

  /**
   * runningのまま止まった記録を奪い直し、自分の実行として始め直す。
   * 他のprocessが先に書き換えていればnull。storeの失敗は例外で返す。
   */
  async reclaim(previous: JobRunRecord, source: JobRunSource): Promise<JobRunClaim | null> {
    const key = jobRunKey(previous.job, previous.window);
    const { now, expireAt } = this.stamp();
    const record: JobRunRecord = {
      ...previous,
      source,
      owner: this.owner,
      status: "running",
      startedAt: now,
      finishedAt: null,
      reason: null,
      summary: null,
      revision: previous.revision + 1,
      attempt: previous.attempt + 1,
      expireAt: expireAt.toISOString(),
    };
    return (await this.store.compareAndSet(JOB_RUN_NAMESPACE, key, previous.revision, record, {
      expireAt,
    }))
      ? { key, record }
      : null;
  }

  /**
   * runningのまま止まった記録を、実行し直さずに終わらせる。
   * 他のprocessが先に書き換えていればfalse。storeの失敗は例外で返す。
   */
  async abandon(
    previous: JobRunRecord,
    status: "failed" | "skipped",
    reason: string,
  ): Promise<boolean> {
    const { now, expireAt } = this.stamp();
    const record: JobRunRecord = {
      ...previous,
      status,
      finishedAt: now,
      reason,
      revision: previous.revision + 1,
      expireAt: expireAt.toISOString(),
    };
    return this.store.compareAndSet(
      JOB_RUN_NAMESPACE,
      jobRunKey(previous.job, previous.window),
      previous.revision,
      record,
      { expireAt },
    );
  }

  /**
   * 結果を記録する。記録の失敗はログに残し、呼び出し元へは投げない。
   * 実行の間に他のprocessが奪い直していれば、その記録を上書きしない。
   */
  async finish(claim: JobRunClaim, outcome: ScheduledJobOutcome): Promise<void> {
    const { now, expireAt } = this.stamp();
    const record: JobRunRecord = {
      ...claim.record,
      status: outcome.status,
      finishedAt: now,
      reason: outcome.status === "failed" ? outcome.reason : null,
      summary: outcome.summary ?? null,
      revision: claim.record.revision + 1,
      expireAt: expireAt.toISOString(),
    };
    try {
      const written = await this.store.compareAndSet(
        JOB_RUN_NAMESPACE,
        claim.key,
        claim.record.revision,
        record,
        { expireAt },
      );
      if (!written) {
        console.warn(
          `定期処理 ${claim.record.job} (${claim.record.window}) の結果を記録しませんでした。記録が別の実行に引き継がれています。`,
        );
      }
    } catch (error) {
      console.error(
        `定期処理 ${claim.record.job} (${claim.record.window}) の結果を記録できませんでした: ${errorReason(error)}`,
      );
    }
  }

  /**
   * HTTPの`/internal/*`から実行するときの記録。応答の中身と例外はそのまま返す。
   * 枠が空いていれば実行権を記録し、in-process schedulerが同じ枠をもう一度実行しないようにする。
   * 既に実行済みの枠でも、明示の要求なので従来どおり実行する。
   * 日次ジョブの予定時刻より前の呼び出しは、その日の定期実行を止めないよう記録しない。
   */
  async runFromHttp<T>(
    job: ScheduledJobName,
    cadence: JobCadence,
    run: () => Promise<T>,
    outcome: (result: T) => ScheduledJobOutcome,
  ): Promise<T> {
    const now = this.now();
    const window = jobWindow(cadence, now);
    let claim: JobRunClaim | null = null;
    if (now >= window.runAt) {
      try {
        claim = await this.claim(job, window.key, "http");
      } catch (error) {
        console.warn(
          `定期処理 ${job} (${window.key}) の実行権を記録できませんでした: ${errorReason(error)}`,
        );
      }
    }
    try {
      const result = await run();
      if (claim) await this.finish(claim, outcome(result));
      return result;
    } catch (error) {
      if (claim) await this.finish(claim, { status: "failed", reason: errorReason(error) });
      throw error;
    }
  }

  private stamp(): { now: string; expireAt: Date } {
    const now = this.now();
    return {
      now: new Date(now).toISOString(),
      expireAt: new Date(now + this.retentionMilliseconds),
    };
  }
}

export interface SchedulerClock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => {
    const handle = setTimeout(callback, milliseconds);
    // timerだけでprocessを生かし続けない。Slack接続やHTTP serverがprocessを保つ。
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface JobSchedulerOptions {
  store: StateStore;
  jobs: ScheduledJob[];
  clock?: SchedulerClock;
  /** 指定しなかった値はDEFAULT_SCHEDULER_TIMINGを使う。 */
  timing?: Partial<SchedulerTiming>;
  owner?: string;
}

/**
 * process内で定期処理を回す。
 * ジョブは直列に実行し、同時に重ならない。1つのジョブの失敗や例外は記録して次へ進み、
 * 同じ枠では再試行しない（次の枠で実行する）。
 * ジョブが制限時間を過ぎても終わらなければ、その枠を失敗として次へ進む。
 * Promiseは止められないため、終わっていない間は同じジョブを新しく始めない。
 * 起動直後は、まだ実行されていない現在の枠を実行する。日次ジョブは予定時刻まで待ち、
 * 予定時刻から遅れすぎた日は実行しない。
 * 実行中にprocessが落ちてrunningのまま残った枠は、制限時間と余裕を過ぎた後に奪い直して実行し直す。
 */
export class JobScheduler {
  private readonly jobs: ScheduledJob[];
  private readonly clock: SchedulerClock;
  private readonly timing: SchedulerTiming;
  private readonly ledger: JobRunLedger;
  /** このprocessで判定を終えた枠。Firestoreへの問い合わせを毎回しないために持つ。 */
  private readonly settledWindow = new Map<ScheduledJobName, string>();
  /** 同じ枠をもう一度確かめる時刻。記録に失敗したときと、他の実行がrunningのときに置く。 */
  private readonly retryAt = new Map<ScheduledJobName, { window: string; at: number }>();
  /** 制限時間を過ぎてもまだ終わっていないジョブと、その実行の枠。 */
  private readonly hungRun = new Map<ScheduledJobName, string>();
  /** hungRunのために見送ったことをログに出した枠。同じ枠で何度も出さない。 */
  private readonly hungNotice = new Map<ScheduledJobName, string>();
  private timer: unknown = null;
  private running: Promise<void> = Promise.resolve();
  private started = false;
  private stopped = false;

  constructor(options: JobSchedulerOptions) {
    this.jobs = options.jobs;
    this.clock = options.clock ?? systemClock;
    this.timing = { ...DEFAULT_SCHEDULER_TIMING, ...options.timing };
    this.ledger = new JobRunLedger(
      options.store,
      options.owner ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
      () => this.clock.now(),
      this.timing.recordRetentionMilliseconds,
    );
  }

  get jobNames(): ScheduledJobName[] {
    return this.jobs.map((job) => job.name);
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.runTick();
  }

  /**
   * timerを止め、新しいジョブを始めない。実行中のジョブの終わりを待つPromiseを返す。
   * ジョブが終わらなくても、制限時間を過ぎれば解決する。
   */
  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    return this.running;
  }

  /** 実行中のtickが終わるまで待つ。テストで使う。 */
  idle(): Promise<void> {
    return this.running;
  }

  private runTick(): void {
    this.timer = null;
    this.running = this.tick()
      .catch((error) => {
        // tickの中で個別に捕まえているので、ここへ来るのは想定外の不具合だけ。
        console.error(`定期処理のschedulerで想定外のエラーが起きました: ${errorReason(error)}`);
      })
      .then(() => this.scheduleNext());
  }

  private async tick(): Promise<void> {
    for (const job of this.jobs) {
      if (this.stopped) return;
      await this.runIfDue(job);
    }
  }

  private timeoutOf(job: ScheduledJob): number {
    return this.timing.jobTimeoutMilliseconds[job.cadence.kind];
  }

  private async runIfDue(job: ScheduledJob): Promise<void> {
    const now = this.clock.now();
    const window = jobWindow(job.cadence, now);
    if (now < window.runAt || this.settledWindow.get(job.name) === window.key) return;
    const retry = this.retryAt.get(job.name);
    if (retry && retry.window === window.key && now < retry.at) return;
    const hungWindow = this.hungRun.get(job.name);
    if (hungWindow !== undefined) {
      if (this.hungNotice.get(job.name) !== window.key) {
        this.hungNotice.set(job.name, window.key);
        console.warn(
          `定期処理 ${job.name} (${window.key}) は、制限時間を過ぎた前の実行（${hungWindow}）がまだ終わっていないため見送りました。`,
        );
      }
      return;
    }

    let claim: JobRunClaim | null;
    try {
      claim = await this.acquire(job, window, now);
    } catch (error) {
      this.retryAt.set(job.name, {
        window: window.key,
        at: now + this.timing.claimRetryMilliseconds,
      });
      console.error(
        `定期処理 ${job.name} (${window.key}) の実行権を取れませんでした: ${errorReason(error)}`,
      );
      return;
    }
    if (claim) await this.execute(job, window.key, claim);
  }

  /**
   * 枠の実行権を取る。取れなければ、理由をログに残してnullを返す。
   * 日次ジョブが予定時刻から遅れすぎていれば、実行せずskippedとして記録する。
   * runningのまま止まった記録は、試行回数の上限までは奪い直す。
   */
  private async acquire(
    job: ScheduledJob,
    window: JobWindow,
    now: number,
  ): Promise<JobRunClaim | null> {
    const tooLate =
      job.cadence.kind === "dailyJst" &&
      now >= window.runAt + this.timing.dailyLateLimitMilliseconds;
    const lateHours = this.timing.dailyLateLimitMilliseconds / HOUR;
    if (tooLate) {
      const skipped = await this.ledger.skip(job.name, window.key, "inprocess", "too-late");
      this.retryAt.delete(job.name);
      if (skipped) {
        this.settledWindow.set(job.name, window.key);
        console.warn(
          `定期処理 ${job.name} (${window.key}) は予定時刻から${lateHours}時間を過ぎたため、この日は実行しません。`,
        );
        return null;
      }
    } else {
      const claim = await this.ledger.claim(job.name, window.key, "inprocess");
      this.retryAt.delete(job.name);
      if (claim) {
        this.settledWindow.set(job.name, window.key);
        return claim;
      }
    }

    const existing = await this.ledger.read(job.name, window.key);
    if (existing?.status !== "running") {
      this.settledWindow.set(job.name, window.key);
      console.log(`定期処理 ${job.name} (${window.key}) は実行済みのため見送りました。`);
      return null;
    }
    const staleMilliseconds = this.timeoutOf(job) + this.timing.staleRunGraceMilliseconds;
    const staleAt = Date.parse(existing.startedAt) + staleMilliseconds;
    if (now < staleAt) {
      this.retryAt.set(job.name, { window: window.key, at: staleAt });
      console.log(
        `定期処理 ${job.name} (${window.key}) は別の実行（${existing.owner}）が実行中のため見送りました。${new Date(staleAt).toISOString()}に確かめ直します。`,
      );
      return null;
    }

    const attempt = existing.attempt;
    const abandonReason = tooLate
      ? "too-late"
      : attempt >= this.timing.maxAttempts
        ? "attempts-exhausted"
        : null;
    if (abandonReason) {
      const status = tooLate ? "skipped" : "failed";
      if (await this.ledger.abandon(existing, status, abandonReason)) {
        this.settledWindow.set(job.name, window.key);
        const message = tooLate
          ? `定期処理 ${job.name} (${window.key}) は${existing.startedAt}からrunningのまま止まっており、予定時刻から${lateHours}時間を過ぎたため、この日は実行しません。`
          : `定期処理 ${job.name} (${window.key}) は${attempt}回実行しても終わらなかったため、諦めて失敗にしました。`;
        if (tooLate) console.warn(message);
        else console.error(message);
      } else {
        this.retryAt.set(job.name, { window: window.key, at: now + staleMilliseconds });
        console.log(
          `定期処理 ${job.name} (${window.key}) は別のprocessが先に記録を更新したため見送りました。`,
        );
      }
      return null;
    }

    const reclaimed = await this.ledger.reclaim(existing, "inprocess");
    if (!reclaimed) {
      this.retryAt.set(job.name, { window: window.key, at: now + staleMilliseconds });
      console.log(
        `定期処理 ${job.name} (${window.key}) は別のprocessが先に記録を更新したため見送りました。`,
      );
      return null;
    }
    this.settledWindow.set(job.name, window.key);
    console.warn(
      `定期処理 ${job.name} (${window.key}) は${existing.startedAt}からrunningのまま止まっているため、実行し直します（${reclaimed.record.attempt}回目）。`,
    );
    return reclaimed;
  }

  private async execute(job: ScheduledJob, window: string, claim: JobRunClaim): Promise<void> {
    const startedAt = this.clock.now();
    const timeout = this.timeoutOf(job);
    const run = invoke(job);
    let timer: unknown = null;
    const expired = new Promise<null>((resolve) => {
      timer = this.clock.setTimeout(() => resolve(null), timeout);
    });
    const outcome = await Promise.race([run, expired]);
    this.clock.clearTimeout(timer);
    const elapsed = this.clock.now() - startedAt;

    if (outcome === null) {
      this.hungRun.set(job.name, window);
      void run.then((late) => {
        this.hungRun.delete(job.name);
        this.hungNotice.delete(job.name);
        console.log(
          `定期処理 ${job.name} (${window}) の、制限時間を過ぎた実行が終わりました: ${describeOutcome(late)} (${this.clock.now() - startedAt}ms)`,
        );
      });
      console.error(
        `定期処理 ${job.name} (${window}) が制限時間（${timeout / MINUTE}分）を過ぎても終わらないため、失敗として次へ進みます。`,
      );
      await this.ledger.finish(claim, { status: "failed", reason: "timeout" });
      return;
    }
    if (outcome.status === "success") {
      console.log(
        `定期処理 ${job.name} (${window}) を実行しました: ${outcome.summary ?? "ok"} (${elapsed}ms)`,
      );
    } else {
      console.error(
        `定期処理 ${job.name} (${window}) に失敗しました: ${outcome.reason} (${elapsed}ms)`,
      );
    }
    await this.ledger.finish(claim, outcome);
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const now = this.clock.now();
    let wakeAt = now + this.timing.maxSleepMilliseconds;
    for (const job of this.jobs) {
      const window = jobWindow(job.cadence, now);
      const settled = this.settledWindow.get(job.name) === window.key;
      // 終わっていない実行がある間は、その終わりを最長の待ち時間ごとに確かめる。
      if (!settled && this.hungRun.has(job.name)) continue;
      const retry = this.retryAt.get(job.name);
      const dueAt = settled
        ? window.nextRunAt
        : retry && retry.window === window.key
          ? retry.at
          : window.runAt;
      wakeAt = Math.min(wakeAt, dueAt);
    }
    const delay = Math.max(this.timing.minSleepMilliseconds, wakeAt - now);
    this.timer = this.clock.setTimeout(() => this.runTick(), delay);
  }
}

/** ジョブを呼び、例外は失敗の結果に直す。返すPromiseはrejectしない。 */
function invoke(job: ScheduledJob): Promise<ScheduledJobOutcome> {
  const failed = (error: unknown): ScheduledJobOutcome => ({
    status: "failed",
    reason: errorReason(error),
  });
  try {
    return job.run().catch(failed);
  } catch (error) {
    return Promise.resolve(failed(error));
  }
}

function describeOutcome(outcome: ScheduledJobOutcome): string {
  return outcome.status === "success" ? (outcome.summary ?? "ok") : `失敗 ${outcome.reason}`;
}

interface SignalTarget {
  once(signal: "SIGTERM", listener: () => void): unknown;
  kill(pid: number, signal: "SIGTERM"): unknown;
  pid: number;
}

/**
 * SIGTERMでschedulerのtimerを止める。
 * listenerを置くとnodeの既定の終了が無効になるため、止めた後に同じsignalを自分へ送り直し、
 * 既定の動作（PID 1でなければ終了、containerのPID 1なら無視してSIGKILLを待つ）へ戻す。
 */
export function stopSchedulerOnSigterm(
  scheduler: Pick<JobScheduler, "stop">,
  target: SignalTarget = process,
): void {
  target.once("SIGTERM", () => {
    void scheduler.stop();
    console.log("SIGTERMを受けたため、定期処理のtimerを止めました。");
    target.kill(target.pid, "SIGTERM");
  });
}

/** 結果の数値だけを短い要約にして成功とする。配列は件数、数値はそのまま書く。 */
export function successOutcome(result: unknown): ScheduledJobOutcome {
  return { status: "success", summary: summarizeResult(result) };
}

/** 個人Canvas同期は、1件でもerrorがあればその枠を失敗とする。HTTPの500/429と同じ判定である。 */
export function projectCanvasSyncOutcome(
  result: ProjectCanvasSyncBatchResult,
): ScheduledJobOutcome {
  const { total, success, unchanged, skipped, error } = result.totals;
  const summary = `total=${total} success=${success} unchanged=${unchanged} skipped=${skipped} error=${error}`;
  if (error === 0) return { status: "success", summary };
  const retryable = result.results.some((item) => item.status === "error" && item.retryable);
  return {
    status: "failed",
    reason: retryable ? "project_canvas_sync_retryable" : "project_canvas_sync_failed",
    summary,
  };
}

function summarizeResult(result: unknown): string {
  if (typeof result === "number") return `count=${result}`;
  if (Array.isArray(result)) return `count=${result.length}`;
  if (result && typeof result === "object") {
    const fields = Object.entries(result).filter(([, value]) => typeof value === "number");
    if (fields.length > 0) return fields.map(([key, value]) => `${key}=${value}`).join(" ");
  }
  return "ok";
}

/** 失敗理由を短い1行にする。codeを持つエラーはcodeを先頭に置く。 */
export function errorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : null;
  const reason = code && !message.startsWith(code) ? `${code}: ${message}` : message;
  return reason.replace(/\s+/g, " ").trim().slice(0, 500) || "unknown_error";
}
