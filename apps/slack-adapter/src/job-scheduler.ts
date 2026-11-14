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
}

export const DEFAULT_SCHEDULER_TIMING: Readonly<SchedulerTiming> = {
  maxSleepMilliseconds: 10 * 60_000,
  minSleepMilliseconds: 1_000,
  claimRetryMilliseconds: 5 * 60_000,
};

const HOUR = 60 * 60_000;
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
  const runAt = jstDayStart - JST_OFFSET + cadence.hour * HOUR + cadence.minute * 60_000;
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
  status: "running" | "success" | "failed";
  startedAt: string;
  finishedAt: string | null;
  reason: string | null;
  summary: string | null;
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
 */
export class JobRunLedger {
  private readonly store: StateStore;
  private readonly owner: string;
  private readonly now: () => number;

  constructor(store: StateStore, owner: string, now: () => number = Date.now) {
    this.store = store;
    this.owner = owner;
    this.now = now;
  }

  /** 実行権を取れたら記録を返す。既に誰かが取っていればnull。storeの失敗は例外で返す。 */
  async claim(
    job: ScheduledJobName,
    window: string,
    source: JobRunSource,
  ): Promise<JobRunClaim | null> {
    const key = jobRunKey(job, window);
    const record: JobRunRecord = {
      schemaVersion: 1,
      job,
      window,
      source,
      owner: this.owner,
      status: "running",
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
      reason: null,
      summary: null,
    };
    return (await this.store.create(JOB_RUN_NAMESPACE, key, record)) ? { key, record } : null;
  }

  /** 結果を記録する。記録の失敗はログに残し、呼び出し元へは投げない。 */
  async finish(claim: JobRunClaim, outcome: ScheduledJobOutcome): Promise<void> {
    const record: JobRunRecord = {
      ...claim.record,
      status: outcome.status,
      finishedAt: new Date(this.now()).toISOString(),
      reason: outcome.status === "failed" ? outcome.reason : null,
      summary: outcome.summary ?? null,
    };
    try {
      await this.store.set(JOB_RUN_NAMESPACE, claim.key, record);
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
  timing?: SchedulerTiming;
  owner?: string;
}

/**
 * process内で定期処理を回す。
 * ジョブは直列に実行し、同時に重ならない。1つのジョブの失敗や例外は記録して次へ進み、
 * 同じ枠では再試行しない（次の枠で実行する）。
 * 起動直後は、まだ実行されていない現在の枠を実行する。日次ジョブは予定時刻まで待つ。
 */
export class JobScheduler {
  private readonly jobs: ScheduledJob[];
  private readonly clock: SchedulerClock;
  private readonly timing: SchedulerTiming;
  private readonly ledger: JobRunLedger;
  /** このprocessで実行権の判定を終えた枠。Firestoreへの問い合わせを毎回しないために持つ。 */
  private readonly settledWindow = new Map<ScheduledJobName, string>();
  /** 実行権の記録に失敗した枠で、もう一度取りに行く時刻。 */
  private readonly claimRetryAt = new Map<ScheduledJobName, { window: string; at: number }>();
  private timer: unknown = null;
  private running: Promise<void> = Promise.resolve();
  private started = false;
  private stopped = false;

  constructor(options: JobSchedulerOptions) {
    this.jobs = options.jobs;
    this.clock = options.clock ?? systemClock;
    this.timing = options.timing ?? DEFAULT_SCHEDULER_TIMING;
    this.ledger = new JobRunLedger(
      options.store,
      options.owner ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
      () => this.clock.now(),
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

  /** timerを止め、新しいジョブを始めない。実行中のジョブの終わりを待つPromiseを返す。 */
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

  private async runIfDue(job: ScheduledJob): Promise<void> {
    const now = this.clock.now();
    const window = jobWindow(job.cadence, now);
    if (now < window.runAt || this.settledWindow.get(job.name) === window.key) return;
    const retry = this.claimRetryAt.get(job.name);
    if (retry && retry.window === window.key && now < retry.at) return;

    let claim: JobRunClaim | null;
    try {
      claim = await this.ledger.claim(job.name, window.key, "inprocess");
    } catch (error) {
      this.claimRetryAt.set(job.name, {
        window: window.key,
        at: now + this.timing.claimRetryMilliseconds,
      });
      console.error(
        `定期処理 ${job.name} (${window.key}) の実行権を取れませんでした: ${errorReason(error)}`,
      );
      return;
    }
    this.claimRetryAt.delete(job.name);
    this.settledWindow.set(job.name, window.key);
    if (!claim) {
      console.log(`定期処理 ${job.name} (${window.key}) は実行済みのため見送りました。`);
      return;
    }

    const startedAt = this.clock.now();
    let outcome: ScheduledJobOutcome;
    try {
      outcome = await job.run();
    } catch (error) {
      outcome = { status: "failed", reason: errorReason(error) };
    }
    const elapsed = this.clock.now() - startedAt;
    if (outcome.status === "success") {
      console.log(
        `定期処理 ${job.name} (${window.key}) を実行しました: ${outcome.summary ?? "ok"} (${elapsed}ms)`,
      );
    } else {
      console.error(
        `定期処理 ${job.name} (${window.key}) に失敗しました: ${outcome.reason} (${elapsed}ms)`,
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
      const retry = this.claimRetryAt.get(job.name);
      const dueAt =
        this.settledWindow.get(job.name) === window.key
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
