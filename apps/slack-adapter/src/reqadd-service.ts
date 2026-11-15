import { createHash, randomUUID } from "node:crypto";
import { buildCreateIssueCommand, MERGE_MODES } from "./issue-command.ts";
import { isIssueNotCreated } from "./issue-not-created.ts";
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
/** 作成要求を送る前のまま残ったTask記録を、止まった処理とみなすまでの時間。 */
const STALE_TASK_CLAIM_MS = 10 * 60 * 1000;
/** 送信中の印が残った知らせを、止まった処理とみなして送り直すまでの時間。 */
const STALE_NOTIFY_CLAIM_MS = 10 * 60 * 1000;
/** 親投稿を描き直す回数の上限。描いている間に記録が進んだ時だけ描き直す。 */
const MAX_PARENT_REFRESHES = 3;

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
  /**
   * creating: 権利を取ったが、まだGitHubへ作成要求を送っていない。止まったら奪い直してよい。
   * sending: 作成要求を送った後で、作られたか確かめられていない。再送では作らない。
   * created: 作成を確かめた。
   */
  status: "creating" | "sending" | "created";
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
  /** 作成要求を送ったが、作られたか確かめられなかった行の仕事名。 */
  uncertain: string[];
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
    // 親投稿のtsを記録できなくても、相手へのDMは送る。DMはtsを使わない。
    let saved = record;
    try {
      saved =
        (await this.mutate(record.requestId, (current) => {
          current.messageTs = posted.ts ?? null;
          return true;
        })) ?? record;
    } catch (error) {
      console.error(
        `reqaddの親投稿のtsを記録できませんでした（${record.requestId}）: ${errorMessage(error)}`,
      );
      await this.notifyRequesterPrivately(
        record,
        "⚠️ 進み具合の投稿を記録できませんでした。相手へのDMは送りますが、この投稿の進み具合は更新されず、期限前日の再依頼と期限後の一覧も出ません。",
      );
    }
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
      await this.refreshParentPost(request.requestId);
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
      uncertain: [],
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
    const now = new Date(this.now()).toISOString();
    const complete = result.failures.length === 0 && result.uncertain.length === 0;
    if (!complete) {
      // 一部でも失敗したら「入力済み」にしない。済んだ件数だけ記録し、直してもう一度送ってもらう。
      // roundを進めないため、同じ仕事名の行を送り直してもTaskは作り直さない。
      if (result.created.length + result.updated.length > 0) {
        await this.mutate(request.requestId, (draft) => {
          const target = draft.recipients.find((item) => item.slackUserId === input.slackUserId);
          if (!target) return false;
          target.createdCount += result.created.length;
          target.updatedCount += result.updated.length;
          target.lastSubmittedAt = now;
          return true;
        });
      }
      return;
    }
    const saved = await this.mutate(request.requestId, (draft) => {
      const target = draft.recipients.find((item) => item.slackUserId === input.slackUserId);
      if (!target) return false;
      target.status = "done";
      target.createdCount += result.created.length;
      target.updatedCount += result.updated.length;
      target.round = Math.max(target.round, input.metadata.round + 1);
      target.firstDoneAt ??= now;
      target.lastSubmittedAt = now;
      return true;
    });
    if (!saved) throw new Error("入力の記録を保存できませんでした。もう一度送ってください。");
    result.markedDone = true;
    await this.refreshParentPost(request.requestId);
    result.doneNotified = await this.notifyDone(
      request.requestId,
      input.slackUserId,
      result.created.length,
      result.updated.length,
    );
    result.allDoneNotified = await this.notifyAllDone(request.requestId);
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
    const key = taskKey(
      input.request.requestId,
      input.slackUserId,
      input.round,
      row.row,
      row.title,
    );
    const claimedAt = new Date(this.now()).toISOString();
    const claim = await this.claimTask(key, {
      schemaVersion: 1,
      revision: 1,
      status: "creating",
      requestId: input.request.requestId,
      slackUserId: input.slackUserId,
      round: input.round,
      row: row.row,
      title: row.title,
      repository: parent.repository,
      claimedAt,
      issue: null,
    });
    if (!claim) {
      const existing = await this.store.get<ReqaddTaskRecord>(REQADD_TASK_NAMESPACE, key);
      if (existing?.status === "created") {
        result.alreadyCreated.push(existing.issue?.title ?? existing.title);
      } else if (existing?.status === "sending") {
        result.uncertain.push(row.title);
      } else {
        result.failures.push(
          `${row.title}（同じ行を別の送信で作成中です。少し待ってDMの結果を確かめてください）`,
        );
      }
      return;
    }
    let resolved: CreateIssueCommand;
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
      resolved = await this.identity.resolveCommand(command, input.teamId);
    } catch (error) {
      // 作成要求を送る前の失敗。記録を消し、直してから送り直せば作れるようにする。
      await this.releaseTaskClaim(key);
      result.failures.push(`${row.title}（${errorMessage(error)}）`);
      return;
    }
    // 作成要求を送る前に「送った」ことを記録する。止まった処理の記録を奪い直してよいのは、この記録より前だけ。
    const sending: ReqaddTaskRecord = { ...claim, revision: claim.revision + 1, status: "sending" };
    let marked = false;
    try {
      marked = await this.store.compareAndSet(REQADD_TASK_NAMESPACE, key, claim.revision, sending, {
        expireAt: this.taskExpiry(),
      });
    } catch (error) {
      await this.releaseTaskClaim(key);
      result.failures.push(
        `${row.title}（作成の準備を記録できませんでした: ${errorMessage(error)}）`,
      );
      return;
    }
    if (!marked) {
      result.failures.push(
        `${row.title}（同じ行を別の送信で作成中です。少し待ってDMの結果を確かめてください）`,
      );
      return;
    }
    let issue: CreatedIssue;
    try {
      issue = await this.github.createIssue(resolved);
    } catch (error) {
      if (isIssueNotCreated(error)) {
        // GitHubが作っていないと確定できる失敗だけ、記録を消して送り直せるようにする。
        await this.releaseTaskClaim(key);
        result.failures.push(`${row.title}（${errorMessage(error)}）`);
        return;
      }
      // timeoutなど、GitHub側で作られた可能性が残る失敗。記録はsendingのまま残し、再送で作らない。
      console.error(`reqaddのTaskが作られたか確認できません（${key}）: ${errorMessage(error)}`);
      result.uncertain.push(row.title);
      return;
    }
    const created: ReqaddTaskRecord = {
      ...sending,
      revision: sending.revision + 1,
      status: "created",
      issue: { number: issue.number, title: issue.title, url: issue.url },
    };
    try {
      if (
        !(await this.store.compareAndSet(
          REQADD_TASK_NAMESPACE,
          key,
          sending.revision,
          created,
          this.expiry(input.request),
        ))
      ) {
        console.error(`reqaddのTask作成の記録が先に書き換えられていました（${key}）`);
      }
    } catch (error) {
      // 作成は済んでいる。記録はsendingのまま残るため、再送しても作り直さない。
      console.error(`reqaddのTask作成を記録できませんでした（${key}）: ${errorMessage(error)}`);
    }
    result.created.push({ title: issue.title, url: issue.url });
    if (
      issue.relationshipStatus ||
      (issue.projectFieldStatus && issue.projectFieldStatus.status !== "synced")
    ) {
      result.warnings.push(
        `${issue.title}は作成済みですが、親の付与かProjectへの反映の一部が済んでいません。GitHubで確かめてください。`,
      );
    }
  }

  /** 行ごとのTask作成の権利を原子的に取り、取れた記録を返す。作成要求を送る前に止まった記録は奪い直す。 */
  private async claimTask(key: string, claim: ReqaddTaskRecord): Promise<ReqaddTaskRecord | null> {
    if (
      await this.store.create(REQADD_TASK_NAMESPACE, key, claim, { expireAt: this.taskExpiry() })
    ) {
      return claim;
    }
    const existing = await this.store.get<ReqaddTaskRecord>(REQADD_TASK_NAMESPACE, key);
    if (
      existing?.status === "creating" &&
      this.now() - Date.parse(existing.claimedAt) > STALE_TASK_CLAIM_MS
    ) {
      const reclaimed = { ...claim, revision: existing.revision + 1 };
      return (await this.store.compareAndSet(
        REQADD_TASK_NAMESPACE,
        key,
        existing.revision,
        reclaimed,
        { expireAt: this.taskExpiry() },
      ))
        ? reclaimed
        : null;
    }
    return null;
  }

  private async releaseTaskClaim(key: string): Promise<void> {
    try {
      await this.store.remove(REQADD_TASK_NAMESPACE, key);
    } catch (error) {
      console.error(`reqaddのTask作成の記録を消せませんでした（${key}）: ${errorMessage(error)}`);
    }
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
        if (
          request.dueDate >= oldest &&
          request.allDoneNotifiedAt === null &&
          request.recipients.every((recipient) => recipient.status === "done")
        ) {
          // 入力の送信時に全員完了の知らせを送れなかった依頼は、ここで送り直す。
          await this.notifyAllDone(request.requestId);
        }
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
      const delivered = await this.sendOnce({
        requestId,
        label: "再依頼DM",
        claim: (draft, now) => {
          const target = draft.recipients.find(
            (item) => item.slackUserId === recipient.slackUserId,
          );
          if (
            !target ||
            target.status === "done" ||
            !this.claimable(target.reminderSentAt, target.reminderClaimedAt)
          ) {
            return false;
          }
          target.reminderClaimedAt = now;
          return true;
        },
        send: async (saved) => {
          const current = saved.recipients.find(
            (item) => item.slackUserId === recipient.slackUserId,
          );
          if (!current) return false;
          await this.sendDirect(current.slackUserId, reqaddRequestDm(saved, current, "reminder"));
          return true;
        },
        settle: (draft, sentAt) => {
          const target = draft.recipients.find(
            (item) => item.slackUserId === recipient.slackUserId,
          );
          if (!target) return false;
          target.reminderClaimedAt = null;
          if (sentAt) target.reminderSentAt = sentAt;
          return true;
        },
      });
      if (delivered) sent += 1;
    }
    return sent;
  }

  private async notifyOverdue(requestId: string): Promise<boolean> {
    return this.sendOnce({
      requestId,
      label: "期限後の一覧",
      claim: (draft, now) => {
        if (!this.claimable(draft.overdueNotifiedAt, draft.overdueClaimedAt)) return false;
        draft.overdueClaimedAt = now;
        return true;
      },
      send: async (saved) => {
        const text = overdueReplyText(saved);
        return text ? this.postThread(saved, text) : false;
      },
      settle: (draft, sentAt) => {
        draft.overdueClaimedAt = null;
        if (sentAt) draft.overdueNotifiedAt = sentAt;
        return true;
      },
    });
  }

  /** 「〇〇さんが入力しました」をthreadへ1回だけ出す。 */
  private async notifyDone(
    requestId: string,
    slackUserId: string,
    created: number,
    updated: number,
  ): Promise<boolean> {
    return this.sendOnce({
      requestId,
      label: "入力の知らせ",
      claim: (draft, now) => {
        const target = draft.recipients.find((item) => item.slackUserId === slackUserId);
        if (
          target?.status !== "done" ||
          !this.claimable(target.doneNotifiedAt, target.doneNotifyClaimedAt)
        ) {
          return false;
        }
        target.doneNotifyClaimedAt = now;
        return true;
      },
      send: async (saved) => {
        const target = saved.recipients.find((item) => item.slackUserId === slackUserId);
        return target ? this.postThread(saved, doneReplyText(target, created, updated)) : false;
      },
      settle: (draft, sentAt) => {
        const target = draft.recipients.find((item) => item.slackUserId === slackUserId);
        if (!target) return false;
        target.doneNotifyClaimedAt = null;
        if (sentAt) target.doneNotifiedAt = sentAt;
        return true;
      },
    });
  }

  /** 全員が入力したら、threadで依頼者を1回だけmentionする。 */
  private async notifyAllDone(requestId: string): Promise<boolean> {
    return this.sendOnce({
      requestId,
      label: "全員完了の知らせ",
      claim: (draft, now) => {
        if (
          !draft.recipients.every((item) => item.status === "done") ||
          !this.claimable(draft.allDoneNotifiedAt, draft.allDoneNotifyClaimedAt)
        ) {
          return false;
        }
        draft.allDoneNotifyClaimedAt = now;
        return true;
      },
      send: async (saved) => this.postThread(saved, allDoneReplyText(saved)),
      settle: (draft, sentAt) => {
        draft.allDoneNotifyClaimedAt = null;
        if (sentAt) draft.allDoneNotifiedAt = sentAt;
        return true;
      },
    });
  }

  /**
   * 1回だけ出す知らせを送る。送信中の印を記録してから送り、送れたら送信済みに、
   * 送れなければ印を戻して次の機会に送り直せるようにする。印は同時の二重送信を防ぐ。
   * `send`がfalseを返したら、送るものが無いとみなして送信済みにする。送れた時だけtrueを返す。
   */
  private async sendOnce(input: {
    requestId: string;
    label: string;
    claim: (draft: ReqaddRequest, now: string) => boolean;
    send: (saved: ReqaddRequest) => Promise<boolean>;
    settle: (draft: ReqaddRequest, sentAt: string | null) => boolean;
  }): Promise<boolean> {
    const now = new Date(this.now()).toISOString();
    let claimed = false;
    let saved: ReqaddRequest | null;
    try {
      saved = await this.mutate(input.requestId, (draft) => {
        claimed = input.claim(draft, now);
        return claimed;
      });
    } catch (error) {
      console.error(`reqaddの${input.label}の送信を始められませんでした: ${errorMessage(error)}`);
      return false;
    }
    if (!claimed || !saved) return false;
    let delivered = false;
    let settled = false;
    try {
      delivered = await input.send(saved);
      settled = true;
    } catch (error) {
      console.error(`reqaddの${input.label}を送れませんでした: ${errorMessage(error)}`);
    }
    const sentAt = settled ? new Date(this.now()).toISOString() : null;
    try {
      await this.mutate(input.requestId, (draft) => input.settle(draft, sentAt));
    } catch (error) {
      // 印が残っても、STALE_NOTIFY_CLAIM_MSを過ぎれば次の機会に扱い直す。
      console.error(
        `reqaddの${input.label}の送信結果を記録できませんでした: ${errorMessage(error)}`,
      );
    }
    return delivered;
  }

  /** まだ送っておらず、送信中の印も無い（または止まった処理の古い印だけがある）か。 */
  private claimable(sentAt: string | null, claimedAt: string | null | undefined): boolean {
    if (sentAt !== null) return false;
    if (!claimedAt) return true;
    return this.now() - Date.parse(claimedAt) > STALE_NOTIFY_CLAIM_MS;
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

  /**
   * 親投稿を最新の記録で描き直す。chat.updateは送信ごとに別々に呼ぶため、描く直前に記録を読み直し、
   * 描いている間に記録が進んでいたら描き直す。古い状態が後から上書きして残らないようにする。
   */
  private async refreshParentPost(requestId: string): Promise<void> {
    let drawnRevision: number | null = null;
    for (let attempt = 0; attempt < MAX_PARENT_REFRESHES; attempt += 1) {
      let latest: ReqaddRequest | null;
      try {
        latest = await this.getRequest(requestId);
      } catch (error) {
        console.error(`reqaddの親投稿を描くための記録を読めませんでした: ${errorMessage(error)}`);
        return;
      }
      if (!latest?.messageTs || latest.revision === drawnRevision) return;
      const message = reqaddParentMessage(latest);
      try {
        await this.slack.chat.update({
          channel: latest.channelId,
          ts: latest.messageTs,
          text: message.text,
          blocks: message.blocks,
        });
      } catch (error) {
        console.error(`reqaddの親投稿を更新できませんでした: ${errorMessage(error)}`);
        return;
      }
      drawnRevision = latest.revision;
    }
  }

  /** threadへ返信する。失敗は投げる。親投稿が無ければ送らずfalseを返す。 */
  private async postThread(request: ReqaddRequest, text: string): Promise<boolean> {
    if (!request.messageTs) return false;
    await this.slack.chat.postMessage({
      channel: request.channelId,
      thread_ts: request.messageTs,
      reply_broadcast: false,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
    return true;
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

/**
 * Task作成の重複防止key。仕事名の正規化したhashを含め、同じ行番号に別の仕事を書いた
 * 別の画面の送信を「作成済み」として捨てないようにする。同じ仕事名の再送は同じkeyになる。
 */
export function taskKey(
  requestId: string,
  slackUserId: string,
  round: number,
  row: number,
  title: string,
): string {
  return `${requestId}:${slackUserId}:${round}:${row}:${titleHash(title)}`;
}

function titleHash(title: string): string {
  const normalized = title.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
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
