import { describe, expect, test } from "bun:test";
import { openReqaddInputFlow } from "../src/app.ts";
import {
  decodeItemKey,
  defaultDueDate,
  encodeItemKey,
  escapeSlack,
  formatDueDate,
  jstToday,
  myOpenItems,
  overdueReplyText,
  parentOptions,
  type ReqaddProjectItem,
  type ReqaddRequest,
  reqaddInputModal,
  reqaddParentMessage,
  reqaddRequestDm,
  reqaddRequestModal,
  validateInputSubmission,
  validateRequestSubmission,
} from "../src/reqadd.ts";
import { REQADD_PROJECT_ITEMS_QUERY, reqaddProjectItemsPage } from "../src/reqadd-project.ts";

const FALLBACK = "https://github.com/art-tra2021/ops/issues/1";

describe("reqaddの日付（JST）", () => {
  test("JSTの日付はUTC 15:00を境に変わる", () => {
    expect(jstToday(Date.parse("2026-11-19T14:59:59Z"))).toBe("2026-11-19");
    expect(jstToday(Date.parse("2026-11-19T15:00:00Z"))).toBe("2026-11-20");
  });

  test("期限の初期値はその週の金曜で、土日は次の金曜にする", () => {
    // 2026-11-16は月曜。
    expect(defaultDueDate(Date.parse("2026-11-16T00:00:00Z"))).toBe("2026-11-20");
    expect(defaultDueDate(Date.parse("2026-11-20T10:00:00Z"))).toBe("2026-11-20");
    // 金曜のJST 23:59は金曜、JST 0:00を過ぎた土曜は次の金曜。
    expect(defaultDueDate(Date.parse("2026-11-20T14:59:00Z"))).toBe("2026-11-20");
    expect(defaultDueDate(Date.parse("2026-11-20T15:00:00Z"))).toBe("2026-11-27");
    expect(defaultDueDate(Date.parse("2026-11-22T03:00:00Z"))).toBe("2026-11-27");
    expect(formatDueDate("2026-11-20")).toBe("2026-11-20（金）");
  });
});

describe("reqaddの依頼画面", () => {
  test("相手は必須で複数選べ、期限の初期値は金曜、投稿先のchannelを持つ", () => {
    const modal = reqaddRequestModal(
      { channelId: "C123", slackTeamId: "T1" },
      Date.parse("2026-11-17T00:00:00Z"),
    );
    expect(JSON.parse(modal.private_metadata)).toEqual({ channelId: "C123", slackTeamId: "T1" });
    const recipients = modal.blocks.find(
      (block) => "block_id" in block && block.block_id === "recipients",
    );
    expect(recipients).toMatchObject({ element: { type: "multi_users_select" } });
    expect(recipients && "optional" in recipients).toBe(false);
    expect(
      modal.blocks.find((block) => "block_id" in block && block.block_id === "due"),
    ).toMatchObject({
      element: { type: "datepicker", initial_date: "2026-11-20" },
    });
  });

  test("過去日は拒み、当日（JST）は受け付ける", () => {
    const now = Date.parse("2026-11-19T15:30:00Z"); // JST 11/20 0:30
    const values = (due: string, users: string[] = ["U1", "U2", "U1"]) => ({
      recipients: { value: { selected_users: users } },
      due: { value: { selected_date: due } },
      note: { value: { value: "  よろしく  " } },
    });
    expect(validateRequestSubmission(values("2026-11-19"), now)).toEqual({
      ok: false,
      errors: { due: "過去の日付は選べません。" },
    });
    expect(validateRequestSubmission(values("2026-11-20"), now)).toEqual({
      ok: true,
      value: { recipients: ["U1", "U2"], dueDate: "2026-11-20", note: "よろしく" },
    });
    expect(validateRequestSubmission(values("2026-11-20", []), now)).toMatchObject({
      ok: false,
      errors: { recipients: expect.any(String) },
    });
  });
});

describe("reqaddの親投稿", () => {
  test("人名は表示名で書き、mentionを作らず、< > &を置き換える", () => {
    const message = reqaddParentMessage(
      request({
        requesterName: "社長 <!channel>",
        note: "<@U999> & 確認",
        recipients: [
          recipient("U1", "佐藤", "done", 2, 1),
          recipient("U2", "鈴木 <@U3>", "pending"),
          recipient("U3", "田中", "unlinked"),
        ],
      }),
    );
    const serialized = JSON.stringify(message);
    expect(serialized).not.toContain("<@");
    expect(serialized).not.toContain("<!");
    expect(serialized).toContain("社長 &lt;!channel&gt;");
    expect(serialized).toContain("&lt;@U999&gt; &amp; 確認");
    expect(serialized).toContain("✅ 佐藤：入力済み（新規 2・更新 1）");
    expect(serialized).toContain("⬜ 鈴木 &lt;@U3&gt;：未入力");
    expect(serialized).toContain("🔗 田中：未入力（GitHub未連携）");
    expect(serialized).toContain("1/3 人完了");
    expect(message.text).toContain("1/3 人完了");
  });

  test("相手が30人でもblocksと文字数の上限に収める", () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      recipient(`U${index}`, "名".repeat(80), "pending"),
    );
    const message = reqaddParentMessage(request({ recipients: many }));
    expect(message.blocks.length).toBeLessThanOrEqual(50);
    for (const block of message.blocks) {
      if (block.type === "section") expect(block.text.text.length).toBeLessThanOrEqual(3000);
    }
  });

  test("期限後の一覧は未入力者だけを書き、全員済みならnull", () => {
    const text = overdueReplyText(
      request({
        recipients: [recipient("U1", "佐藤", "done"), recipient("U2", "鈴木", "pending")],
      }),
    );
    expect(text).toContain("未入力: 鈴木");
    expect(text).not.toContain("佐藤");
    expect(text).not.toContain("<@");
    expect(overdueReplyText(request({ recipients: [recipient("U1", "佐藤", "done")] }))).toBeNull();
  });
});

describe("reqaddのDM", () => {
  test("連携済みの相手には「入力する」ボタン、未連携の相手には連携の案内とボタン", () => {
    const linked = reqaddRequestDm(request(), recipient("U1", "佐藤", "pending"), "request");
    expect(linked.blocks.at(-1)).toMatchObject({
      type: "actions",
      elements: [{ action_id: "ar.reqadd.open", value: "req-1", text: { text: "入力する" } }],
    });
    const unlinked = reqaddRequestDm(request(), recipient("U3", "田中", "unlinked"), "request");
    expect(JSON.stringify(unlinked.blocks)).toContain("/ar connect github");
    expect(unlinked.blocks.at(-1)).toMatchObject({
      elements: [
        { action_id: "ar.reqadd.open", value: "req-1", text: { text: "連携したので入力する" } },
      ],
    });
    const reminder = reqaddRequestDm(request(), recipient("U1", "佐藤", "pending"), "reminder");
    expect(reminder.text).toContain("期限は明日");
  });
});

describe("reqaddの入力画面", () => {
  test("上段は本人の未完了の仕事を現在値で並べ、上限で切って残りの件数を書く", () => {
    const items = Array.from({ length: 25 }, (_, index) =>
      item(index + 1, {
        assignees: ["Alice"],
        status: index === 0 ? "In progress" : "Ready",
        targetDate: index === 0 ? "2026-11-18" : null,
      }),
    );
    const mine = myOpenItems(
      [
        ...items,
        item(90, { assignees: ["bob"] }),
        item(91, { assignees: ["alice"], status: "Done" }),
      ],
      "alice",
    );
    expect(mine).toHaveLength(25);
    const modal = reqaddInputModal({
      metadata: { requestId: "req-1", slackTeamId: "T1", round: 0 },
      request: request(),
      items: mine,
      parents: parentOptions(items, "alice", FALLBACK),
    });
    expect(modal.blocks.length).toBeLessThanOrEqual(100);
    const statusBlocks = modal.blocks.filter(
      (block) => "block_id" in block && String(block.block_id).startsWith("rs|"),
    );
    expect(statusBlocks).toHaveLength(20);
    expect(JSON.stringify(modal.blocks)).toContain("ほか 5 件はGitHubで更新してください。");
    const first = statusBlocks[0] as {
      block_id: string;
      element: { initial_option: { value: string }; options: unknown[] };
    };
    expect(first.element.initial_option.value).toBe("In progress");
    expect(first.element.options).toHaveLength(5);
    expect(decodeItemKey(first.block_id.slice(3))).toEqual({
      issueNodeId: "node-1",
      status: "In progress",
      targetDate: "2026-11-18",
    });
    expect(first.block_id.length).toBeLessThanOrEqual(255);
    const date = modal.blocks.find(
      (block) => "block_id" in block && block.block_id === `rd|${first.block_id.slice(3)}`,
    );
    expect(date).toMatchObject({ element: { type: "datepicker", initial_date: "2026-11-18" } });
    expect(modal.private_metadata.length).toBeLessThan(3000);
  });

  test("下段は固定5行で、親は「その他の仕事」を先頭に未完了のWork・Businessを並べる", () => {
    const items = [
      item(10, { type: "work", assignees: ["bob"] }),
      item(11, { type: "business", assignees: ["alice"] }),
      item(12, { type: "work", status: "Done" }),
      item(13, { type: "task" }),
      item(14, { type: "other" }),
    ];
    const parents = parentOptions(items, "alice", FALLBACK);
    expect(parents.map((parent) => parent.label)).toEqual([
      "その他の仕事",
      "repo#11 Issue 11",
      "repo#10 Issue 10",
    ]);
    expect(parents[0]?.value).toBe("fallback");
    expect(parentOptions(items, "alice", null).map((parent) => parent.value)).toEqual([
      "https://github.com/art-tra2021/repo/issues/11",
      "https://github.com/art-tra2021/repo/issues/10",
    ]);
    const modal = reqaddInputModal({
      metadata: { requestId: "req-1", slackTeamId: "T1", round: 0 },
      request: request(),
      items: [],
      parents,
    });
    const rows = modal.blocks.filter(
      (block) => "block_id" in block && String(block.block_id).startsWith("new-title:"),
    );
    expect(rows).toHaveLength(5);
    expect(JSON.stringify(modal.blocks)).toContain("担当していて未完了の仕事はありません。");
  });

  test("親の候補が無い時は下段の行を出さない", () => {
    const modal = reqaddInputModal({
      metadata: { requestId: "req-1", slackTeamId: "T1", round: 0 },
      request: request(),
      items: [],
      parents: [],
    });
    expect(JSON.stringify(modal.blocks)).not.toContain("new-title:");
  });

  test("送信値から、変えた上段の項目と仕事名のある行だけを読む", () => {
    const changed = encodeItemKey({
      issueNodeId: "node-1",
      status: "Ready",
      targetDate: "2026-11-18",
    });
    const same = encodeItemKey({ issueNodeId: "node-2", status: "Ready", targetDate: null });
    const result = validateInputSubmission({
      [`rs|${changed}`]: { status: { selected_option: { value: "Done" } } },
      [`rd|${changed}`]: { date: { selected_date: "2026-11-25" } },
      [`rs|${same}`]: { status: { selected_option: { value: "Ready" } } },
      [`rd|${same}`]: { date: { selected_date: null } },
      "new-title:1": { value: { value: " 見積もりを出す " } },
      "new-date:1": { value: { selected_date: "2026-11-21" } },
      "new-parent:1": { value: { selected_option: { value: "fallback" } } },
      "new-title:2": { value: { value: "" } },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        changes: [
          {
            key: { issueNodeId: "node-1", status: "Ready", targetDate: "2026-11-18" },
            status: "Done",
            targetDate: "2026-11-25",
          },
        ],
        newRows: [
          { row: 1, title: "見積もりを出す", targetDate: "2026-11-21", parent: "fallback" },
        ],
      },
    });
  });

  test("仕事名だけの行は目途日と親を求める", () => {
    expect(validateInputSubmission({ "new-title:3": { value: { value: "資料" } } })).toEqual({
      ok: false,
      errors: { "new-date:3": "目途日を選んでください。", "new-parent:3": "親を選んでください。" },
    });
  });

  test("画面を開くときは先に読み込み中の画面を開き、読み込み後に差し替える", async () => {
    const calls: string[] = [];
    await openReqaddInputFlow({
      views: {
        open: async (input) => {
          calls.push(`open:${JSON.stringify(input.view)}`);
          return { view: { id: "V1" } };
        },
        update: async (input) => {
          calls.push(`update:${input.view_id}:${JSON.stringify(input.view)}`);
          return {};
        },
      },
      triggerId: "trigger",
      loadView: async () => {
        calls.push("load");
        throw new Error("GitHubが応答しません");
      },
    });
    expect(calls[0]).toContain("読み込んでいます");
    expect(calls[1]).toBe("load");
    expect(calls[2]).toContain("update:V1:");
    expect(calls[2]).toContain("GitHubが応答しません");
  });

  test("エスケープは< > &だけを置き換える", () => {
    expect(escapeSlack("<@U1> & <!here>")).toBe("&lt;@U1&gt; &amp; &lt;!here&gt;");
  });
});

describe("reqaddのProject読み取り", () => {
  test("openのIssueだけを、node ID・状態・目途日・種別付きで読む", () => {
    expect(REQADD_PROJECT_ITEMS_QUERY).toContain("id");
    const page = reqaddProjectItemsPage(
      {
        data: {
          organization: {
            projectV2: {
              items: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    fieldValues: {
                      nodes: [
                        { name: "In review", field: { name: "Status" } },
                        { date: "2026-11-21", field: { name: "Target date" } },
                      ],
                    },
                    content: {
                      id: "I_1",
                      number: 5,
                      title: "仕様を書く",
                      url: "https://github.com/art-tra2021/repo/issues/5",
                      state: "OPEN",
                      repository: { nameWithOwner: "art-tra2021/repo" },
                      labels: { nodes: [{ name: "type/task" }] },
                      assignees: { nodes: [{ login: "alice" }] },
                    },
                  },
                  {
                    content: {
                      id: "I_2",
                      number: 6,
                      title: "closed",
                      url: "https://github.com/art-tra2021/repo/issues/6",
                      state: "CLOSED",
                    },
                  },
                  { content: null },
                ],
              },
            },
          },
        },
      },
      8,
    );
    expect(page.items).toEqual([
      {
        issueNodeId: "I_1",
        repository: "art-tra2021/repo",
        number: 5,
        title: "仕様を書く",
        url: "https://github.com/art-tra2021/repo/issues/5",
        type: "task",
        assignees: ["alice"],
        status: "In review",
        targetDate: "2026-11-21",
      },
    ]);
  });
});

function request(overrides: Partial<ReqaddRequest> = {}): ReqaddRequest {
  return {
    schemaVersion: 1,
    requestId: "req-1",
    revision: 1,
    slackTeamId: "T1",
    requesterSlackUserId: "UBOSS",
    requesterName: "社長",
    channelId: "C123",
    messageTs: "100.1",
    dueDate: "2026-11-20",
    note: "",
    createdAt: "2026-11-16T00:00:00.000Z",
    recipients: [recipient("U1", "佐藤", "pending")],
    allDoneNotifiedAt: null,
    overdueNotifiedAt: null,
    ...overrides,
  };
}

function recipient(
  slackUserId: string,
  displayName: string,
  status: "pending" | "done" | "unlinked",
  createdCount = 0,
  updatedCount = 0,
) {
  return {
    slackUserId,
    displayName,
    status,
    createdCount,
    updatedCount,
    round: 0,
    firstDoneAt: null,
    lastSubmittedAt: null,
    doneNotifiedAt: null,
    reminderSentAt: null,
  };
}

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
