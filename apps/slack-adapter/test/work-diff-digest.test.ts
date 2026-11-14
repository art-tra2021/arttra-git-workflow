import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnownBlock } from "@slack/web-api";
import {
  DelegatingNotificationPayloadSender,
  NotificationOutboxService,
  OutboxWorkNotifier,
} from "../src/notification-outbox.ts";
import {
  organizationProjectIssuePage,
  type ProjectIssueNode,
  projectDigestWorkItem,
} from "../src/project-read-model.ts";
import {
  diffDigestMessage,
  SLACK_BLOCK_LIMIT,
  SLACK_SECTION_TEXT_LIMIT,
  SlackWorkNotifier,
} from "../src/slack-work-notifier.ts";
import { LocalStateStore, type StateStore } from "../src/state-store.ts";
import type { HumanWorkItem } from "../src/types.ts";
import {
  type DigestSnapshot,
  parseDigestMode,
  type WorkDiffDigest,
} from "../src/work-diff-digest.ts";
import { WorkNotificationService } from "../src/work-notification-service.ts";

const REPO = "https://github.com/art-tra2021/service/issues";
// 2026-11-13 09:00 JST
const DAY1 = Date.parse("2026-11-13T00:00:00Z");
// 2026-11-14 09:00 JST
const DAY2 = Date.parse("2026-11-14T00:00:00Z");

describe("AR_DIGEST_MODE", () => {
  test("未設定はlist、listとdiffを受け付け、それ以外は拒否する", () => {
    expect(parseDigestMode(undefined)).toBe("list");
    expect(parseDigestMode("")).toBe("list");
    expect(parseDigestMode("list")).toBe("list");
    expect(parseDigestMode(" DIFF ")).toBe("diff");
    expect(() => parseDigestMode("delta")).toThrow(
      "AR_DIGEST_MODEにはlistまたはdiffを指定してください。",
    );
  });

  test("不正なモード値ではadapterの起動が失敗する", async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/start.ts")], {
      cwd: await mkdtemp(join(tmpdir(), "arttra-digest-mode-")),
      env: { PATH: process.env.PATH ?? "", AR_DIGEST_MODE: "delta" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("AR_DIGEST_MODEにはlistまたはdiffを指定してください。");
  });

  test("diffモードは差分digestを投稿できないnotifierを拒否する", async () => {
    const store = await tempStore();
    expect(
      () =>
        new WorkNotificationService(
          { loadProjectItems: async () => [] },
          store,
          { notify: async () => ({ messageTs: "1.1" }), digest: async () => {} },
          () => DAY1,
          async () => null,
          3,
          undefined,
          null,
          { digestMode: "diff" },
        ),
    ).toThrow("AR_DIGEST_MODE=diffには差分digestを投稿できるnotifierが必要です。");
  });

  test("既定のlistモードは従来どおり未完了一覧を投稿し、差分digestを使わない", async () => {
    const harness = await diffHarness([work(1)], {});
    expect(await harness.service.sendDigest()).toBe(1);
    expect(harness.listDigests).toEqual([1]);
    expect(harness.posts).toHaveLength(1);
    expect(harness.posts[0]?.text).toContain("未完了作業は1件");
  });
});

describe("差分digest", () => {
  test("初回は投稿せず、基準のスナップショットだけを保存する", async () => {
    const harness = await diffHarness([work(1), task(2, 1)]);
    expect(await harness.service.sendDiffDigest()).toEqual({
      date: "2026-11-13",
      baselineDate: null,
      outcome: "baseline-saved",
      lineCount: 0,
    });
    expect(harness.posts).toHaveLength(0);
    const snapshot = await harness.store.get<DigestSnapshot>("work-digest-snapshot", "2026-11-13");
    expect(snapshot?.items.map((item) => item.url)).toEqual([`${REPO}/1`, `${REPO}/2`]);
    expect(snapshot?.items[1]).toEqual({
      url: `${REPO}/2`,
      type: "task",
      parentUrl: `${REPO}/1`,
      title: "Task 2",
      status: "in-progress",
      owner: ["alice"],
      targetDate: "2026-11-20",
      reasonCode: "ACTIVE_WORK",
    });
  });

  test("止まり・期限超過、完了、新規、状態・担当・期限の変更、外れた項目を見分ける", async () => {
    const harness = await diffHarness([
      work(1),
      task(2, 1),
      task(3, 1, { targetDate: "2026-11-13" }),
      task(4, 1),
      task(5, 1),
      task(6, 1),
      task(7, 1),
      task(8, 1),
    ]);
    await harness.service.sendDiffDigest();

    harness.now = DAY2;
    harness.items = [
      work(1),
      task(2, 1, { status: "blocked", reasonCode: "BLOCKED" }),
      // 目標日 2026-11-13 は 11-13 時点では超過でなく、11-14 に超過になる。
      task(3, 1, { targetDate: "2026-11-13" }),
      task(4, 1, { status: "done", reasonCode: "COMPLETED", delivery: "silent" }),
      task(5, 1, { status: "in-review" }),
      task(6, 1, { owner: "bob", assignees: ["bob", "carol"] }),
      task(7, 1, { targetDate: "2026-11-30" }),
      task(9, 1),
    ];
    const result = await harness.service.sendDiffDigest();

    expect(result).toEqual({
      date: "2026-11-14",
      baselineDate: "2026-11-13",
      outcome: "posted",
      lineCount: 5,
    });
    const digest = harness.diffDigests[0];
    expect(digest?.counts).toEqual({ attention: 2, completed: 1, new: 1, changed: 3, removed: 1 });
    expect(digest?.groups).toHaveLength(1);
    const group = digest?.groups[0];
    expect(group?.title).toBe("Work 1");
    expect(group?.lines.map((line) => [line.issueNumber, line.category, line.detail])).toEqual([
      [2, "attention", "止まった、状態 進行中 → ブロック中"],
      [3, "attention", "期限超過（目標日 2026-11-13）"],
      [4, "completed", "完了"],
      [9, "new", "新規（状態 進行中、担当 alice、期限 2026-11-20）"],
      [5, "changed", "状態 進行中 → レビュー中"],
    ]);
    expect(group?.hiddenLineCount).toBe(3);

    // 隠れた行も含めて、全種類の変化を持つことを数で確かめる。
    const text = sectionTexts(harness.posts[0]?.blocks ?? []).join("\n");
    expect(text).toContain("…ほか3件");
  });

  test("担当と期限の変更、外れた項目の説明を書く", async () => {
    const harness = await diffHarness([work(1), work(2), work(3)]);
    await harness.service.sendDiffDigest();
    harness.now = DAY2;
    harness.items = [
      work(1, { owner: "bob", assignees: ["bob", "carol"] }),
      work(2, { targetDate: null }),
    ];
    await harness.service.sendDiffDigest();
    const lines = harness.diffDigests[0]?.groups.flatMap((group) =>
      group.lines.map((line) => `${line.issueNumber}:${line.category}:${line.detail}`),
    );
    expect(lines).toEqual([
      "1:changed:担当 alice → bob・carol",
      "2:changed:期限 2026-11-20 → なし",
      "3:removed:Projectから外れた",
    ]);
  });

  test("closeしたIssueは完了として扱い、Projectから外れた項目とは分ける", async () => {
    const open = projectDigestWorkItem(projectNode(10, "OPEN"), "viewer");
    const harness = await diffHarness([open, work(11)]);
    await harness.service.sendDiffDigest();
    harness.now = DAY2;
    harness.items = [projectDigestWorkItem(projectNode(10, "CLOSED"), "viewer")];
    await harness.service.sendDiffDigest();
    const lines = harness.diffDigests[0]?.groups.flatMap((group) =>
      group.lines.map((line) => `${line.issueNumber}:${line.category}`),
    );
    expect(lines).toEqual(["10:completed", "11:removed"]);
  });

  test("Project #8の取得はcloseしたIssueを差分digest用にだけ含め、親IssueのURLを読む", () => {
    const { projectItems: _open, ...openContent } = {
      ...projectNode(10, "OPEN"),
      parent: { url: `${REPO}/1` },
    };
    const { projectItems: _closed, ...closedContent } = projectNode(11, "CLOSED");
    const fieldValues = projectNode(10, "OPEN").projectItems.nodes[0]?.fieldValues ?? {
      nodes: [],
    };
    const response = {
      data: {
        organization: {
          projectV2: {
            items: {
              nodes: [
                { content: openContent, fieldValues },
                { content: closedContent, fieldValues },
                { content: null, fieldValues },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    };
    expect(organizationProjectIssuePage(response, 8).issues.map((issue) => issue.number)).toEqual([
      10,
    ]);
    const withClosed = organizationProjectIssuePage(response, 8, null, undefined, {
      includeClosed: true,
    }).issues;
    expect(withClosed.map((issue) => issue.number)).toEqual([10, 11]);
    expect(withClosed.map((issue) => projectDigestWorkItem(issue, "viewer"))).toMatchObject([
      { issueNumber: 10, status: "in-progress", issueType: "work", parentUrl: `${REPO}/1` },
      { issueNumber: 11, status: "done", reasonCode: "COMPLETED", parentUrl: null },
    ]);
  });

  test("TaskはparentUrlの親Workへまとめ、変化のないWorkは出さず、止まりのあるWorkを先に出す", async () => {
    const initial = [
      work(1),
      business(2),
      work(3),
      task(11, 1),
      task(21, 2),
      task(22, 2),
      task(31, 3),
    ];
    const harness = await diffHarness(initial);
    await harness.service.sendDiffDigest();
    harness.now = DAY2;
    harness.items = [
      work(1),
      business(2),
      work(3),
      task(11, 1, { status: "in-review" }),
      task(21, 2, { status: "done", reasonCode: "COMPLETED" }),
      task(22, 2, { status: "blocked", reasonCode: "BLOCKED" }),
      task(31, 3),
    ];
    await harness.service.sendDiffDigest();
    const groups = harness.diffDigests[0]?.groups ?? [];
    expect(groups.map((group) => [group.kind, group.title])).toEqual([
      ["business", "Business 2"],
      ["work", "Work 1"],
    ]);
    expect(groups[0]?.lines.map((line) => line.issueNumber)).toEqual([22, 21]);
  });

  test("親の分からないTaskとIntakeは「その他」にまとめ、最後に出す", async () => {
    const harness = await diffHarness([work(1)]);
    await harness.service.sendDiffDigest();
    harness.now = DAY2;
    harness.items = [
      work(1),
      task(5, null),
      intake(6),
      task(7, 99),
      task(8, 1, { status: "blocked", reasonCode: "BLOCKED" }),
    ];
    await harness.service.sendDiffDigest();
    const groups = harness.diffDigests[0]?.groups ?? [];
    expect(groups.map((group) => [group.kind, group.url, group.title])).toEqual([
      ["work", `${REPO}/1`, "Work 1"],
      // Projectに無い親でもURLは分かるため、そのIssueのブロックへまとめる。
      ["work", `${REPO}/99`, ""],
      ["other", null, "その他"],
    ]);
    expect(groups[2]?.lines.map((line) => line.issueNumber)).toEqual([5, 6]);
    const text = sectionTexts(harness.posts[0]?.blocks ?? []);
    expect(text[1]).toStartWith(`*Work: <${REPO}/99|#99>*`);
    expect(text[2]).toStartWith("*その他（親の分からないTask・Intake）*");
  });

  test("Workは10件、各ブロックは5行までにし、超えた分を「ほか n 件」にする", async () => {
    const initial = Array.from({ length: 12 }, (_, index) => work(index + 1));
    const harness = await diffHarness(initial);
    await harness.service.sendDiffDigest();
    harness.now = DAY2;
    harness.items = [
      ...initial,
      ...Array.from({ length: 7 }, (_, index) => task(100 + index, 1)),
      ...Array.from({ length: 11 }, (_, index) => task(200 + index, index + 2)),
    ];
    const result = await harness.service.sendDiffDigest();
    const digest = harness.diffDigests[0] as WorkDiffDigest;
    expect(digest.groups).toHaveLength(10);
    expect(digest.groups[0]?.lines).toHaveLength(5);
    expect(digest.groups[0]?.hiddenLineCount).toBe(2);
    expect(digest.hiddenGroupCount).toBe(2);
    expect(digest.hiddenGroupChangeCount).toBe(2);
    expect(result.lineCount).toBe(5 + 9);
    const blocks = harness.posts[0]?.blocks ?? [];
    expect(sectionTexts(blocks)[0]).toContain("…ほか2件");
    expect(JSON.stringify(blocks.at(-1))).toContain("ほか2件のWork・Businessに2件の変化があります");
  });

  test("長いタイトルが並んでもsection textは3000字、blockは50個を超えない", () => {
    const longTitle = "長".repeat(2000);
    const digest: WorkDiffDigest = {
      schemaVersion: 1,
      date: "2026-11-14",
      baselineDate: "2026-11-13",
      groups: Array.from({ length: 60 }, (_, groupIndex) => ({
        kind: "work" as const,
        url: `${REPO}/${groupIndex + 1}`,
        issueNumber: groupIndex + 1,
        title: longTitle,
        lines: Array.from({ length: 5 }, (_, lineIndex) => ({
          category: "changed" as const,
          url: `${REPO}/${1000 + lineIndex}`,
          issueNumber: 1000 + lineIndex,
          title: longTitle,
          detail: `状態 ${"x".repeat(500)}`,
        })),
        hiddenLineCount: 0,
      })),
      hiddenGroupCount: 3,
      hiddenGroupChangeCount: 9,
      counts: { attention: 0, completed: 0, new: 0, changed: 300, removed: 0 },
    };
    const message = diffDigestMessage(digest);
    expect(message.blocks.length).toBeLessThanOrEqual(SLACK_BLOCK_LIMIT);
    for (const text of sectionTexts(message.blocks)) {
      expect(text.length).toBeLessThanOrEqual(SLACK_SECTION_TEXT_LIMIT);
    }
    expect(JSON.stringify(message.blocks.at(-1))).toContain("ほか3件のWork・Business");
  });

  test("長いタイトルは1行80字で切り、通常の5行は3000字に収まる", async () => {
    const harness = await diffHarness([work(1, { title: "W".repeat(300) })]);
    await harness.service.sendDiffDigest();
    harness.now = DAY2;
    harness.items = [
      work(1, { title: "W".repeat(300) }),
      ...Array.from({ length: 5 }, (_, index) => task(10 + index, 1, { title: "T".repeat(300) })),
    ];
    await harness.service.sendDiffDigest();
    const line = harness.diffDigests[0]?.groups[0]?.lines[0];
    expect([...(line?.title ?? "")]).toHaveLength(80);
    const [text] = sectionTexts(harness.posts[0]?.blocks ?? []);
    expect(text?.length).toBeLessThanOrEqual(SLACK_SECTION_TEXT_LIMIT);
    expect(text).not.toContain("…ほか");
  });

  test("人名はmentionせずGitHub loginのまま書き、タイトルのmention記法も無効にする", async () => {
    const harness = await diffHarness([work(1)]);
    await harness.service.sendDiffDigest();
    harness.now = DAY2;
    harness.items = [
      work(1, { owner: "bob", assignees: ["bob"] }),
      task(2, 1, { title: "<!channel> 至急 <@U123> & 確認" }),
    ];
    await harness.service.sendDiffDigest();
    const post = harness.posts[0];
    const serialized = JSON.stringify(post);
    expect(serialized).not.toContain("<!channel>");
    expect(serialized).not.toContain("<@");
    expect(serialized).toContain("&lt;!channel&gt; 至急 &lt;@U123&gt; &amp; 確認");
    expect(serialized).toContain("担当 alice → bob");
    expect(harness.resolvedLogins).toEqual([]);
  });

  test("変化のない日は投稿せず、スナップショットだけを更新する", async () => {
    const harness = await diffHarness([work(1)]);
    await harness.service.sendDiffDigest();
    harness.now = DAY2;
    harness.items = [work(1, { title: "Work 1 改題" })];
    expect(await harness.service.sendDiffDigest()).toEqual({
      date: "2026-11-14",
      baselineDate: "2026-11-13",
      outcome: "no-changes",
      lineCount: 0,
    });
    expect(harness.posts).toHaveLength(0);
    const snapshot = await harness.store.get<{ items: Array<{ title: string }> }>(
      "work-digest-snapshot",
      "2026-11-14",
    );
    expect(snapshot?.items[0]?.title).toBe("Work 1 改題");
  });

  test("同じ日に再実行しても二重に投稿せず、投稿後の変化は翌日の差分へ回す", async () => {
    const harness = await diffHarness([work(1)]);
    await harness.service.sendDiffDigest();
    harness.now = DAY2;
    harness.items = [work(1, { status: "in-review" })];
    expect((await harness.service.sendDiffDigest()).outcome).toBe("posted");

    harness.now = DAY2 + 3 * 60 * 60 * 1000;
    harness.items = [work(1, { status: "in-review" }), work(2)];
    expect(await harness.service.sendDiffDigest()).toEqual({
      date: "2026-11-14",
      baselineDate: "2026-11-13",
      outcome: "already-posted",
      lineCount: 0,
    });
    expect(await harness.service.sendDigest()).toBe(0);
    expect(harness.posts).toHaveLength(1);

    // 翌日は、投稿した時点のスナップショットと比べるため #2 の新規が漏れない。
    harness.now = DAY2 + 24 * 60 * 60 * 1000;
    await harness.service.sendDiffDigest();
    expect(harness.posts).toHaveLength(2);
    expect(harness.diffDigests[1]?.groups.flatMap((group) => group.lines)).toMatchObject([
      { issueNumber: 2, category: "new" },
    ]);
  });

  test("記録後に投稿まで進まなかった実行は、同じ中身を同じintentで送り直して一度だけ投稿する", async () => {
    const harness = await diffHarness([work(1)]);
    await harness.service.sendDiffDigest();
    harness.now = DAY2;
    harness.items = [work(1, { status: "in-review" })];
    harness.failBeforeOutbox = true;
    await expect(harness.service.sendDiffDigest()).rejects.toThrow("process_stopped");
    expect(harness.posts).toHaveLength(0);

    // 送り直す前に項目が変わっても、記録した中身をそのまま送る。
    harness.items = [work(1, { status: "done", reasonCode: "COMPLETED" })];
    const retried = await harness.service.sendDiffDigest();
    expect(retried.outcome).toBe("posted");
    expect(harness.posts).toHaveLength(1);
    expect(harness.diffDigests.at(-1)?.groups[0]?.lines[0]?.detail).toBe(
      "状態 進行中 → レビュー中",
    );
    expect((await harness.service.sendDiffDigest()).outcome).toBe("already-posted");
    expect(harness.posts).toHaveLength(1);
  });

  test("一日の区切りはJSTで決める", async () => {
    // 2026-11-13 23:59 JST
    const harness = await diffHarness([work(1, { targetDate: "2026-11-13" })]);
    harness.now = Date.parse("2026-11-13T14:59:00Z");
    expect((await harness.service.sendDiffDigest()).date).toBe("2026-11-13");

    // 1分後の 2026-11-14 00:00 JST は別の日として扱い、目標日 11-13 は期限超過になる。
    harness.now = Date.parse("2026-11-13T15:00:00Z");
    const result = await harness.service.sendDiffDigest();
    expect(result).toMatchObject({
      date: "2026-11-14",
      baselineDate: "2026-11-13",
      outcome: "posted",
    });
    expect(harness.diffDigests[0]?.groups[0]?.lines[0]).toMatchObject({
      category: "attention",
      detail: "期限超過（目標日 2026-11-13）",
    });
  });

  test("差分digestのintentは既存のwork-digestと別の種別で、日付だけから決まる", async () => {
    const harness = await diffHarness([work(1)]);
    await harness.service.sendDiffDigest();
    harness.now = DAY2;
    harness.items = [work(1, { status: "in-review" })];
    await harness.service.sendDiffDigest();
    const record = await harness.store.get<{ intentId: string }>("work-diff-digest", "2026-11-14");
    const outboxStates = await harness.store.list<{ intentId: string; payload: { kind: string } }>(
      "notification-outbox",
    );
    expect(outboxStates).toHaveLength(1);
    expect(outboxStates[0]?.payload.kind).toBe("work-diff-digest");
    expect(outboxStates[0]?.intentId).toBe(record?.intentId as string);
    const { notificationIntentId } = await import("../src/notification-outbox.ts");
    expect(record?.intentId).toBe(
      notificationIntentId({ kind: "work-diff-digest", date: "2026-11-14" }),
    );
  });
});

interface PostedMessage {
  text: string;
  blocks: KnownBlock[];
  metadata?: unknown;
}

async function diffHarness(
  initial: HumanWorkItem[],
  options: { digestMode?: "list" | "diff" } = { digestMode: "diff" },
) {
  const store = await tempStore();
  const posts: PostedMessage[] = [];
  const listDigests: number[] = [];
  const diffDigests: WorkDiffDigest[] = [];
  const resolvedLogins: string[] = [];
  const harness = {
    store,
    posts,
    listDigests,
    diffDigests,
    resolvedLogins,
    items: initial,
    now: DAY1,
    failBeforeOutbox: false,
    service: null as unknown as WorkNotificationService,
  };
  const slack = new SlackWorkNotifier(
    {
      chat: {
        postMessage: async (message: PostedMessage) => {
          posts.push(message);
          return { ok: true, ts: `${posts.length}.0` };
        },
      },
    } as unknown as ConstructorParameters<typeof SlackWorkNotifier>[0],
    "CWORK",
    { direct: true },
  );
  const recording = {
    notify: slack.notify.bind(slack),
    digest: async (items: HumanWorkItem[], metadata?: Parameters<typeof slack.digest>[1]) => {
      listDigests.push(items.length);
      await slack.digest(items, metadata);
    },
    diffDigest: async (digest: WorkDiffDigest, metadata?: Parameters<typeof slack.digest>[1]) => {
      diffDigests.push(digest);
      await slack.diffDigest(digest, metadata);
    },
  };
  const outbox = new NotificationOutboxService(
    store,
    new DelegatingNotificationPayloadSender(
      { notify: async () => ({ messageTs: "x" }) },
      recording,
    ),
    {
      channelId: "CWORK",
      now: () => harness.now,
      owner: () => "worker-1",
      staleMilliseconds: 60_000,
    },
  );
  const outboxNotifier = new OutboxWorkNotifier(outbox);
  harness.service = new WorkNotificationService(
    {
      loadProjectItems: async () => harness.items,
      loadProjectDigestItems: async () => harness.items,
    },
    store,
    {
      notify: outboxNotifier.notify.bind(outboxNotifier),
      digest: outboxNotifier.digest.bind(outboxNotifier),
      diffDigest: async (digest, metadata) => {
        // 投稿記録を作った後、outboxへ渡す前にprocessが止まった場合を再現する。
        if (harness.failBeforeOutbox) {
          harness.failBeforeOutbox = false;
          throw new Error("process_stopped");
        }
        await outboxNotifier.diffDigest(digest, metadata);
      },
    },
    () => harness.now,
    async (login) => {
      resolvedLogins.push(login);
      return null;
    },
    3,
    undefined,
    null,
    { mode: "direct", ...(options.digestMode ? { digestMode: options.digestMode } : {}) },
  );
  return harness;
}

async function tempStore(): Promise<StateStore> {
  return new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-diff-digest-")));
}

function sectionTexts(blocks: KnownBlock[]): string[] {
  return blocks.flatMap((block) =>
    block.type === "section" && block.text ? [block.text.text] : [],
  );
}

function baseItem(
  number: number,
  issueType: NonNullable<HumanWorkItem["issueType"]>,
  title: string,
  parentUrl: string | null,
  overrides: Partial<HumanWorkItem>,
): HumanWorkItem {
  return {
    schemaVersion: 1,
    repository: "art-tra2021/service",
    issueNumber: number,
    title,
    url: `${REPO}/${number}`,
    status: "in-progress",
    priority: "P2",
    owner: "alice",
    assignees: ["alice"],
    targetDate: "2026-11-20",
    delivery: "digest",
    reasonCode: "ACTIVE_WORK",
    nextActor: "alice",
    nextAction: "次の完了条件を進める",
    reason: "日次一覧で確認する",
    actions: ["open-github"],
    issueType,
    parentUrl,
    ...overrides,
  };
}

function work(number: number, overrides: Partial<HumanWorkItem> = {}): HumanWorkItem {
  return baseItem(number, "work", `Work ${number}`, null, overrides);
}

function business(number: number, overrides: Partial<HumanWorkItem> = {}): HumanWorkItem {
  return baseItem(number, "business", `Business ${number}`, null, overrides);
}

function intake(number: number, overrides: Partial<HumanWorkItem> = {}): HumanWorkItem {
  return baseItem(number, "intake", `Intake ${number}`, null, { status: "triage", ...overrides });
}

function task(
  number: number,
  parent: number | null,
  overrides: Partial<HumanWorkItem> = {},
): HumanWorkItem {
  return baseItem(
    number,
    "task",
    `Task ${number}`,
    parent === null ? null : `${REPO}/${parent}`,
    overrides,
  );
}

function projectNode(number: number, state: "OPEN" | "CLOSED"): ProjectIssueNode {
  return {
    number,
    title: `Work ${number}`,
    url: `${REPO}/${number}`,
    repository: { nameWithOwner: "art-tra2021/service" },
    state,
    parent: null,
    labels: { nodes: [{ name: "type/work" }] },
    assignees: { nodes: [{ login: "alice" }] },
    projectItems: {
      nodes: [
        {
          fieldValues: {
            nodes: [{ name: "In progress", field: { name: "Status" } }],
          },
        },
      ],
    },
  };
}
