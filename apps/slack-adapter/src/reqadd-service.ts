import { randomUUID } from "node:crypto";
import { buildCreateIssueCommand, MERGE_MODES } from "./issue-command.ts";
import type { IssueTemplateSchema } from "./issue-schema.ts";
import type {
  ProjectFieldInput,
  ProjectFieldSyncResult,
  ProjectStatus,
} from "./project-field-sync.ts";
import {
  addDays,
  allDoneReplyText,
  doneReplyText,
  inputResultText,
  jstToday,
  myOpenItems,
  overdueReplyText,
  parentOptions,
  REQADD_ITEM_LIMIT,
  type ReqaddInputMetadata,
  type ReqaddInputSubmission,
  type ReqaddProjectItem,
  type ReqaddRequest,
  type ReqaddRequestInput,
  type ReqaddRequestMetadata,
  type ReqaddValidation,
  reqaddInputModal,
  reqaddMessageModal,
  reqaddParentMessage,
  reqaddRequestDm,
  reqaddRequestModal,
  resolveParentValue,
  type SlackStateValues,
  truncate,
  validateRequestSubmission,
} from "./reqadd.ts";
import { resolveSlackDirectChannel } from "./slack-direct-notifier.ts";
import type { StateStore } from "./state-store.ts";
import type { CreatedIssue, CreateIssueCommand } from "./types.ts";

export const REQADD_REQUEST_NAMESPACE = "reqadd-request";
export const REQADD_TASK_NAMESPACE = "reqadd-task";

const DAY = 24 * 60 * 60 * 1000;
/** 依頼の記録を残す長さ（期限から）。FirestoreのTTL policyが`expireAt`で消す。 */
const RECORD_RETENTION_DAYS = 60;
/** 期限後の一覧を出す対象にする、期限からの日数の上限。古い依頼を毎日読み直さない。 */
const OVERDUE_LOOKBACK_DAYS = 14;
const MAX_UPDATE_ATTEMPTS = 5;
/** 作成中のまま残ったTask記録を、止まった処理とみなすまでの時間。 */
const STALE_TASK_CLAIM_MS = 10 * 60 * 1000;

export interface ReqaddSlackClient {
  chat: {
    postMessage(arguments_: {
      channel: string;
      text: string;
      blocks?: unknown[];
      thread_ts?: string;
      reply_broadcast?: boolean;
      unfurl_links?: boolean;
      unfurl_media?: boolean;
    }): Promise<{ ts?: string; channel?: string }>;
    update(arguments_: {
      channel: string;
      ts: string;
      text: string;
      blocks?: unknown[];
    }): Promise<unknown>;
    postEphemeral(arguments_: { channel: string; user: string; text: string }): Promise<unknown>;
  };
  conversations: {
    open(arguments_: { users: string; return_im: true }): Promise<{ channel?: { id?: string } }>;
  };
  users: {
    info(arguments_: { user: string }): Promise<{
      user?: {
        name?: string;
        real_name?: string;
        profile?: { display_name?: string; real_name?: string };
      };
    }>;
  };
}

export interface ReqaddGitHub {
  listReqaddProjectItems(): Promise<ReqaddProjectItem[]>;
  updateProjectItemFields(input: {
    issueNodeId: string;
    issueUrl: string;
    values: ProjectFieldInput;
  }): Promise<ProjectFieldSyncResult>;
  createIssue(command: CreateIssueCommand): Promise<CreatedIssue>;
  listIssueTemplatesForViewer(
    githubLogin: string,
    repository: string,
  ): Promise<IssueTemplateSchema[]>;
}

export interface ReqaddIdentity {
  get(slackTeamId: string, slackUserId: string): Promise<{ githubLogin: string } | null>;
  resolveCommand(command: CreateIssueCommand, slackTeamId: string): Promise<CreateIssueCommand>;
}

export interface ReqaddServiceOptions {
  store: StateStore;
  slack: ReqaddSlackClient;
  github: ReqaddGitHub;
  identity: ReqaddIdentity;
  /** `/ar reqadd`を使えるSlack user ID。 */
  requesterIds: Iterable<string>;
  /** 「その他の仕事」の親にするIssue URL。未設定なら選択肢を出さない。 */
  fallbackParentUrl?: string | null;
  now?: () => number;
  id?: () => string;
  itemLimit?: number;
}

export interface ReqaddTaskRecord {
  schemaVersion: 1;
  revision: number;
  status: "creating" | "created";
  requestId: string;
  slackUserId: string;
  round: number;
  row: number;
  title: string;
  repository: string;
  claimedAt: string;
  issue: { number: number; title: string; url: string } | null;
}

export interface ReqaddSubmitResult {
  updated: string[];
  created: Array<{ title: string; url: string }>;
  alreadyCreated: string[];
  warnings: string[];
  failures: string[];
  markedDone: boolean;
  doneNotified: boolean;
  allDoneNotified: boolean;
}

export interface ReqaddReminderResult {
  reminded: number;
  overdueNotified: number;
}

/** 依頼から入力、カード反映、進み具合の表示、再依頼までを受け持つ。 */
export class ReqaddService {
  private readonly store: StateStore;
  private readonly slack: ReqaddSlackClient;
  private readonly github: ReqaddGitHub;
  private readonly identity: ReqaddIdentity;
  private readonly requesterIds: ReadonlySet<string>;
  private readonly fallbackParentUrl: string | null;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly itemLimit: number;

  constructor(options: ReqaddServiceOptions) {
    this.store = options.store;
    this.slack = options.slack;
    this.github = options.github;
    this.identity = options.identity;
    this.requesterIds = new Set(options.requesterIds);
    this.fallbackParentUrl = options.fallbackParentUrl ?? null;
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
    this.itemLimit = options.itemLimit ?? REQADD_ITEM_LIMIT;
  }

  /** 依頼できる人か。できなければ本人へ返す理由を返す。 */
  requesterDenialReason(slackUserId: string): string | null {
    if (this.requesterIds.size === 0) {
      return "/ar reqaddを使える人が設定されていません。管理者にAR_SLACK_REQADD_REQUESTER_IDSの設定を依頼してください。";
    }
    if (!this.requesterIds.has(slackUserId)) {
      return "/ar reqaddは、仕事の入力を依頼する役の人だけが使えます。依頼が必要なときは管理者に相談してください。";
    }
    return null;
  }

  requestModal(metadata: ReqaddRequestMetadata) {
    return reqaddRequestModal(metadata, this.now());
  }

  validateRequest(values: SlackStateValues): ReqaddValidation<ReqaddRequestInput> {
    return validateRequestSubmission(values, this.now());
  }

  /** 本人へDMで知らせる。失敗してもSlackの操作処理を止めない。 */
  async notifyUser(slackUserId: string, text: string): Promise<void> {
    try {
      await this.sendDirect(slackUserId, { text });
    } catch (error) {
      console.error(`reqaddの知らせをDMで送れませんでした: ${errorMessage(error)}`);
    }
  }

  async getRequest(requestId: string): Promise<ReqaddRequest | null> {
    return this.store.get<ReqaddRequest>(REQADD_REQUEST_NAMESPACE, requestId);
  }

  // -------------------------------------------------------------------------
  // 依頼

  async createRequest(input: {
    slackTeamId: string;
    requesterSlackUserId: string;
    channelId: string;
    request: ReqaddRequestInput;
  }): Promise<ReqaddRequest> {
    const denial = this.requesterDenialReason(input.requesterSlackUserId);
    if (denial) throw new Error(denial);
    const [requesterName, ...recipientNames] = await Promise.all([
      this.displayName(input.requesterSlackUserId),
      ...input.request.recipients.map((slackUserId) => this.displayName(slackUserId)),
    ]);
    const identities = await Promise.all(
      input.request.recipients.map((slackUserId) =>
        this.identity.get(input.slackTeamId, slackUserId),
      ),
    );
    const record: ReqaddRequest = {
      schemaVersion: 1,
      requestId: this.id(),
      revision: 1,
      slackTeamId: input.slackTeamId,
      requesterSlackUserId: input.requesterSlackUserId,
      requesterName: requesterName ?? input.requesterSlackUserId,
      channelId: input.channelId,
      messageTs: null,
      dueDate: input.request.dueDate,
      note: input.request.note,
      createdAt: new Date(this.now()).toISOString(),
      recipients: input.request.recipients.map((slackUserId, index) => ({
        slackUserId,
        displayName: recipientNames[index] ?? slackUserId,
        status: identities[index] ? "pending" : "unlinked",
        createdCount: 0,
        updatedCount: 0,
        round: 0,
        firstDoneAt: null,
        lastSubmittedAt: null,
        doneNotifiedAt: null,
        reminderSentAt: null,
      })),
      allDoneNotifiedAt: null,
      overdueNotifiedAt: null,
    };
    if (
      !(await this.store.create(
        REQADD_REQUEST_NAMESPACE,
        record.requestId,
        record,
        this.expiry(record),
      ))
    ) {
      throw new Error("依頼のIDが重複しました。もう一度依頼してください。");
    }
    const message = reqaddParentMessage(record);
    let posted: { ts?: string };
    try {
      posted = await this.slack.chat.postMessage({
        channel: record.channelId,
        text: message.text,
        blocks: message.blocks,
        unfurl_links: false,
        unfurl_media: false,
      });
    } catch (error) {
      await this.store.remove(REQADD_REQUEST_NAMESPACE, record.requestId);
      throw new Error(
        `このチャンネルへ投稿できませんでした（${slackErrorCode(error)}）。Appをチャンネルへ追加してから、もう一度実行してください。`,
      );
    }
    const saved =
      (await this.mutate(record.requestId, (current) => {
        current.messageTs = posted.ts ?? null;
        return true;
      })) ?? record;
    const failed: string[] = [];
    for (const recipient of saved.recipients) {
      try {
        await this.sendDirect(recipient.slackUserId, reqaddRequestDm(saved, recipient, "request"));
      } catch {
        failed.push(recipient.displayName);
      }
    }
    if (failed.length > 0) {
      await this.notifyRequesterPrivately(
        saved,
        `⚠️ 次の相手へDMを送れませんでした: ${failed.join("、")}。本人に直接伝えてください。`,
      );
    }
    return saved;
  }

  // -------------------------------------------------------------------------
  // 入力画面

  /** 「入力する」ボタンから開く入力画面を作る。開けない理由はメッセージの画面にして返す。 */
  async buildInputView(input: {
    slackTeamId: string;
    slackUserId: string;
    requestId: string;
  }): Promise<unknown> {
    const request = await this.getRequest(input.requestId);
    if (!request)
      return reqaddMessageModal(
        "この依頼は見つかりません。期限から日数が経って消えた可能性があります。",
      );
    const recipient = request.recipients.find(
      (candidate) => candidate.slackUserId === input.slackUserId,
    );
    if (!recipient) return reqaddMessageModal("この依頼の相手ではないため、入力できません。");
    const teamId = request.slackTeamId || input.slackTeamId;
    const identity = await this.identity.get(teamId, input.slackUserId);
    if (!identity) {
      return reqaddMessageModal(
        "まだGitHubとの連携を確認できません。Slackで /ar connect github を実行して連携してから、もう一度ボタンを押してください。",
      );
    }
    let current = request;
    if (recipient.status === "unlinked") {
      current =
        (await this.mutate(request.requestId, (draft) => {
          const target = draft.recipients.find((item) => item.slackUserId === input.slackUserId);
          if (target?.status !== "unlinked") return false;
          target.status = "pending";
          return true;
        })) ?? request;
      await this.refreshParentPost(current);
    }
    const items = await this.github.listReqaddProjectItems();
    const round =
      current.recipients.find((candidate) => candidate.slackUserId === input.slackUserId)?.round ??
      0;
    const metadata: ReqaddInputMetadata = {
      requestId: request.requestId,
      slackTeamId: teamId,
      round,
    };
    return reqaddInputModal({
      metadata,
      request: current,
      items: myOpenItems(items, identity.githubLogin),
      parents: parentOptions(items, identity.githubLogin, this.fallbackParentUrl),
      itemLimit: this.itemLimit,
    });
  }

  // -------------------------------------------------------------------------
  // 入力の送信

  async submitInput(input: {
    slackUserId: string;
    metadata: ReqaddInputMetadata;
    submission: ReqaddInputSubmission;
  }): Promise<ReqaddSubmitResult> {
    const result: ReqaddSubmitResult = {
      updated: [],
      created: [],
      alreadyCreated: [],
      warnings: [],
      failures: [],
      markedDone: false,
      doneNotified: false,
      allDoneNotified: false,
    };
    try {
      await this.applySubmission(input, result);
    } catch (error) {
      result.failures.push(errorMessage(error));
    }
    try {
      await this.sendDirect(input.slackUserId, { text: inputResultText(result) });
    } catch (error) {
      console.error(`reqaddの入力結果をDMで返せませんでした: ${errorMessage(error)}`);
    }
    return result;
  }

  private async applySubmission(
    input: {
      slackUserId: string;
      metadata: ReqaddInputMetadata;
      submission: ReqaddInputSubmission;
    },
    result: ReqaddSubmitResult,
  ): Promise<void> {
    const request = await this.getRequest(input.metadata.requestId);
    if (!request) throw new Error("この依頼は見つかりません。");
    const recipient = request.recipients.find(
      (candidate) => candidate.slackUserId === input.slackUserId,
    );
    if (!recipient) throw new Error("この依頼の相手ではないため、入力できません。");
    const teamId = request.slackTeamId || input.metadata.slackTeamId;
    const identity = await this.identity.get(teamId, input.slackUserId);
    if (!identity) {
      throw new Error("GitHubとの連携を確認できません。/ar connect github を実行してください。");
    }
    const { changes, newRows } = input.submission;
    const items =
      changes.length > 0 || newRows.length > 0 ? await this.github.listReqaddProjectItems() : [];
    // 送信値は画面を開いた時点の値と比べた差分。書き換えは本人が担当する未完了の項目に限る。
    const mine = new Map(
      myOpenItems(items, identity.githubLogin).map((item) => [item.issueNodeId, item]),
    );
    for (const change of changes) {
      const item = mine.get(change.key.issueNodeId);
      if (!item) {
        result.failures.push("担当していない、または完了済みの項目は更新できません。");
        continue;
      }
      const label = `${item.repository}#${item.number} ${item.title}`;
      const values: ProjectFieldInput = {
        ...(change.status ? { status: change.status as ProjectStatus } : {}),
        ...(change.targetDate ? { targetDate: change.targetDate } : {}),
      };
      try {
        const synced = await this.github.updateProjectItemFields({
          issueNodeId: item.issueNodeId,
          issueUrl: item.url,
          values,
        });
        if (synced.status === "synced") {
          result.updated.push(label);
        } else {
          const reasons = synced.fields
            .filter((field) => field.status === "failed")
            .map((field) => `${field.field}: ${field.message ?? "反映を確認できませんでした"}`)
            .join(" / ");
          result.failures.push(`${label}（${reasons}）`);
        }
      } catch (error) {
        result.failures.push(`${label}（${errorMessage(error)}）`);
      }
    }
    for (const row of newRows) {
      await this.createTaskForRow({
        request,
        teamId,
        slackUserId: input.slackUserId,
        githubLogin: identity.githubLogin,
        round: input.metadata.round,
        row,
        items,
        result,
      });
    }
    const succeeded = result.updated.length + result.created.length + result.alreadyCreated.length;
    const attempted = changes.length + newRows.length;
    if (attempted > 0 && succeeded === 0) {
      // すべて失敗したときは「入力済み」にしない。直してからもう一度送ってもらう。
      return;
    }
    const claims = { done: false, allDone: false };
    const now = new Date(this.now()).toISOString();
    const saved = await this.mutate(request.requestId, (draft) => {
      const target = draft.recipients.find((item) => item.slackUserId === input.slackUserId);
      if (!target) return false;
      claims.done = false;
      claims.allDone = false;
      target.status = "done";
      target.createdCount += result.created.length;
      target.updatedCount += result.updated.length;
      target.round = Math.max(target.round, input.metadata.round + 1);
      target.firstDoneAt ??= now;
      target.lastSubmittedAt = now;
      if (target.doneNotifiedAt === null) {
        target.doneNotifiedAt = now;
        claims.done = true;
      }
      if (
        draft.allDoneNotifiedAt === null &&
        draft.recipients.every((item) => item.status === "done")
      ) {
        draft.allDoneNotifiedAt = now;
        claims.allDone = true;
      }
      return true;
    });
    if (!saved) throw new Error("入力の記録を保存できませんでした。もう一度送ってください。");
    result.markedDone = true;
    result.doneNotified = claims.done;
    result.allDoneNotified = claims.allDone;
    await this.refreshParentPost(saved);
    const savedRecipient = saved.recipients.find((item) => item.slackUserId === input.slackUserId);
    if (claims.done && savedRecipient) {
      await this.replyInThread(
        saved,
        doneReplyText(savedRecipient, result.created.length, result.updated.length),
      );
    }
    if (claims.allDone) await this.replyInThread(saved, allDoneReplyText(saved));
  }

  private async createTaskForRow(input: {
    request: ReqaddRequest;
    teamId: string;
    slackUserId: string;
    githubLogin: string;
    round: number;
    row: ReqaddInputSubmission["newRows"][number];
    items: ReqaddProjectItem[];
    result: ReqaddSubmitResult;
  }): Promise<void> {
    const { row, result } = input;
    const parentUrl = resolveParentValue(row.parent, this.fallbackParentUrl);
    const parent = parentUrl ? parseIssueUrl(parentUrl) : null;
    if (!parentUrl || !parent) {
      result.failures.push(`${row.title}（親のIssueを読み取れませんでした）`);
      return;
    }
    const isFallback = parentUrl === this.fallbackParentUrl;
    const parentItem = input.items.find((item) => item.url === parentUrl);
    if (
      !isFallback &&
      (!parentItem ||
        (parentItem.type !== "work" && parentItem.type !== "business") ||
        parentItem.status === "Done")
    ) {
      result.failures.push(`${row.title}（親は未完了のWork・Businessから選んでください）`);
      return;
    }
    const key = taskKey(input.request.requestId, input.slackUserId, input.round, row.row);
    const claim: ReqaddTaskRecord = {
      schemaVersion: 1,
      revision: 1,
      status: "creating",
      requestId: input.request.requestId,
      slackUserId: input.slackUserId,
      round: input.round,
      row: row.row,
      title: row.title,
      repository: parent.repository,
      claimedAt: new Date(this.now()).toISOString(),
      issue: null,
    };
    if (!(await this.claimTask(key, claim))) {
      const existing = await this.store.get<ReqaddTaskRecord>(REQADD_TASK_NAMESPACE, key);
      if (existing?.status === "created") {
        result.alreadyCreated.push(existing.issue?.title ?? existing.title);
      } else {
        result.failures.push(
          `${row.title}（同じ行を別の送信で作成中です。少し待ってDMの結果を確かめてください）`,
        );
      }
      return;
    }
    try {
      const templates = await this.github.listIssueTemplatesForViewer(
        input.githubLogin,
        parent.repository,
      );
      const schema = templates.find((template) => template.id === "task");
      if (!schema) throw new Error(`${parent.repository}にTaskのIssue templateがありません`);
      const command = buildCreateIssueCommand({
        repository: parent.repository,
        template: "task",
        title: row.title,
        fields: taskFields(schema, row.title, input.request),
        actor: input.slackUserId,
        slackTeamId: input.teamId,
        assigneeSlackUserIds: [input.slackUserId],
        mergeMode: MERGE_MODES[0],
        relationships: { parent: parentUrl },
        projectFields: { status: "Ready", targetDate: row.targetDate },
        schema,
      });
      const resolved = await this.identity.resolveCommand(command, input.teamId);
      const issue = await this.github.createIssue(resolved);
      const created: ReqaddTaskRecord = {
        ...claim,
        revision: 2,
        status: "created",
        issue: { number: issue.number, title: issue.title, url: issue.url },
      };
      await this.store.set(REQADD_TASK_NAMESPACE, key, created, this.expiry(input.request));
      result.created.push({ title: issue.title, url: issue.url });
      if (
        issue.relationshipStatus ||
        (issue.projectFieldStatus && issue.projectFieldStatus.status !== "synced")
      ) {
        result.warnings.push(
          `${issue.title}は作成済みですが、親の付与かProjectへの反映の一部が済んでいません。GitHubで確かめてください。`,
        );
      }
    } catch (error) {
      // 作成に失敗した行は記録を消し、直してから送り直せば作れるようにする。
      await this.store.remove(REQADD_TASK_NAMESPACE, key);
      result.failures.push(`${row.title}（${errorMessage(error)}）`);
    }
  }

  /** 行ごとのTask作成の権利を原子的に取る。止まった作成中の記録は奪い直す。 */
  private async claimTask(key: string, claim: ReqaddTaskRecord): Promise<boolean> {
    if (
      await this.store.create(REQADD_TASK_NAMESPACE, key, claim, { expireAt: this.taskExpiry() })
    ) {
      return true;
    }
    const existing = await this.store.get<ReqaddTaskRecord>(REQADD_TASK_NAMESPACE, key);
    if (
      existing?.status === "creating" &&
      this.now() - Date.parse(existing.claimedAt) > STALE_TASK_CLAIM_MS
    ) {
      return this.store.compareAndSet(
        REQADD_TASK_NAMESPACE,
        key,
        existing.revision,
        { ...claim, revision: existing.revision + 1 },
        { expireAt: this.taskExpiry() },
      );
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // 期限前日の再依頼と、期限後の一覧

  async sendReminders(): Promise<ReqaddReminderResult> {
    const today = jstToday(this.now());
    const tomorrow = addDays(today, 1);
    const oldest = addDays(today, -OVERDUE_LOOKBACK_DAYS);
    const result: ReqaddReminderResult = { reminded: 0, overdueNotified: 0 };
    const requests = await this.store.list<ReqaddRequest>(REQADD_REQUEST_NAMESPACE);
    for (const request of requests) {
      if (request.schemaVersion !== 1 || !request.messageTs) continue;
      try {
        if (request.dueDate === tomorrow) {
          result.reminded += await this.remindRecipients(request.requestId);
        } else if (request.dueDate < today && request.dueDate >= oldest) {
          if (await this.notifyOverdue(request.requestId)) result.overdueNotified += 1;
        }
      } catch (error) {
        console.error(
          `reqaddの再依頼に失敗しました（${request.requestId}）: ${errorMessage(error)}`,
        );
      }
    }
    return result;
  }

  private async remindRecipients(requestId: string): Promise<number> {
    let sent = 0;
    const request = await this.getRequest(requestId);
    for (const recipient of request?.recipients ?? []) {
      if (recipient.status === "done" || recipient.reminderSentAt !== null) continue;
      const now = new Date(this.now()).toISOString();
      const claim = { claimed: false };
      const saved = await this.mutate(requestId, (draft) => {
        const target = draft.recipients.find((item) => item.slackUserId === recipient.slackUserId);
        claim.claimed = false;
        if (!target || target.status === "done" || target.reminderSentAt !== null) return false;
        target.reminderSentAt = now;
        claim.claimed = true;
        return true;
      });
      if (!claim.claimed || !saved) continue;
      const current = saved.recipients.find((item) => item.slackUserId === recipient.slackUserId);
      if (!current) continue;
      try {
        await this.sendDirect(current.slackUserId, reqaddRequestDm(saved, current, "reminder"));
        sent += 1;
      } catch (error) {
        console.error(`reqaddの再依頼DMを送れませんでした: ${errorMessage(error)}`);
      }
    }
    return sent;
  }

  private async notifyOverdue(requestId: string): Promise<boolean> {
    const claim = { claimed: false };
    const now = new Date(this.now()).toISOString();
    const saved = await this.mutate(requestId, (draft) => {
      claim.claimed = false;
      if (draft.overdueNotifiedAt !== null) return false;
      draft.overdueNotifiedAt = now;
      claim.claimed = true;
      return true;
    });
    if (!claim.claimed || !saved) return false;
    const text = overdueReplyText(saved);
    if (!text) return false;
    await this.replyInThread(saved, text);
    return true;
  }

  // -------------------------------------------------------------------------
  // 共通

  private async mutate(
    requestId: string,
    change: (draft: ReqaddRequest) => boolean,
  ): Promise<ReqaddRequest | null> {
    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
      const current = await this.getRequest(requestId);
      if (!current) return null;
      const draft = structuredClone(current);
      if (!change(draft)) return current;
      draft.revision = current.revision + 1;
      if (
        await this.store.compareAndSet(
          REQADD_REQUEST_NAMESPACE,
          requestId,
          current.revision,
          draft,
          this.expiry(draft),
        )
      ) {
        return draft;
      }
    }
    throw new Error("依頼の記録が同時に更新され、保存できませんでした。もう一度送ってください。");
  }

  private async refreshParentPost(request: ReqaddRequest): Promise<void> {
    if (!request.messageTs) return;
    const message = reqaddParentMessage(request);
    try {
      await this.slack.chat.update({
        channel: request.channelId,
        ts: request.messageTs,
        text: message.text,
        blocks: message.blocks,
      });
    } catch (error) {
      console.error(`reqaddの親投稿を更新できませんでした: ${errorMessage(error)}`);
    }
  }

  private async replyInThread(request: ReqaddRequest, text: string): Promise<void> {
    if (!request.messageTs) return;
    try {
      await this.slack.chat.postMessage({
        channel: request.channelId,
        thread_ts: request.messageTs,
        reply_broadcast: false,
        text,
        unfurl_links: false,
        unfurl_media: false,
      });
    } catch (error) {
      console.error(`reqaddのthread返信に失敗しました: ${errorMessage(error)}`);
    }
  }

  private async sendDirect(
    slackUserId: string,
    message: { text: string; blocks?: unknown[] },
  ): Promise<void> {
    const channel = await resolveSlackDirectChannel(this.slack, slackUserId);
    await this.slack.chat.postMessage({
      channel,
      text: message.text,
      ...(message.blocks ? { blocks: message.blocks } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
  }

  private async notifyRequesterPrivately(request: ReqaddRequest, text: string): Promise<void> {
    try {
      await this.slack.chat.postEphemeral({
        channel: request.channelId,
        user: request.requesterSlackUserId,
        text,
      });
    } catch (error) {
      console.error(`reqaddの依頼者への知らせに失敗しました: ${errorMessage(error)}`);
    }
  }

  private async displayName(slackUserId: string): Promise<string> {
    try {
      const response = await this.slack.users.info({ user: slackUserId });
      const user = response.user;
      const name =
        user?.profile?.display_name?.trim() ||
        user?.profile?.real_name?.trim() ||
        user?.real_name?.trim() ||
        user?.name?.trim();
      return truncate(name || slackUserId, 80);
    } catch {
      return slackUserId;
    }
  }

  private expiry(request: Pick<ReqaddRequest, "dueDate">): { expireAt: Date } {
    return {
      expireAt: new Date(Date.parse(`${request.dueDate}T00:00:00Z`) + RECORD_RETENTION_DAYS * DAY),
    };
  }

  private taskExpiry(): Date {
    return new Date(this.now() + (RECORD_RETENTION_DAYS + 30) * DAY);
  }
}

export function taskKey(
  requestId: string,
  slackUserId: string,
  round: number,
  row: number,
): string {
  return `${requestId}:${slackUserId}:${round}:${row}`;
}

/** Task templateの必須欄を、仕事名と依頼から埋める。 */
function taskFields(
  schema: IssueTemplateSchema,
  title: string,
  request: ReqaddRequest,
): Record<string, string> {
  const source = `Slackの /ar reqadd（${request.requesterName}さんの依頼、期限 ${request.dueDate}）で登録しました。`;
  const fields: Record<string, string> = {};
  for (const field of schema.fields) {
    if (field.id === "merge" || field.id === "parent") continue;
    if (field.id === "action") {
      fields.action = `${title}\n\n${source}`;
    } else if (field.id === "done") {
      fields.done = `- [ ] ${title}`;
    } else if (field.kind === "select") {
      // Issue作成commandは任意のselectでも選択肢の値を求めるため、先頭の選択肢を入れる。
      fields[field.id] = field.options?.[0] ?? "";
    } else if (field.required) {
      fields[field.id] = source;
    }
  }
  return fields;
}

function parseIssueUrl(value: string): { repository: string; number: number } | null {
  const match = value.match(
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)\/?$/,
  );
  if (!match?.[1] || !match[2]) return null;
  return { repository: match[1], number: Number(match[2]) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "処理に失敗しました。";
}

function slackErrorCode(error: unknown): string {
  const code =
    error && typeof error === "object" && "data" in error
      ? (error.data as { error?: unknown } | undefined)?.error
      : undefined;
  return typeof code === "string" ? code : errorMessage(error);
}
