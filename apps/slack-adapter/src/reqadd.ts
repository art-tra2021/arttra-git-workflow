/**
 * `/ar reqadd`の画面、投稿、入力の読み取りをまとめた純粋関数群。
 * Slack・GitHub・state storeへは触れず、ReqaddServiceとテストから呼ぶ。
 */

export const REQADD_REQUEST_CALLBACK_ID = "ar.reqadd.request";
export const REQADD_INPUT_CALLBACK_ID = "ar.reqadd.submit";
export const REQADD_OPEN_ACTION_ID = "ar.reqadd.open";

/** 入力画面の上段に並べる仕事の上限。1件2 blocksなので、下段と合わせてもmodalの100 blocksに収まる。 */
export const REQADD_ITEM_LIMIT = 20;
/** 入力画面の下段の行数。 */
export const REQADD_NEW_ROWS = 5;
/** 依頼できる相手の上限。親投稿のblocks（50件まで）と文字数に収める。 */
export const REQADD_MAX_RECIPIENTS = 30;
/** 親の選択肢の上限。static_selectは100件まで。 */
const PARENT_OPTION_LIMIT = 100;
const FALLBACK_PARENT_VALUE = "fallback";

/** 上段で選べるProjectの状態。 */
export const REQADD_STATUSES = ["Ready", "In progress", "In review", "Blocked", "Done"] as const;

const DAY = 24 * 60 * 60 * 1000;
const JST_OFFSET = 9 * 60 * 60 * 1000;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export type ReqaddRecipientStatus = "pending" | "done" | "unlinked";

export interface ReqaddRecipient {
  slackUserId: string;
  /** 依頼時点のSlack表示名。mentionを作らないため、親投稿と返信ではこちらを書く。 */
  displayName: string;
  status: ReqaddRecipientStatus;
  /** この人が入力画面から作ったTaskの累計件数。 */
  createdCount: number;
  /** この人が入力画面から更新したProject項目の累計件数。 */
  updatedCount: number;
  /** 処理し終えた入力の回数。Task作成の重複防止keyに入れ、入力し直しの新規を区別する。 */
  round: number;
  firstDoneAt: string | null;
  lastSubmittedAt: string | null;
  /** 「〇〇さんが入力しました」をthreadへ出した時刻。最初の1回だけ出す。 */
  doneNotifiedAt: string | null;
  /** 期限前日の再依頼DMを送った時刻。 */
  reminderSentAt: string | null;
}

export interface ReqaddRequest {
  schemaVersion: 1;
  requestId: string;
  revision: number;
  slackTeamId: string;
  requesterSlackUserId: string;
  requesterName: string;
  channelId: string;
  /** channelの親投稿のts。投稿前と投稿失敗時はnull。 */
  messageTs: string | null;
  /** 期限（JSTの日付、YYYY-MM-DD）。 */
  dueDate: string;
  note: string;
  createdAt: string;
  recipients: ReqaddRecipient[];
  /** 全員完了の知らせ（依頼者へのmention）を出した時刻。 */
  allDoneNotifiedAt: string | null;
  /** 期限後の未入力者一覧をthreadへ出した時刻。 */
  overdueNotifiedAt: string | null;
}

/** Project #8の項目のうち、reqaddが読む部分。 */
export interface ReqaddProjectItem {
  issueNodeId: string;
  repository: string;
  number: number;
  title: string;
  url: string;
  type: "intake" | "work" | "task" | "business" | "other";
  assignees: string[];
  /** ProjectのStatusの名前（例: In progress）。未設定はnull。 */
  status: string | null;
  targetDate: string | null;
}

/** 上段の1項目の、画面を開いた時点の値。block_idへ埋め込み、送信時の差分判定に使う。 */
export interface ReqaddItemKey {
  issueNodeId: string;
  status: string | null;
  targetDate: string | null;
}

export interface ReqaddParentOption {
  /** option value。Issue URLか、「その他の仕事」を表す"fallback"。 */
  value: string;
  label: string;
}

export interface ReqaddInputMetadata {
  requestId: string;
  slackTeamId: string;
  round: number;
}

export interface ReqaddRequestMetadata {
  channelId: string;
  slackTeamId: string;
}

export interface ReqaddItemChange {
  key: ReqaddItemKey;
  status?: string;
  targetDate?: string;
}

export interface ReqaddNewRow {
  row: number;
  title: string;
  targetDate: string;
  /** Issue URL、または"fallback"。 */
  parent: string;
}

export interface ReqaddInputSubmission {
  changes: ReqaddItemChange[];
  newRows: ReqaddNewRow[];
}

export interface ReqaddRequestInput {
  recipients: string[];
  dueDate: string;
  note: string;
}

export type SlackStateValues = Record<
  string,
  Record<
    string,
    {
      value?: string | null;
      selected_date?: string | null;
      selected_option?: { value: string } | null;
      selected_users?: string[];
    }
  >
>;

export type ReqaddValidation<T> =
  | { ok: true; value: T }
  | { ok: false; errors: Record<string, string> };

// ---------------------------------------------------------------------------
// 日付（JST）

/** nowのJSTでの日付。 */
export function jstToday(now: number): string {
  return new Date(now + JST_OFFSET).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/** 依頼画面の期限の初期値。その週の金曜（JST）。土日は次の金曜にする。 */
export function defaultDueDate(now: number): string {
  const today = jstToday(now);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addDays(today, (5 - weekday + 7) % 7);
}

/** 2026-11-20（金）の形にする。 */
export function formatDueDate(date: string): string {
  const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? "";
  return `${date}（${weekday}）`;
}

export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

// ---------------------------------------------------------------------------
// 文字の扱い

/** mrkdwnへ入れる利用者の文字を、mentionやlinkにならないよう置き換える。 */
export function escapeSlack(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function truncate(value: string, max: number): string {
  const characters = [...value];
  return characters.length > max ? `${characters.slice(0, max - 1).join("")}…` : value;
}

function plain(text: string, max = 2000) {
  return { type: "plain_text" as const, text: truncate(text, max) };
}

function mrkdwnSection(text: string) {
  return {
    type: "section" as const,
    text: { type: "mrkdwn" as const, text: truncate(text, 3000) },
  };
}

function context(text: string) {
  return {
    type: "context" as const,
    elements: [{ type: "mrkdwn" as const, text: truncate(text, 3000) }],
  };
}

function header(text: string) {
  return { type: "header" as const, text: { ...plain(text, 150), emoji: true } };
}

function option(text: string, value: string) {
  return { text: plain(text, 75), value };
}

// ---------------------------------------------------------------------------
// 依頼画面

export function reqaddRequestModal(metadata: ReqaddRequestMetadata, now: number) {
  return {
    type: "modal" as const,
    callback_id: REQADD_REQUEST_CALLBACK_ID,
    private_metadata: JSON.stringify(metadata),
    title: plain("仕事の入力を依頼", 24),
    submit: plain("依頼する", 24),
    close: plain("キャンセル", 24),
    blocks: [
      context("このチャンネルに進み具合の投稿を1件出し、相手へDMで入力をお願いします。"),
      {
        type: "input" as const,
        block_id: "recipients",
        label: plain("相手"),
        element: {
          type: "multi_users_select" as const,
          action_id: "value",
          max_selected_items: REQADD_MAX_RECIPIENTS,
          placeholder: plain("Slackメンバーから選択"),
        },
      },
      {
        type: "input" as const,
        block_id: "due",
        label: plain("期限"),
        element: {
          type: "datepicker" as const,
          action_id: "value",
          initial_date: defaultDueDate(now),
        },
      },
      {
        type: "input" as const,
        block_id: "note",
        optional: true,
        label: plain("ひとこと"),
        element: {
          type: "plain_text_input" as const,
          action_id: "value",
          multiline: true,
          max_length: 500,
          placeholder: plain("例: 来週の打ち合わせ前に、今の仕事を入れてください"),
        },
      },
    ],
  };
}

export function parseRequestMetadata(value: string): ReqaddRequestMetadata | null {
  try {
    const parsed = JSON.parse(value) as Partial<ReqaddRequestMetadata>;
    if (typeof parsed.channelId !== "string" || !/^[CDG][A-Z0-9]+$/.test(parsed.channelId)) {
      return null;
    }
    return { channelId: parsed.channelId, slackTeamId: String(parsed.slackTeamId ?? "") };
  } catch {
    return null;
  }
}

export function validateRequestSubmission(
  values: SlackStateValues,
  now: number,
): ReqaddValidation<ReqaddRequestInput> {
  const recipients = [
    ...new Set(
      (values.recipients?.value?.selected_users ?? []).filter((id) => /^[UW][A-Z0-9]+$/.test(id)),
    ),
  ];
  const dueDate = values.due?.value?.selected_date ?? "";
  const note = (values.note?.value?.value ?? "").trim();
  const errors: Record<string, string> = {};
  if (recipients.length === 0) errors.recipients = "相手を1人以上選んでください。";
  if (recipients.length > REQADD_MAX_RECIPIENTS) {
    errors.recipients = `相手は${REQADD_MAX_RECIPIENTS}人までにしてください。`;
  }
  if (!isValidDate(dueDate)) {
    errors.due = "期限を選んでください。";
  } else if (dueDate < jstToday(now)) {
    errors.due = "過去の日付は選べません。";
  }
  if ([...note].length > 500) errors.note = "ひとことは500文字までにしてください。";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { recipients, dueDate, note } };
}

// ---------------------------------------------------------------------------
// 親投稿とthread

export function recipientLine(recipient: ReqaddRecipient): string {
  const name = escapeSlack(recipient.displayName);
  if (recipient.status === "done") {
    return `✅ ${name}：入力済み（新規 ${recipient.createdCount}・更新 ${recipient.updatedCount}）`;
  }
  if (recipient.status === "unlinked") return `🔗 ${name}：未入力（GitHub未連携）`;
  return `⬜ ${name}：未入力`;
}

export function progressLabel(request: ReqaddRequest): string {
  const done = request.recipients.filter((recipient) => recipient.status === "done").length;
  return `${done}/${request.recipients.length} 人完了`;
}

/** channelの親投稿。人名は表示名で書き、mentionを作らない。 */
export function reqaddParentMessage(request: ReqaddRequest) {
  const summary = [
    `*依頼者:* ${escapeSlack(request.requesterName)}`,
    `*期限:* ${formatDueDate(request.dueDate)}`,
    ...(request.note ? [`*ひとこと:* ${escapeSlack(request.note)}`] : []),
  ].join("\n");
  const lines = request.recipients.map(recipientLine);
  const chunks: string[][] = [];
  for (let index = 0; index < lines.length; index += 10) {
    chunks.push(lines.slice(index, index + 10));
  }
  return {
    text: `🧩 仕事の入力のお願い（期限 ${formatDueDate(request.dueDate)}）: ${progressLabel(request)}`,
    blocks: [
      header("🧩 仕事の入力のお願い"),
      mrkdwnSection(summary),
      mrkdwnSection(`*進み具合:* ${progressLabel(request)}`),
      ...chunks.map((chunk) => mrkdwnSection(chunk.join("\n"))),
      context(
        "相手にはDMでお願いを送りました。DMの「入力する」から、自分の仕事の更新と新しい仕事の追加ができます。",
      ),
    ],
  };
}

export function doneReplyText(recipient: ReqaddRecipient, created: number, updated: number) {
  return `✅ ${escapeSlack(recipient.displayName)}さんが入力しました（新規 ${created} 件・更新 ${updated} 件）`;
}

export function allDoneReplyText(request: ReqaddRequest): string {
  return `🏁 <@${request.requesterSlackUserId}> 全員の入力が済みました（${progressLabel(request)}）。`;
}

export function overdueReplyText(request: ReqaddRequest): string | null {
  const remaining = request.recipients.filter((recipient) => recipient.status !== "done");
  if (remaining.length === 0) return null;
  return `⏰ 期限（${formatDueDate(request.dueDate)}）を過ぎました。未入力: ${remaining
    .map((recipient) => escapeSlack(recipient.displayName))
    .join("、")}`;
}

// ---------------------------------------------------------------------------
// 相手へのDM

export function reqaddRequestDm(
  request: ReqaddRequest,
  recipient: ReqaddRecipient,
  kind: "request" | "reminder",
) {
  const lead =
    kind === "reminder"
      ? `⏰ 期限は明日（${formatDueDate(request.dueDate)}）です。${escapeSlack(request.requesterName)}さんからの仕事の入力のお願いが、まだ済んでいません。`
      : `🧩 ${escapeSlack(request.requesterName)}さんから、仕事の入力のお願いです。`;
  const detail = [
    lead,
    `*期限:* ${formatDueDate(request.dueDate)}`,
    ...(request.note ? [`*ひとこと:* ${escapeSlack(request.note)}`] : []),
    "自分の仕事の状態と目途日を直し、新しい仕事があれば追加してください。",
  ].join("\n");
  const linked = recipient.status !== "unlinked";
  return {
    text: linked
      ? `${lead} DMの「入力する」から入力してください。`
      : `${lead} GitHub連携の後に入力してください。`,
    blocks: [
      mrkdwnSection(detail),
      ...(linked
        ? []
        : [
            mrkdwnSection(
              "GitHubと連携していないため、まだ入力できません。Slackで `/ar connect github` を実行して連携してから、下のボタンを押してください。",
            ),
          ]),
      {
        type: "actions" as const,
        elements: [
          {
            type: "button" as const,
            action_id: REQADD_OPEN_ACTION_ID,
            text: plain(linked ? "入力する" : "連携したので入力する", 75),
            style: "primary" as const,
            value: request.requestId,
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 入力画面

export function reqaddMessageModal(message: string) {
  return {
    type: "modal" as const,
    title: plain("仕事の入力", 24),
    close: plain("閉じる", 24),
    blocks: [{ type: "section" as const, text: plain(message, 3000) }],
  };
}

export function encodeItemKey(key: ReqaddItemKey): string {
  return Buffer.from(
    JSON.stringify({ i: key.issueNodeId, s: key.status, d: key.targetDate }),
  ).toString("base64url");
}

export function decodeItemKey(value: string): ReqaddItemKey | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      i?: unknown;
      s?: unknown;
      d?: unknown;
    };
    if (typeof parsed.i !== "string" || !parsed.i || parsed.i.length > 120) return null;
    return {
      issueNodeId: parsed.i,
      status: typeof parsed.s === "string" ? parsed.s : null,
      targetDate: typeof parsed.d === "string" ? parsed.d : null,
    };
  } catch {
    return null;
  }
}

/** 本人が担当する未完了の項目を、目途日の近い順に並べる。 */
export function myOpenItems(items: ReqaddProjectItem[], githubLogin: string): ReqaddProjectItem[] {
  const login = githubLogin.toLowerCase();
  return items
    .filter(
      (item) =>
        item.status !== "Done" &&
        item.assignees.some((assignee) => assignee.toLowerCase() === login),
    )
    .sort(
      (left, right) =>
        (left.targetDate ?? "9999-99-99").localeCompare(right.targetDate ?? "9999-99-99") ||
        left.repository.localeCompare(right.repository) ||
        left.number - right.number,
    );
}

/**
 * 親の選択肢。先頭に「その他の仕事」（設定がある時だけ）、続いて本人が担当する未完了のWork・Business、
 * その他の未完了のWork・Businessを番号の新しい順に並べる。
 */
export function parentOptions(
  items: ReqaddProjectItem[],
  githubLogin: string,
  fallbackParentUrl: string | null,
): ReqaddParentOption[] {
  const login = githubLogin.toLowerCase();
  const candidates = items
    .filter((item) => (item.type === "work" || item.type === "business") && item.status !== "Done")
    .sort((left, right) => {
      const leftMine = left.assignees.some((assignee) => assignee.toLowerCase() === login);
      const rightMine = right.assignees.some((assignee) => assignee.toLowerCase() === login);
      if (leftMine !== rightMine) return leftMine ? -1 : 1;
      return left.repository.localeCompare(right.repository) || right.number - left.number;
    });
  const options: ReqaddParentOption[] = fallbackParentUrl
    ? [{ value: FALLBACK_PARENT_VALUE, label: "その他の仕事" }]
    : [];
  for (const item of candidates) {
    if (options.length >= PARENT_OPTION_LIMIT) break;
    // option valueは150文字まで。超えるURLは選択肢にせず、Slackにmodalごと拒否されないようにする。
    if (item.url.length > 150) continue;
    options.push({ value: item.url, label: itemLabel(item) });
  }
  return options;
}

function itemLabel(item: ReqaddProjectItem): string {
  const repositoryName = item.repository.split("/")[1] ?? item.repository;
  return `${repositoryName}#${item.number} ${item.title}`;
}

function statusOptions(current: string | null) {
  const values: string[] = [...REQADD_STATUSES];
  if (current && !values.includes(current)) values.unshift(current);
  return values.map((value) => option(value, value));
}

export interface ReqaddInputModalInput {
  metadata: ReqaddInputMetadata;
  request: Pick<ReqaddRequest, "requesterName" | "dueDate" | "note">;
  items: ReqaddProjectItem[];
  parents: ReqaddParentOption[];
  itemLimit?: number;
}

export function reqaddInputModal(input: ReqaddInputModalInput) {
  const limit = input.itemLimit ?? REQADD_ITEM_LIMIT;
  const shown = input.items.slice(0, limit);
  const hidden = input.items.length - shown.length;
  const itemBlocks = shown.flatMap((item) => {
    const key = encodeItemKey({
      issueNodeId: item.issueNodeId,
      status: item.status,
      targetDate: item.targetDate,
    });
    const initialStatus = item.status ?? "Ready";
    return [
      {
        type: "input" as const,
        block_id: `rs|${key}`,
        label: plain(itemLabel(item), 150),
        hint: plain(`状態（いま: ${item.status ?? "未設定"}）`),
        element: {
          type: "static_select" as const,
          action_id: "status",
          initial_option: option(initialStatus, initialStatus),
          options: statusOptions(item.status),
        },
      },
      {
        type: "input" as const,
        block_id: `rd|${key}`,
        optional: true,
        label: plain("目途日"),
        element: {
          type: "datepicker" as const,
          action_id: "date",
          ...(item.targetDate ? { initial_date: item.targetDate } : {}),
          placeholder: plain("未設定"),
        },
      },
    ];
  });
  const rowBlocks =
    input.parents.length === 0
      ? [
          mrkdwnSection(
            "親にできる未完了のWork・Businessが見つからないため、ここでは新しい仕事を追加できません。GitHubで追加してください。",
          ),
        ]
      : Array.from({ length: REQADD_NEW_ROWS }, (_, index) => index + 1).flatMap((row) => [
          {
            type: "input" as const,
            block_id: `new-title:${row}`,
            optional: true,
            label: plain(`新しい仕事${row}　仕事名`),
            element: {
              type: "plain_text_input" as const,
              action_id: "value",
              max_length: 200,
            },
          },
          {
            type: "input" as const,
            block_id: `new-date:${row}`,
            optional: true,
            label: plain(`新しい仕事${row}　目途日`),
            element: { type: "datepicker" as const, action_id: "value" },
          },
          {
            type: "input" as const,
            block_id: `new-parent:${row}`,
            optional: true,
            label: plain(`新しい仕事${row}　親`),
            element: {
              type: "static_select" as const,
              action_id: "value",
              placeholder: plain("親のWork・Businessを選択", 150),
              options: input.parents.map((parent) => option(parent.label, parent.value)),
            },
          },
        ]);
  const request = input.request;
  return {
    type: "modal" as const,
    callback_id: REQADD_INPUT_CALLBACK_ID,
    private_metadata: JSON.stringify(input.metadata),
    title: plain("仕事の入力", 24),
    submit: plain("送信", 24),
    close: plain("キャンセル", 24),
    blocks: [
      mrkdwnSection(
        [
          `*${escapeSlack(request.requesterName)}さんからのお願い*（期限 ${formatDueDate(request.dueDate)}）`,
          ...(request.note ? [escapeSlack(request.note)] : []),
        ].join("\n"),
      ),
      header("自分の未完了の仕事"),
      context(
        "状態と目途日を今の値に直してください。変えた項目だけProjectへ反映します。DoneにしてもIssueは閉じません。",
      ),
      ...(shown.length === 0
        ? [mrkdwnSection("担当していて未完了の仕事はありません。")]
        : itemBlocks),
      ...(hidden > 0 ? [context(`ほか ${hidden} 件はGitHubで更新してください。`)] : []),
      { type: "divider" as const },
      header("新しい仕事"),
      context(
        "仕事名を書いた行だけTaskとして作ります。空の行は無視します。目途日と親は必ず選んでください。",
      ),
      ...rowBlocks,
    ],
  };
}

export function parseInputMetadata(value: string): ReqaddInputMetadata | null {
  try {
    const parsed = JSON.parse(value) as Partial<ReqaddInputMetadata>;
    if (typeof parsed.requestId !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(parsed.requestId)) {
      return null;
    }
    const round = Number(parsed.round ?? 0);
    if (!Number.isSafeInteger(round) || round < 0) return null;
    return { requestId: parsed.requestId, slackTeamId: String(parsed.slackTeamId ?? ""), round };
  } catch {
    return null;
  }
}

/** 入力画面の送信値を読み、変えた上段の項目と、仕事名のある下段の行を返す。 */
export function validateInputSubmission(
  values: SlackStateValues,
): ReqaddValidation<ReqaddInputSubmission> {
  const errors: Record<string, string> = {};
  const changes: ReqaddItemChange[] = [];
  for (const [blockId, actions] of Object.entries(values)) {
    if (!blockId.startsWith("rs|")) continue;
    const key = decodeItemKey(blockId.slice(3));
    if (!key) continue;
    const status = actions.status?.selected_option?.value ?? null;
    const date = values[`rd|${blockId.slice(3)}`]?.date?.selected_date ?? null;
    const change: ReqaddItemChange = { key };
    if (
      status &&
      status !== key.status &&
      (REQADD_STATUSES as readonly string[]).includes(status)
    ) {
      change.status = status;
    }
    if (date && date !== key.targetDate) {
      if (!isValidDate(date)) {
        errors[`rd|${blockId.slice(3)}`] = "日付を選び直してください。";
        continue;
      }
      change.targetDate = date;
    }
    if (change.status !== undefined || change.targetDate !== undefined) changes.push(change);
  }
  const newRows: ReqaddNewRow[] = [];
  for (let row = 1; row <= REQADD_NEW_ROWS; row += 1) {
    const title = (values[`new-title:${row}`]?.value?.value ?? "").trim();
    if (!title) continue;
    const targetDate = values[`new-date:${row}`]?.value?.selected_date ?? "";
    const parent = values[`new-parent:${row}`]?.value?.selected_option?.value ?? "";
    if (!isValidDate(targetDate)) errors[`new-date:${row}`] = "目途日を選んでください。";
    if (!parent) errors[`new-parent:${row}`] = "親を選んでください。";
    if ([...title].length > 200) errors[`new-title:${row}`] = "仕事名は200文字までにしてください。";
    if (isValidDate(targetDate) && parent) newRows.push({ row, title, targetDate, parent });
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { changes, newRows } };
}

/** 親の選択値をIssue URLへ直す。"fallback"は設定のURL、それ以外はそのまま返す。 */
export function resolveParentValue(value: string, fallbackParentUrl: string | null): string | null {
  if (value === FALLBACK_PARENT_VALUE) return fallbackParentUrl;
  return value;
}

/** 入力結果を本人へ返すDMの本文。 */
export function inputResultText(result: {
  updated: string[];
  created: Array<{ title: string; url: string }>;
  alreadyCreated: string[];
  warnings: string[];
  failures: string[];
}): string {
  const lines = [
    `✅ 入力を受け付けました（新規 ${result.created.length} 件・更新 ${result.updated.length} 件）。`,
    ...result.created.map((issue) => `・作成: <${issue.url}|${escapeSlack(issue.title)}>`),
    ...result.updated.map((label) => `・更新: ${escapeSlack(label)}`),
    ...result.alreadyCreated.map(
      (title) => `・作成済みのため作りませんでした: ${escapeSlack(title)}`,
    ),
    ...result.warnings.map((warning) => `⚠️ ${escapeSlack(warning)}`),
    ...result.failures.map((failure) => `🚨 失敗: ${escapeSlack(failure)}`),
  ];
  return truncate(lines.join("\n"), 3500);
}
