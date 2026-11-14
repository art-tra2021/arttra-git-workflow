import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_JOB_CADENCES,
  defineScheduledJobs,
  errorReason,
  JOB_RUN_NAMESPACE,
  type JobCadence,
  JobRunLedger,
  type JobRunRecord,
  JobScheduler,
  jobRunKey,
  jobWindow,
  parseSchedulerMode,
  projectCanvasSyncOutcome,
  type ScheduledJob,
  type ScheduledJobName,
  type ScheduledJobOutcome,
  type SchedulerClock,
  stopSchedulerOnSigterm,
  successOutcome,
} from "../src/job-scheduler.ts";
import { LocalStateStore, type StateStore } from "../src/state-store.ts";

const HOURLY: JobCadence = { kind: "hourly" };
const DIGEST: JobCadence = { kind: "dailyJst", hour: 9, minute: 0 };
const TIMING = {
  maxSleepMilliseconds: 10 * 60_000,
  minSleepMilliseconds: 1_000,
  claimRetryMilliseconds: 5 * 60_000,
};

class FakeClock implements SchedulerClock {
  current: number;
  private nextId = 1;
  timers: Array<{ id: number; at: number; callback: () => void }> = [];

  constructor(iso: string) {
    this.current = Date.parse(iso);
  }

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, milliseconds: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, at: this.current + milliseconds, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }

  /** targetまで時計を進め、その間に期限が来たtimerを順に発火させる。 */
  async runUntil(iso: string, schedulers: JobScheduler[]): Promise<void> {
    const target = Date.parse(iso);
    for (;;) {
      await Promise.all(schedulers.map((scheduler) => scheduler.idle()));
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer.id !== due.id);
      this.current = Math.max(this.current, due.at);
      due.callback();
    }
    this.current = Math.max(this.current, target);
  }
}

/** 実際のfile I/Oを挟む処理が条件に達するまで待つ。時計は進めない。 */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("条件に達しませんでした。");
}

async function temporaryStore(): Promise<LocalStateStore> {
  return new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-scheduler-")));
}

function countingJob(
  name: ScheduledJobName,
  cadence: JobCadence,
  runs: string[],
  clock: FakeClock,
  run: () => Promise<ScheduledJobOutcome> = async () => ({ status: "success" }),
): ScheduledJob {
  return {
    name,
    cadence,
    run: async () => {
      runs.push(`${name}@${new Date(clock.now()).toISOString()}`);
      return run();
    },
  };
}

async function record(
  store: StateStore,
  job: ScheduledJobName,
  window: string,
): Promise<JobRunRecord | null> {
  return store.get<JobRunRecord>(JOB_RUN_NAMESPACE, jobRunKey(job, window));
}

let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("AR_SCHEDULER", () => {
  test("未設定とoffはoff、inprocessは大文字小文字を問わず受け付ける", () => {
    expect(parseSchedulerMode(undefined)).toBe("off");
    expect(parseSchedulerMode(" ")).toBe("off");
    expect(parseSchedulerMode("off")).toBe("off");
    expect(parseSchedulerMode(" InProcess ")).toBe("inprocess");
  });

  test("不正値は拒否する", () => {
    expect(() => parseSchedulerMode("cron")).toThrow(
      "AR_SCHEDULERにはoffまたはinprocessを指定してください。",
    );
  });

  test("不正値ではadapterの起動が失敗する", async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/start.ts")], {
      cwd: await mkdtemp(join(tmpdir(), "arttra-scheduler-mode-")),
      env: { PATH: process.env.PATH ?? "", AR_SCHEDULER: "cloud" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("AR_SCHEDULERにはoffまたはinprocessを指定してください。");
  });
});

describe("時間枠", () => {
  test("毎時のジョブはUTCの時刻を枠にする", () => {
    expect(jobWindow(HOURLY, Date.parse("2026-11-14T03:27:10Z"))).toEqual({
      key: "2026-11-14T03Z",
      runAt: Date.parse("2026-11-14T03:00:00Z"),
      nextRunAt: Date.parse("2026-11-14T04:00:00Z"),
    });
    expect(jobWindow(HOURLY, Date.parse("2026-11-14T23:59:59.999Z")).key).toBe("2026-11-14T23Z");
    expect(jobWindow(HOURLY, Date.parse("2026-11-15T00:00:00Z")).key).toBe("2026-11-15T00Z");
  });

  test("日次のジョブはJSTの日付を枠にし、予定時刻を返す", () => {
    // JST 2026-11-14 10:00。当日の9:00は過ぎている。
    expect(jobWindow(DIGEST, Date.parse("2026-11-14T01:00:00Z"))).toEqual({
      key: "2026-11-14",
      runAt: Date.parse("2026-11-14T00:00:00Z"),
      nextRunAt: Date.parse("2026-11-15T00:00:00Z"),
    });
    // JST 2026-11-15 08:30。日付はUTCでは前日だが、JSTでは11-15の予定時刻前である。
    expect(jobWindow(DIGEST, Date.parse("2026-11-14T23:30:00Z"))).toEqual({
      key: "2026-11-15",
      runAt: Date.parse("2026-11-15T00:00:00Z"),
      nextRunAt: Date.parse("2026-11-16T00:00:00Z"),
    });
  });

  test("JSTの日付境界は15:00 UTCで切り替わる", () => {
    expect(jobWindow(DIGEST, Date.parse("2026-11-14T14:59:59.999Z")).key).toBe("2026-11-14");
    expect(jobWindow(DIGEST, Date.parse("2026-11-14T15:00:00Z")).key).toBe("2026-11-15");
    expect(jobWindow(DIGEST, Date.parse("2026-12-31T15:00:00Z")).key).toBe("2027-01-01");
    expect(
      jobWindow({ kind: "dailyJst", hour: 9, minute: 5 }, Date.parse("2026-11-14T03:00:00Z")).runAt,
    ).toBe(Date.parse("2026-11-14T00:05:00Z"));
  });

  test("既定の周期は毎時5件と、9:00と9:05の日次2件である", () => {
    expect(DEFAULT_JOB_CADENCES["work-digest"]).toEqual({ kind: "dailyJst", hour: 9, minute: 0 });
    expect(DEFAULT_JOB_CADENCES["deadline-reminders"]).toEqual({
      kind: "dailyJst",
      hour: 9,
      minute: 5,
    });
    for (const name of [
      "project-list-sync",
      "project-canvas-sync",
      "calendar-sync",
      "review-reminders",
      "issue-metadata-sync",
    ] as const) {
      expect(DEFAULT_JOB_CADENCES[name]).toEqual({ kind: "hourly" });
    }
  });
});

describe("defineScheduledJobs", () => {
  test("前提条件が無いジョブは登録せず、決まった順に並べる", () => {
    const run = async (): Promise<ScheduledJobOutcome> => ({ status: "success" });
    const jobs = defineScheduledJobs({
      "review-reminders": run,
      "calendar-sync": null,
      "project-list-sync": null,
      "issue-metadata-sync": run,
      "work-digest": run,
    });
    expect(jobs.map((job) => job.name)).toEqual([
      "work-digest",
      "issue-metadata-sync",
      "review-reminders",
    ]);
    expect(jobs[0]?.cadence).toEqual(DEFAULT_JOB_CADENCES["work-digest"]);
  });
});

describe("JobScheduler", () => {
  test("同じstate storeを使う2つのschedulerが並走しても、同じ枠は一度だけ実行する", async () => {
    const store = await temporaryStore();
    const clock = new FakeClock("2026-11-14T03:10:00Z");
    const runs: string[] = [];
    const jobs = () => [
      countingJob("issue-metadata-sync", HOURLY, runs, clock),
      countingJob("project-list-sync", HOURLY, runs, clock),
    ];
    const first = new JobScheduler({ store, jobs: jobs(), clock, timing: TIMING, owner: "a" });
    const second = new JobScheduler({ store, jobs: jobs(), clock, timing: TIMING, owner: "b" });
    first.start();
    second.start();
    await clock.runUntil("2026-11-14T03:59:00Z", [first, second]);
    expect(runs).toEqual([
      "issue-metadata-sync@2026-11-14T03:10:00.000Z",
      "project-list-sync@2026-11-14T03:10:00.000Z",
    ]);

    await clock.runUntil("2026-11-14T04:30:00Z", [first, second]);
    expect(runs.slice(2)).toEqual([
      "issue-metadata-sync@2026-11-14T04:00:00.000Z",
      "project-list-sync@2026-11-14T04:00:00.000Z",
    ]);
    const stored = await record(store, "issue-metadata-sync", "2026-11-14T04Z");
    expect(stored).toMatchObject({
      job: "issue-metadata-sync",
      window: "2026-11-14T04Z",
      source: "inprocess",
      status: "success",
      startedAt: "2026-11-14T04:00:00.000Z",
      reason: null,
    });
    expect(["a", "b"]).toContain(stored?.owner ?? "");
    await first.stop();
    await second.stop();
  });

  test("失敗したジョブは記録して次へ進み、同じ枠では再試行しない", async () => {
    const store = await temporaryStore();
    const clock = new FakeClock("2026-11-14T03:00:00Z");
    const runs: string[] = [];
    const scheduler = new JobScheduler({
      store,
      clock,
      timing: TIMING,
      jobs: [
        countingJob("issue-metadata-sync", HOURLY, runs, clock, async () => {
          throw Object.assign(new Error("GitHub APIが応答しません"), { code: "github_timeout" });
        }),
        countingJob("project-canvas-sync", HOURLY, runs, clock, async () => ({
          status: "failed",
          reason: "project_canvas_sync_failed",
          summary: "total=1 error=1",
        })),
        countingJob("review-reminders", HOURLY, runs, clock),
      ],
    });
    scheduler.start();
    await clock.runUntil("2026-11-14T03:59:00Z", [scheduler]);
    expect(runs.map((run) => run.split("@")[0])).toEqual([
      "issue-metadata-sync",
      "project-canvas-sync",
      "review-reminders",
    ]);
    expect(await record(store, "issue-metadata-sync", "2026-11-14T03Z")).toMatchObject({
      status: "failed",
      reason: "github_timeout: GitHub APIが応答しません",
    });
    expect(await record(store, "project-canvas-sync", "2026-11-14T03Z")).toMatchObject({
      status: "failed",
      reason: "project_canvas_sync_failed",
      summary: "total=1 error=1",
    });
    expect(await record(store, "review-reminders", "2026-11-14T03Z")).toMatchObject({
      status: "success",
    });
    const errors: string[] = errorSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(errors.some((line: string) => line.includes("issue-metadata-sync"))).toBe(true);
    expect(errors.some((line: string) => line.includes("project-canvas-sync"))).toBe(true);

    await clock.runUntil("2026-11-14T04:00:00Z", [scheduler]);
    expect(runs.filter((run) => run.startsWith("issue-metadata-sync"))).toEqual([
      "issue-metadata-sync@2026-11-14T03:00:00.000Z",
      "issue-metadata-sync@2026-11-14T04:00:00.000Z",
    ]);
    await scheduler.stop();
  });

  test("起動直後は未実行の枠を実行し、日次ジョブは予定時刻まで待つ", async () => {
    const store = await temporaryStore();
    // JST 08:30
    const clock = new FakeClock("2026-11-13T23:30:00Z");
    const runs: string[] = [];
    const scheduler = new JobScheduler({
      store,
      clock,
      timing: TIMING,
      jobs: [
        countingJob("work-digest", DIGEST, runs, clock),
        countingJob("deadline-reminders", { kind: "dailyJst", hour: 9, minute: 5 }, runs, clock),
        countingJob("calendar-sync", HOURLY, runs, clock),
      ],
    });
    scheduler.start();
    await clock.runUntil("2026-11-13T23:59:00Z", [scheduler]);
    expect(runs).toEqual(["calendar-sync@2026-11-13T23:30:00.000Z"]);

    await clock.runUntil("2026-11-14T00:30:00Z", [scheduler]);
    expect(runs.slice(1)).toEqual([
      "work-digest@2026-11-14T00:00:00.000Z",
      "calendar-sync@2026-11-14T00:00:00.000Z",
      "deadline-reminders@2026-11-14T00:05:00.000Z",
    ]);
    await scheduler.stop();
  });

  test("再起動後は、その日の日次ジョブを取りこぼしていれば実行し、実行済みなら実行しない", async () => {
    const store = await temporaryStore();
    // JST 11:00。前のprocessは9:00より前に止まっていた。
    const clock = new FakeClock("2026-11-14T02:00:00Z");
    const runs: string[] = [];
    const restarted = new JobScheduler({
      store,
      clock,
      timing: TIMING,
      jobs: [countingJob("work-digest", DIGEST, runs, clock)],
    });
    restarted.start();
    await clock.runUntil("2026-11-14T02:01:00Z", [restarted]);
    expect(runs).toEqual(["work-digest@2026-11-14T02:00:00.000Z"]);
    await restarted.stop();

    const again = new JobScheduler({
      store,
      clock,
      timing: TIMING,
      jobs: [countingJob("work-digest", DIGEST, runs, clock)],
    });
    again.start();
    await clock.runUntil("2026-11-14T14:00:00Z", [again]);
    expect(runs).toHaveLength(1);
    await again.stop();
  });

  test("ジョブは直列に実行し、前のジョブが終わるまで次を始めない", async () => {
    const store = await temporaryStore();
    const clock = new FakeClock("2026-11-14T03:00:00Z");
    const events: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const tracked = (name: ScheduledJobName, wait?: Promise<void>): ScheduledJob => ({
      name,
      cadence: HOURLY,
      run: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push(`start:${name}`);
        if (wait) await wait;
        events.push(`end:${name}`);
        active -= 1;
        return { status: "success" };
      },
    });
    const scheduler = new JobScheduler({
      store,
      clock,
      timing: TIMING,
      jobs: [tracked("project-list-sync", gate), tracked("calendar-sync")],
    });
    scheduler.start();
    await waitFor(() => events.length > 0);
    expect(events).toEqual(["start:project-list-sync"]);
    release();
    await scheduler.idle();
    expect(events).toEqual([
      "start:project-list-sync",
      "end:project-list-sync",
      "start:calendar-sync",
      "end:calendar-sync",
    ]);
    expect(maxActive).toBe(1);
    await scheduler.stop();
  });

  test("停止するとtimerを解除し、実行中のジョブの後のジョブを始めない", async () => {
    const store = await temporaryStore();
    const clock = new FakeClock("2026-11-14T03:00:00Z");
    const runs: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = new JobScheduler({
      store,
      clock,
      timing: TIMING,
      jobs: [
        countingJob("project-list-sync", HOURLY, runs, clock, async () => {
          await gate;
          return { status: "success" };
        }),
        countingJob("calendar-sync", HOURLY, runs, clock),
      ],
    });
    scheduler.start();
    await waitFor(() => runs.length > 0);
    const stopped = scheduler.stop();
    release();
    await stopped;
    expect(runs.map((run) => run.split("@")[0])).toEqual(["project-list-sync"]);
    expect(clock.timers).toHaveLength(0);
    await clock.runUntil("2026-11-14T06:00:00Z", [scheduler]);
    expect(runs).toHaveLength(1);
  });

  test("待機中に停止するとtimerを解除する", async () => {
    const store = await temporaryStore();
    const clock = new FakeClock("2026-11-14T03:00:00Z");
    const runs: string[] = [];
    const scheduler = new JobScheduler({
      store,
      clock,
      timing: TIMING,
      jobs: [countingJob("calendar-sync", HOURLY, runs, clock)],
    });
    scheduler.start();
    await scheduler.idle();
    expect(clock.timers).toHaveLength(1);
    await scheduler.stop();
    expect(clock.timers).toHaveLength(0);
  });

  test("実行権の記録に失敗した枠は、間を置いてもう一度実行権を取りに行く", async () => {
    const inner = await temporaryStore();
    let failures = 1;
    const store: StateStore = Object.assign(Object.create(inner) as StateStore, {
      create: async <T>(namespace: string, key: string, value: T) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("Firestore unavailable");
        }
        return inner.create(namespace, key, value);
      },
    });
    const clock = new FakeClock("2026-11-14T03:00:00Z");
    const runs: string[] = [];
    const scheduler = new JobScheduler({
      store,
      clock,
      timing: TIMING,
      jobs: [countingJob("calendar-sync", HOURLY, runs, clock)],
    });
    scheduler.start();
    await clock.runUntil("2026-11-14T03:04:00Z", [scheduler]);
    expect(runs).toHaveLength(0);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("calendar-sync");
    await clock.runUntil("2026-11-14T03:30:00Z", [scheduler]);
    expect(runs).toEqual(["calendar-sync@2026-11-14T03:05:00.000Z"]);
    await scheduler.stop();
  });
});

describe("HTTPからの実行", () => {
  test("空いている枠を記録し、schedulerは同じ枠を実行しない", async () => {
    const store = await temporaryStore();
    const clock = new FakeClock("2026-11-14T03:20:00Z");
    const ledger = new JobRunLedger(store, "http:1", () => clock.now());
    const result = await ledger.runFromHttp(
      "project-list-sync",
      HOURLY,
      async () => ({ itemCount: 4, created: 1 }),
      successOutcome,
    );
    expect(result).toEqual({ itemCount: 4, created: 1 });
    expect(await record(store, "project-list-sync", "2026-11-14T03Z")).toMatchObject({
      source: "http",
      status: "success",
      summary: "itemCount=4 created=1",
    });

    const runs: string[] = [];
    const scheduler = new JobScheduler({
      store,
      clock,
      timing: TIMING,
      jobs: [countingJob("project-list-sync", HOURLY, runs, clock)],
    });
    scheduler.start();
    await clock.runUntil("2026-11-14T03:59:00Z", [scheduler]);
    expect(runs).toHaveLength(0);
    await scheduler.stop();
  });

  test("実行済みの枠でも明示の要求として実行し、例外はそのまま返して失敗を記録する", async () => {
    const store = await temporaryStore();
    const clock = new FakeClock("2026-11-14T03:20:00Z");
    const ledger = new JobRunLedger(store, "http:1", () => clock.now());
    await expect(
      ledger.runFromHttp(
        "review-reminders",
        HOURLY,
        async () => {
          throw new Error("boom");
        },
        successOutcome,
      ),
    ).rejects.toThrow("boom");
    expect(await record(store, "review-reminders", "2026-11-14T03Z")).toMatchObject({
      status: "failed",
      reason: "boom",
    });
    expect(
      await ledger.runFromHttp("review-reminders", HOURLY, async () => 3, successOutcome),
    ).toBe(3);
    expect(await record(store, "review-reminders", "2026-11-14T03Z")).toMatchObject({
      status: "failed",
    });
  });

  test("日次ジョブの予定時刻より前の呼び出しは記録せず、その日の定期実行を止めない", async () => {
    const store = await temporaryStore();
    // JST 08:00
    const clock = new FakeClock("2026-11-13T23:00:00Z");
    const ledger = new JobRunLedger(store, "http:1", () => clock.now());
    expect(await ledger.runFromHttp("work-digest", DIGEST, async () => 2, successOutcome)).toBe(2);
    expect(await record(store, "work-digest", "2026-11-14")).toBeNull();
  });

  test("記録に失敗しても要求は実行する", async () => {
    const inner = await temporaryStore();
    const store: StateStore = Object.assign(Object.create(inner) as StateStore, {
      create: async () => {
        throw new Error("Firestore unavailable");
      },
    });
    const clock = new FakeClock("2026-11-14T03:20:00Z");
    const ledger = new JobRunLedger(store, "http:1", () => clock.now());
    expect(
      await ledger.runFromHttp("calendar-sync", HOURLY, async () => [1], successOutcome),
    ).toEqual([1]);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("calendar-sync");
  });
});

describe("結果の要約", () => {
  test("個人Canvas同期は1件でもerrorがあれば失敗とする", () => {
    const base = {
      schemaVersion: 1 as const,
      kind: "project-canvas.sync.result" as const,
      totals: { total: 2, success: 1, unchanged: 0, skipped: 0, error: 1 },
    };
    expect(
      projectCanvasSyncOutcome({
        ...base,
        results: [
          {
            stateKey: "k",
            canvasId: null,
            status: "error",
            reasonCode: "slack_rate_limited",
            retryable: true,
            itemCount: null,
          },
        ],
      }),
    ).toEqual({
      status: "failed",
      reason: "project_canvas_sync_retryable",
      summary: "total=2 success=1 unchanged=0 skipped=0 error=1",
    });
    expect(
      projectCanvasSyncOutcome({
        ...base,
        totals: { ...base.totals, error: 0 },
        results: [],
      }).status,
    ).toBe("success");
  });

  test("数値、配列、objectの数値fieldを要約する", () => {
    expect(successOutcome(3)).toEqual({ status: "success", summary: "count=3" });
    expect(successOutcome([1, 2])).toEqual({ status: "success", summary: "count=2" });
    expect(successOutcome({ listId: "L", itemCount: 2 })).toEqual({
      status: "success",
      summary: "itemCount=2",
    });
    expect(errorReason("x\n  y")).toBe("x y");
  });
});

describe("SIGTERM", () => {
  test("timerを止めてから、既定の動作へ戻すため同じsignalを送り直す", () => {
    const calls: string[] = [];
    let listener: (() => void) | null = null;
    stopSchedulerOnSigterm(
      {
        stop: async () => {
          calls.push("stop");
        },
      },
      {
        pid: 42,
        once: (_signal, callback) => {
          listener = callback;
        },
        kill: (pid, signal) => {
          calls.push(`kill:${pid}:${signal}`);
        },
      },
    );
    expect(calls).toEqual([]);
    (listener as (() => void) | null)?.();
    expect(calls).toEqual(["stop", "kill:42:SIGTERM"]);
  });
});
