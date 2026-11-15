import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIssueCreateInput } from "../src/github-shared.ts";
import { issueTemplate } from "../src/issue-schema.ts";
import type { ProjectFieldInput, ProjectFieldSyncResult } from "../src/project-field-sync.ts";
import {
  encodeItemKey,
  type ReqaddInputSubmission,
  type ReqaddProjectItem,
  type ReqaddRequest,
} from "../src/reqadd.ts";
import {
  REQADD_REQUEST_NAMESPACE,
  type ReqaddGitHub,
  type ReqaddIdentity,
  ReqaddService,
  type ReqaddSlackClient,
} from "../src/reqadd-service.ts";
import { LocalStateStore } from "../src/state-store.ts";
import type { CreatedIssue, CreateIssueCommand } from "../src/types.ts";

const FALLBACK = "https://github.com/art-tra2021/ops/issues/1";
const WORK_URL = "https://github.com/art-tra2021/repo/issues/10";

interface PostedMessage {
  channel: string;
  text: string;
  blocks?: unknown[];
  thread_ts?: string;
}

class FakeSlack implements ReqaddSlackClient {
  readonly posts: PostedMessage[] = [];
  readonly updates: Array<{ channel: string; ts: string; text: string; blocks?: unknown[] }> = [];
  readonly ephemerals: Array<{ channel: string; user: string; text: string }> = [];
  readonly names: Record<string, string>;
  private sequence = 0;

  constructor(names: Record<string, string>) {
    this.names = names;
  }

  chat = {
    postMessage: async (message: PostedMessage) => {
      this.posts.push(message);
      this.sequence += 1;
      return { ts: `100.${this.sequence}`, channel: message.channel };
    },
    update: async (message: { channel: string; ts: string; text: string; blocks?: unknown[] }) => {
      this.updates.push(message);
      return {};
    },
    postEphemeral: async (message: { channel: string; user: string; text: string }) => {
      this.ephemerals.push(message);
      return {};
    },
  };

  conversations = {
    open: async (input: { users: string }) => ({ channel: { id: `D${input.users}` } }),
  };

  users = {
    info: async (input: { user: string }) => ({
      user: { profile: { display_name: this.names[input.user] ?? "" }, name: input.user },
    }),
  };

  dms(slackUserId: string): PostedMessage[] {
    return this.posts.filter((post) => post.channel === `D${slackUserId}`);
  }

  threadReplies(): PostedMessage[] {
    return this.posts.filter((post) => post.thread_ts);
  }
}

class FakeGitHub implements ReqaddGitHub {
  items: ReqaddProjectItem[];
  readonly updates: Array<{ issueNodeId: string; values: ProjectFieldInput }> = [];
  readonly created: CreateIssueCommand[] = [];
  private nextNumber = 500;

  constructor(items: ReqaddProjectItem[]) {
    this.items = items;
  }

  async listReqaddProjectItems() {
    return this.items;
  }

  async updateProjectItemFields(input: {
    issueNodeId: string;
    issueUrl: string;
    values: ProjectFieldInput;
  }): Promise<ProjectFieldSyncResult> {
    this.updates.push({ issueNodeId: input.issueNodeId, values: input.values });
    return {
      schemaVersion: 1,
      status: "synced",
      project: { owner: "art-tra2021", number: 8, id: "P", itemId: "PI" },
      issue: { id: input.issueNodeId, url: input.issueUrl },
      itemCreated: false,
      fields: [],
      recovery: {
        retryable: true,
        operation: "project-field-sync",
        issueUrl: input.issueUrl,
        instructions: [],
      },
    };
  }

  async createIssue(command: CreateIssueCommand): Promise<CreatedIssue> {
    // 並行した送信が同時に作成へ進むかを確かめられるよう、一度処理を譲る。
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.created.push(command);
    this.nextNumber += 1;
    return {
      number: this.nextNumber,
      title: `[Task] ${command.title}`,
      url: `https://github.com/${command.repository}/issues/${this.nextNumber}`,
    };
  }

  async listIssueTemplatesForViewer() {
    return [issueTemplate("task")];
  }
}

class FakeIdentity implements ReqaddIdentity {
  readonly logins: Record<string, string>;

  constructor(logins: Record<string, string>) {
    this.logins = logins;
  }

  async get(_teamId: string, slackUserId: string) {
    const login = this.logins[slackUserId];
    return login ? { githubLogin: login } : null;
  }

  async resolveCommand(command: CreateIssueCommand) {
    return {
      ...command,
      requesterGitHubUser: { id: 1, login: this.logins[command.actor] ?? "" },
      assigneeGitHubLogins: (command.assigneeSlackUserIds ?? []).map((id) => this.logins[id] ?? ""),
      reviewerGitHubLogins: [],
      reviewerGitHubUsers: [],
    };
  }
}

class Clock {
  value: number;
  constructor(iso: string) {
    this.value = Date.parse(iso);
  }
  set(iso: string) {
    this.value = Date.parse(iso);
  }
}

async function setup(options: { fallback?: string | null; requesterIds?: string[] } = {}) {
  const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-reqadd-")));
  const slack = new FakeSlack({ UBOSS: "社長", U0A1: "佐藤", U0B1: "鈴木 <@UX>", U0C1: "田中" });
  const github = new FakeGitHub([
    item(1, { assignees: ["alice"], status: "In progress", targetDate: "2026-11-18" }),
    item(2, { assignees: ["alice"], status: "Ready" }),
    item(3, { assignees: ["bob"], status: "Ready" }),
    item(10, { type: "work", assignees: ["bob"] }),
  ]);
  const identity = new FakeIdentity({ U0A1: "alice", U0B1: "bob" });
  const clock = new Clock("2026-11-16T01:00:00Z");
  let ids = 0;
  const service = new ReqaddService({
    store,
    slack,
    github,
    identity,
    requesterIds: options.requesterIds ?? ["UBOSS"],
    fallbackParentUrl: options.fallback === undefined ? FALLBACK : options.fallback,
    now: () => clock.value,
    id: () => `req-${++ids}`,
  });
  return { store, slack, github, identity, clock, service };
}

async function createRequest(
  context: Awaited<ReturnType<typeof setup>>,
  recipients = ["U0A1", "U0B1", "U0C1"],
  dueDate = "2026-11-20",
) {
  return context.service.createRequest({
    slackTeamId: "T1",
    requesterSlackUserId: "UBOSS",
    channelId: "C123",
    request: { recipients, dueDate, note: "今週の仕事を入れてください" },
  });
}

function submission(overrides: Partial<ReqaddInputSubmission> = {}): ReqaddInputSubmission {
  return { changes: [], newRows: [], ...overrides };
}

describe("ReqaddService: 依頼", () => {
  test("依頼者だけが使え、使えない人には理由を返す", async () => {
    const { service } = await setup();
    expect(service.requesterDenialReason("UBOSS")).toBeNull();
    expect(service.requesterDenialReason("U0A1")).toContain("依頼する役の人だけ");
    const empty = await setup({ requesterIds: [] });
    expect(empty.service.requesterDenialReason("UBOSS")).toContain("設定されていません");
    await expect(
      service.createRequest({
        slackTeamId: "T1",
        requesterSlackUserId: "U0A1",
        channelId: "C123",
        request: { recipients: ["U0B1"], dueDate: "2026-11-20", note: "" },
      }),
    ).rejects.toThrow("依頼する役の人だけ");
  });

  test("記録を作り、mentionなしの親投稿を1件出し、相手ごとにDMを送る", async () => {
    const context = await setup();
    const record = await createRequest(context);
    const stored = await context.store.get<ReqaddRequest>(REQADD_REQUEST_NAMESPACE, "req-1");
    expect(stored).toMatchObject({
      requestId: "req-1",
      requesterSlackUserId: "UBOSS",
      requesterName: "社長",
      channelId: "C123",
      messageTs: "100.1",
      dueDate: "2026-11-20",
      revision: 2,
    });
    expect(
      record.recipients.map((item) => [item.slackUserId, item.displayName, item.status]),
    ).toEqual([
      ["U0A1", "佐藤", "pending"],
      ["U0B1", "鈴木 <@UX>", "pending"],
      ["U0C1", "田中", "unlinked"],
    ]);
    const parents = context.slack.posts.filter((post) => post.channel === "C123");
    expect(parents).toHaveLength(1);
    const serialized = JSON.stringify(parents[0]);
    expect(serialized).not.toContain("<@");
    expect(serialized).toContain("0/3 人完了");
    expect(serialized).toContain("鈴木 &lt;@UX&gt;");
    expect(serialized).toContain("🔗 田中：未入力（GitHub未連携）");
    expect(JSON.stringify(context.slack.dms("U0A1"))).toContain('"value":"req-1"');
    expect(JSON.stringify(context.slack.dms("U0A1"))).toContain("入力する");
    expect(JSON.stringify(context.slack.dms("U0C1"))).toContain("/ar connect github");
    expect(context.slack.dms("UBOSS")).toHaveLength(0);
  });

  test("channelへ投稿できなければ記録を残さず、DMも送らない", async () => {
    const context = await setup();
    context.slack.chat.postMessage = async () => {
      throw Object.assign(new Error("An API error occurred: not_in_channel"), {
        data: { error: "not_in_channel" },
      });
    };
    await expect(createRequest(context)).rejects.toThrow("not_in_channel");
    expect(await context.store.get(REQADD_REQUEST_NAMESPACE, "req-1")).toBeNull();
  });
});

describe("ReqaddService: 入力画面", () => {
  test("相手でない人と未連携の人には理由の画面を返し、連携後は未入力へ戻して入力画面を開く", async () => {
    const context = await setup();
    await createRequest(context);
    expect(
      JSON.stringify(
        await context.service.buildInputView({
          slackTeamId: "T1",
          slackUserId: "U0Z1",
          requestId: "req-1",
        }),
      ),
    ).toContain("この依頼の相手ではない");
    expect(
      JSON.stringify(
        await context.service.buildInputView({
          slackTeamId: "T1",
          slackUserId: "U0C1",
          requestId: "req-1",
        }),
      ),
    ).toContain("/ar connect github");

    context.identity.logins.U0C1 = "carol";
    context.github.items.push(item(20, { assignees: ["carol"], status: "Blocked" }));
    const view = (await context.service.buildInputView({
      slackTeamId: "T1",
      slackUserId: "U0C1",
      requestId: "req-1",
    })) as { callback_id: string; private_metadata: string; blocks: unknown[] };
    expect(view.callback_id).toBe("ar.reqadd.submit");
    expect(JSON.parse(view.private_metadata)).toEqual({
      requestId: "req-1",
      slackTeamId: "T1",
      round: 0,
    });
    expect(JSON.stringify(view.blocks)).toContain("repo#20 Issue 20");
    const stored = await context.store.get<ReqaddRequest>(REQADD_REQUEST_NAMESPACE, "req-1");
    expect(stored?.recipients.find((item) => item.slackUserId === "U0C1")?.status).toBe("pending");
    expect(JSON.stringify(context.slack.updates.at(-1))).toContain("⬜ 田中：未入力");
  });

  test("その他の仕事の設定が無ければ選択肢を出さない", async () => {
    const context = await setup({ fallback: null });
    await createRequest(context);
    const view = await context.service.buildInputView({
      slackTeamId: "T1",
      slackUserId: "U0A1",
      requestId: "req-1",
    });
    expect(JSON.stringify(view)).not.toContain("その他の仕事");
    const withFallback = await setup();
    await createRequest(withFallback);
    expect(
      JSON.stringify(
        await withFallback.service.buildInputView({
          slackTeamId: "T1",
          slackUserId: "U0A1",
          requestId: "req-1",
        }),
      ),
    ).toContain("その他の仕事");
  });
});

describe("ReqaddService: 入力の送信", () => {
  test("変えた項目だけStatusとTarget dateを更新し、TaskはTask template・担当・親・目途日・merge/reviewで作る", async () => {
    const context = await setup();
    await createRequest(context);
    const result = await context.service.submitInput({
      slackUserId: "U0A1",
      metadata: { requestId: "req-1", slackTeamId: "T1", round: 0 },
      submission: submission({
        changes: [
          {
            key: { issueNodeId: "node-1", status: "In progress", targetDate: "2026-11-18" },
            status: "Done",
          },
          {
            key: { issueNodeId: "node-2", status: "Ready", targetDate: null },
            targetDate: "2026-11-27",
          },
        ],
        newRows: [
          { row: 1, title: "見積もりを出す", targetDate: "2026-11-21", parent: WORK_URL },
          { row: 3, title: "社内連絡", targetDate: "2026-11-22", parent: "fallback" },
        ],
      }),
    });
    expect(context.github.updates).toEqual([
      { issueNodeId: "node-1", values: { status: "Done" } },
      { issueNodeId: "node-2", values: { targetDate: "2026-11-27" } },
    ]);
    expect(context.github.created).toHaveLength(2);
    const [first, second] = context.github.created;
    expect(first).toMatchObject({
      repository: "art-tra2021/repo",
      template: "task",
      title: "見積もりを出す",
      actor: "U0A1",
      slackTeamId: "T1",
      assigneeSlackUserIds: ["U0A1"],
      assigneeGitHubLogins: ["alice"],
      relationships: { parent: { repository: "art-tra2021/repo", number: 10 } },
      projectFields: { status: "Ready", targetDate: "2026-11-21" },
      fields: { merge: "通常レビュー（既定）" },
    });
    expect(second).toMatchObject({
      repository: "art-tra2021/ops",
      relationships: { parent: { repository: "art-tra2021/ops", number: 1 } },
    });
    if (!first) throw new Error("Taskが作られていません");
    expect(buildIssueCreateInput(first, issueTemplate("task"))).toMatchObject({
      labels: expect.arrayContaining(["type/task", "merge/review"]),
      assignees: ["alice"],
    });
    expect(result).toMatchObject({ markedDone: true, doneNotified: true, allDoneNotified: false });
    expect(result.updated).toHaveLength(2);
    expect(result.created).toHaveLength(2);
    const dm = context.slack.dms("U0A1").at(-1);
    expect(dm?.text).toContain("新規 2 件・更新 2 件");
  });

  test("担当していない項目の書き換えは拒む", async () => {
    const context = await setup();
    await createRequest(context);
    const result = await context.service.submitInput({
      slackUserId: "U0A1",
      metadata: { requestId: "req-1", slackTeamId: "T1", round: 0 },
      submission: submission({
        changes: [
          { key: { issueNodeId: "node-3", status: "Ready", targetDate: null }, status: "Done" },
        ],
      }),
    });
    expect(context.github.updates).toHaveLength(0);
    expect(result.failures[0]).toContain("担当していない");
    expect(result.markedDone).toBe(false);
  });

  test("同じ送信の再送と並行した二重送信でも、同じ行のTaskは1枚しか作らない", async () => {
    const context = await setup();
    await createRequest(context);
    const input = {
      slackUserId: "U0A1",
      metadata: { requestId: "req-1", slackTeamId: "T1", round: 0 },
      submission: submission({
        newRows: [{ row: 1, title: "見積もりを出す", targetDate: "2026-11-21", parent: WORK_URL }],
      }),
    };
    const [left, right] = await Promise.all([
      context.service.submitInput(input),
      context.service.submitInput(input),
    ]);
    const resent = await context.service.submitInput(input);
    expect(context.github.created).toHaveLength(1);
    expect(left.created.length + right.created.length).toBe(1);
    expect(resent.created).toHaveLength(0);
    expect(resent.alreadyCreated).toEqual(["[Task] 見積もりを出す"]);
    // 「入力しました」は最初の1回だけ。
    expect(
      context.slack.threadReplies().filter((post) => post.text.includes("佐藤さんが入力しました")),
    ).toHaveLength(1);
  });

  test("Task作成に失敗した行は、直して送り直せば作れる", async () => {
    const context = await setup();
    await createRequest(context);
    const original = context.github.createIssue.bind(context.github);
    let fail = true;
    context.github.createIssue = async (command) => {
      if (fail) throw new Error("GitHubが一時的に失敗しました");
      return original(command);
    };
    const input = {
      slackUserId: "U0A1",
      metadata: { requestId: "req-1", slackTeamId: "T1", round: 0 },
      submission: submission({
        newRows: [{ row: 1, title: "見積もりを出す", targetDate: "2026-11-21", parent: WORK_URL }],
      }),
    };
    const failed = await context.service.submitInput(input);
    expect(failed.failures[0]).toContain("GitHubが一時的に失敗しました");
    expect(failed.markedDone).toBe(false);
    fail = false;
    const retried = await context.service.submitInput(input);
    expect(retried.created).toHaveLength(1);
    expect(context.github.created).toHaveLength(1);
  });

  test("入力し直しは許し、上段は最新の値で開き、下段は追加分だけ作り、done通知は最初の1回だけ", async () => {
    const context = await setup();
    await createRequest(context, ["U0A1", "U0B1"]);
    await context.service.submitInput({
      slackUserId: "U0A1",
      metadata: { requestId: "req-1", slackTeamId: "T1", round: 0 },
      submission: submission({
        newRows: [{ row: 1, title: "見積もりを出す", targetDate: "2026-11-21", parent: WORK_URL }],
      }),
    });
    context.github.items[0] = {
      ...(context.github.items[0] as ReqaddProjectItem),
      status: "In review",
    };
    const view = (await context.service.buildInputView({
      slackTeamId: "T1",
      slackUserId: "U0A1",
      requestId: "req-1",
    })) as { private_metadata: string; blocks: Array<{ block_id?: string }> };
    expect(JSON.parse(view.private_metadata).round).toBe(1);
    expect(
      view.blocks.some(
        (block) =>
          block.block_id ===
          `rs|${encodeItemKey({ issueNodeId: "node-1", status: "In review", targetDate: "2026-11-18" })}`,
      ),
    ).toBe(true);
    const second = await context.service.submitInput({
      slackUserId: "U0A1",
      metadata: { requestId: "req-1", slackTeamId: "T1", round: 1 },
      submission: submission({
        newRows: [{ row: 1, title: "請求書を送る", targetDate: "2026-11-24", parent: WORK_URL }],
      }),
    });
    expect(second.created).toHaveLength(1);
    expect(second.doneNotified).toBe(false);
    expect(context.github.created.map((command) => command.title)).toEqual([
      "見積もりを出す",
      "請求書を送る",
    ]);
    const stored = await context.store.get<ReqaddRequest>(REQADD_REQUEST_NAMESPACE, "req-1");
    expect(stored?.recipients[0]).toMatchObject({ status: "done", createdCount: 2, round: 2 });
    expect(JSON.stringify(context.slack.updates.at(-1))).toContain(
      "✅ 佐藤：入力済み（新規 2・更新 0）",
    );
    expect(
      context.slack.threadReplies().filter((post) => post.text.includes("佐藤さんが入力しました")),
    ).toHaveLength(1);
  });

  test("全員がdoneになったら、threadで依頼者を1回だけmentionする", async () => {
    const context = await setup();
    await createRequest(context, ["U0A1", "U0B1"]);
    await context.service.submitInput({
      slackUserId: "U0A1",
      metadata: { requestId: "req-1", slackTeamId: "T1", round: 0 },
      submission: submission(),
    });
    expect(context.slack.threadReplies().some((post) => post.text.includes("<@UBOSS>"))).toBe(
      false,
    );
    const done = await context.service.submitInput({
      slackUserId: "U0B1",
      metadata: { requestId: "req-1", slackTeamId: "T1", round: 0 },
      submission: submission(),
    });
    expect(done.allDoneNotified).toBe(true);
    await context.service.submitInput({
      slackUserId: "U0B1",
      metadata: { requestId: "req-1", slackTeamId: "T1", round: 1 },
      submission: submission(),
    });
    const replies = context.slack.threadReplies();
    expect(replies.filter((post) => post.text.includes("<@UBOSS>"))).toHaveLength(1);
    expect(replies.every((post) => post.thread_ts === "100.1")).toBe(true);
    // 入力の知らせは人名を表示名で書き、mentionにしない。
    const doneReplies = replies.filter((post) => post.text.includes("さんが入力しました"));
    expect(doneReplies.map((post) => post.text)).toEqual([
      "✅ 佐藤さんが入力しました（新規 0 件・更新 0 件）",
      "✅ 鈴木 &lt;@UX&gt;さんが入力しました（新規 0 件・更新 0 件）",
    ]);
    expect(JSON.stringify(context.slack.updates.at(-1))).toContain("2/2 人完了");
  });
});

describe("ReqaddService: 期限前日の再依頼と期限後の一覧", () => {
  test("期限が翌日（JST）の依頼で、未入力と未連携の相手へ1回だけDMする", async () => {
    const context = await setup();
    await createRequest(context, ["U0A1", "U0B1", "U0C1"], "2026-11-20");
    await context.service.submitInput({
      slackUserId: "U0B1",
      metadata: { requestId: "req-1", slackTeamId: "T1", round: 0 },
      submission: submission(),
    });
    // JST 11/18 23:59は前々日なので、まだ送らない。
    context.clock.set("2026-11-18T14:59:00Z");
    expect(await context.service.sendReminders()).toEqual({ reminded: 0, overdueNotified: 0 });
    // JST 11/19 0:00を過ぎたら前日。
    context.clock.set("2026-11-19T00:10:00Z");
    expect(await context.service.sendReminders()).toEqual({ reminded: 2, overdueNotified: 0 });
    expect(await context.service.sendReminders()).toEqual({ reminded: 0, overdueNotified: 0 });
    expect(context.slack.dms("U0A1").at(-1)?.text).toContain("期限は明日");
    expect(context.slack.dms("U0C1").at(-1)?.text).toContain("期限は明日");
    expect(context.slack.dms("U0B1").some((post) => post.text.includes("期限は明日"))).toBe(false);
  });

  test("期限を過ぎた依頼は、threadへ未入力者の一覧を1回だけ出し、依頼者をmentionしない", async () => {
    const context = await setup();
    await createRequest(context, ["U0A1", "U0B1"], "2026-11-20");
    await context.service.submitInput({
      slackUserId: "U0A1",
      metadata: { requestId: "req-1", slackTeamId: "T1", round: 0 },
      submission: submission(),
    });
    // 期限当日（JST 11/20 23:59）はまだ出さない。
    context.clock.set("2026-11-20T14:59:00Z");
    expect((await context.service.sendReminders()).overdueNotified).toBe(0);
    context.clock.set("2026-11-21T00:10:00Z");
    expect((await context.service.sendReminders()).overdueNotified).toBe(1);
    expect((await context.service.sendReminders()).overdueNotified).toBe(0);
    const overdue = context.slack.threadReplies().filter((post) => post.text.includes("期限"));
    expect(overdue).toHaveLength(1);
    expect(overdue[0]?.text).toContain("未入力: 鈴木 &lt;@UX&gt;");
    expect(overdue[0]?.text).not.toContain("<@");
  });
});

function item(number: number, overrides: Partial<ReqaddProjectItem> = {}): ReqaddProjectItem {
  return {
    issueNodeId: `node-${number}`,
    repository: "art-tra2021/repo",
    number,
    title: `Issue ${number}`,
    url: `https://github.com/art-tra2021/repo/issues/${number}`,
    type: "task",
    assignees: [],
    status: "Ready",
    targetDate: null,
    ...overrides,
  };
}
