import type { HumanWorkItem, WorkStatus } from "./types.ts";

/**
 * 日次digestの出し方。
 * listはその時点の未完了一覧を出す従来方式、diffは前回のスナップショットからの差分だけを出す方式。
 */
export type DigestMode = "list" | "diff";

export const DIGEST_MODE_ENV = "AR_DIGEST_MODE";

/** 未設定は既存の挙動を守るためlistにする。それ以外の値は起動時に拒否する。 */
export function parseDigestMode(value: string | undefined): DigestMode {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return "list";
  if (normalized === "list" || normalized === "diff") return normalized;
  throw new Error(`${DIGEST_MODE_ENV}にはlistまたはdiffを指定してください。`);
}

/**
 * diffはProject #8の取得（closeしたIssueと種別を含む）を前提にする。
 * Projectが未設定だとclose済みが「Projectから外れた」、種別がすべてWorkになるため、起動時に拒否する。
 */
export function assertDiffDigestProject(
  mode: DigestMode,
  project: { owner: string; number: number } | null,
): void {
  if (mode === "diff" && !project) {
    throw new Error(
      `${DIGEST_MODE_ENV}=diffにはAR_GITHUB_PROJECT_OWNERとAR_GITHUB_PROJECT_NUMBERの設定が必要です。`,
    );
  }
}

export type DigestItemType = "intake" | "work" | "business" | "task";

/** Project #8の1項目を、差分の比較に使う欄だけへ正規化したもの。 */
export interface DigestSnapshotItem {
  url: string;
  type: DigestItemType;
  parentUrl: string | null;
  title: string;
  status: WorkStatus;
  /** 担当者のGitHub login一覧。 */
  owner: string[];
  targetDate: string | null;
  reasonCode: HumanWorkItem["reasonCode"];
}

/** 日付（JST）ごとに保存するスナップショット。完了済み（Done・close）の項目は持たない。 */
export interface DigestSnapshot {
  schemaVersion: 1;
  date: string;
  takenAt: string;
  /** この日の差分の比較元にした日付。初回はnull。 */
  baselineDate: string | null;
  items: DigestSnapshotItem[];
}

/**
 * 並び順の分類。attentionは止まり・期限超過、changedは状態・担当・期限の変更、
 * removedはProjectから外れた項目（完了とは分ける）。
 */
export type DigestCategory = "attention" | "completed" | "new" | "changed" | "removed";

const CATEGORY_RANK: Record<DigestCategory, number> = {
  attention: 0,
  completed: 1,
  new: 2,
  changed: 3,
  removed: 4,
};

export interface DigestChange {
  category: DigestCategory;
  item: DigestSnapshotItem;
  /** 人が読む変化の説明。順に「、」でつなぐ。 */
  details: string[];
}

export interface WorkDiffDigestLine {
  category: DigestCategory;
  url: string;
  issueNumber: number | null;
  title: string;
  detail: string;
}

export interface WorkDiffDigestGroup {
  /** parentはProject #8に無く種別の分からない親Issue。 */
  kind: "work" | "business" | "parent" | "other";
  /** 親のWork・Business（またはProject外の親Issue）のURL。「その他」はnull。 */
  url: string | null;
  issueNumber: number | null;
  title: string;
  lines: WorkDiffDigestLine[];
  /** 行数の上限で省いた変化の数。 */
  hiddenLineCount: number;
}

/** 通知outboxへ渡す差分digestの中身。描画に必要な値だけを持ち、Slack blockは持たない。 */
export interface WorkDiffDigest {
  schemaVersion: 1;
  date: string;
  baselineDate: string;
  groups: WorkDiffDigestGroup[];
  /** Work・Businessの件数上限で省いたブロック数と、その中の変化の数。 */
  hiddenGroupCount: number;
  hiddenGroupChangeCount: number;
  counts: Record<DigestCategory, number>;
}

export const DIGEST_LIMITS = {
  /** Work・Businessのブロック数の上限。「その他」は数えない。 */
  groups: 10,
  /** 1ブロックに出す行数の上限。 */
  linesPerGroup: 5,
  /** 1行に出すIssueタイトルの最大文字数。 */
  titleLength: 80,
} as const;

/**
 * 取得結果が一時的に欠けた日を見分ける閾値。
 * 権限の変更やProjectの一時的な欠落で項目が大量に消えた日に、「Projectから外れた」を大量に投稿し、
 * 欠けたスナップショットを比較の基準にしてしまうのを防ぐ。
 */
export const DIGEST_SOURCE_GUARD = {
  /** 前回のスナップショットの項目数がこれ未満なら判定しない。少ない件数では割合がぶれるため。 */
  minPreviousItems: 10,
  /** 「Projectから外れた」が前回の項目数のこの割合（%）以上なら欠けたとみなす。 */
  removedPercent: 30,
  /** 今回の未完了の項目数が前回のこの割合（%）未満なら欠けたとみなす。 */
  retainedPercent: 50,
} as const;

/**
 * 前回のスナップショットと今回の項目を比べ、取得結果が欠けていそうなら理由を返す。問題なければnull。
 * 件数はどちらもスナップショットに残す未完了の項目で数える。
 */
export function incompleteSourceReason(
  baseline: DigestSnapshot,
  current: DigestSnapshotItem[],
): string | null {
  const previous = baseline.items.filter((item) => item.status !== "done");
  if (previous.length < DIGEST_SOURCE_GUARD.minPreviousItems) return null;
  const currentUrls = new Set(current.map((item) => item.url));
  const removed = previous.filter((item) => !currentUrls.has(item.url)).length;
  const open = current.filter((item) => item.status !== "done").length;
  if (removed * 100 >= previous.length * DIGEST_SOURCE_GUARD.removedPercent) {
    return `Projectから外れた項目が${removed}件で、前回の${previous.length}件の${DIGEST_SOURCE_GUARD.removedPercent}%以上です。`;
  }
  if (open * 100 < previous.length * DIGEST_SOURCE_GUARD.retainedPercent) {
    return `未完了の項目が${open}件で、前回の${previous.length}件の${DIGEST_SOURCE_GUARD.retainedPercent}%未満です。`;
  }
  return null;
}

/** Issue URLから番号を読む。読めなければnull。 */
export function issueNumberFromUrl(url: string): number | null {
  const match = /\/issues\/(\d+)(?:[/?#]|$)/.exec(url);
  return match ? Number(match[1]) : null;
}

export function normalizeDigestItem(item: HumanWorkItem): DigestSnapshotItem {
  const owners = item.assignees ?? (item.owner ? [item.owner] : []);
  return {
    url: item.url,
    type: item.issueType ?? "work",
    parentUrl: item.parentUrl ?? null,
    title: item.title,
    status: item.status,
    owner: [...new Set(owners)].sort((left, right) =>
      left.toLowerCase().localeCompare(right.toLowerCase()),
    ),
    targetDate: item.targetDate,
    reasonCode: item.reasonCode,
  };
}

/** スナップショットへ残す項目。完了済みは次回の比較に要らないため持たない。 */
export function snapshotItems(items: DigestSnapshotItem[]): DigestSnapshotItem[] {
  return items
    .filter((item) => item.status !== "done")
    .sort((left, right) => left.url.localeCompare(right.url));
}

/**
 * 前回のスナップショットと今回の全項目（closeしたIssueを含む）を比べて変化を返す。
 * 今回の項目でclose済みのものはstatusをdoneにしてから渡す。
 */
export function diffDigestItems(
  baseline: DigestSnapshot,
  current: DigestSnapshotItem[],
  today: string,
): DigestChange[] {
  const previous = new Map(baseline.items.map((item) => [item.url, item]));
  const currentByUrl = new Map(current.map((item) => [item.url, item]));
  const changes: DigestChange[] = [];

  for (const item of current) {
    const before = previous.get(item.url);
    if (!before) {
      if (item.status === "done") continue;
      changes.push({ category: "new", item, details: [newItemDetail(item)] });
      continue;
    }
    if (item.status === "done") {
      changes.push({ category: "completed", item, details: ["完了"] });
      continue;
    }
    const details: string[] = [];
    let attention = false;
    if (item.reasonCode === "BLOCKED" && before.reasonCode !== "BLOCKED") {
      details.push("止まった");
      attention = true;
    }
    if (isOverdue(item, today) && !isOverdue(before, baseline.date)) {
      details.push(`期限超過（目標日 ${item.targetDate}）`);
      attention = true;
    }
    if (before.reasonCode === "BLOCKED" && item.reasonCode !== "BLOCKED") {
      details.push("止まりが解消");
    }
    if (before.status !== item.status) {
      details.push(`状態 ${statusLabel(before.status)} → ${statusLabel(item.status)}`);
    }
    if (!sameOwners(before.owner, item.owner)) {
      details.push(`担当 ${ownerLabel(before.owner)} → ${ownerLabel(item.owner)}`);
    }
    if (before.targetDate !== item.targetDate) {
      details.push(`期限 ${before.targetDate ?? "なし"} → ${item.targetDate ?? "なし"}`);
    }
    if (details.length > 0) {
      changes.push({ category: attention ? "attention" : "changed", item, details });
    }
  }

  for (const before of baseline.items) {
    if (currentByUrl.has(before.url) || before.status === "done") continue;
    changes.push({ category: "removed", item: before, details: ["Projectから外れた"] });
  }
  return changes;
}

/**
 * 変化をWork・Businessごとのブロックへまとめ、件数の上限を当てる。
 * Taskは親（parentUrl）のブロックへ入れ、親が分からないTaskとIntakeは「その他」へ入れる。
 */
export function buildWorkDiffDigest(
  changes: DigestChange[],
  context: {
    date: string;
    baselineDate: string;
    /** 親の種別とタイトルを引くための項目（今回と前回の両方）。 */
    knownItems: DigestSnapshotItem[];
  },
): WorkDiffDigest | null {
  if (changes.length === 0) return null;
  const known = new Map<string, DigestSnapshotItem>();
  for (const item of context.knownItems) {
    if (!known.has(item.url)) known.set(item.url, item);
  }

  interface Bucket {
    kind: WorkDiffDigestGroup["kind"];
    url: string | null;
    title: string;
    changes: DigestChange[];
  }
  const buckets = new Map<string, Bucket>();
  const other: Bucket = { kind: "other", url: null, title: "その他", changes: [] };
  const bucketFor = (
    url: string,
    kind: Exclude<WorkDiffDigestGroup["kind"], "other">,
    title: string,
  ): Bucket => {
    const existing = buckets.get(url);
    if (existing) return existing;
    const created: Bucket = { kind, url, title, changes: [] };
    buckets.set(url, created);
    return created;
  };

  for (const change of changes) {
    const { item } = change;
    if (item.type === "work" || item.type === "business") {
      bucketFor(item.url, item.type, item.title).changes.push(change);
      continue;
    }
    if (item.type === "task" && item.parentUrl) {
      const parent = known.get(item.parentUrl);
      if (!parent) {
        // 親がProjectに無くても、親のIssueは分かるのでそのブロックへまとめる。
        // 種別とタイトルは分からないため、描画側で「親: #番号」とだけ出す。
        const title = issueNumberFromUrl(item.parentUrl) === null ? item.parentUrl : "";
        bucketFor(item.parentUrl, "parent", title).changes.push(change);
        continue;
      }
      if (parent.type === "work" || parent.type === "business") {
        bucketFor(parent.url, parent.type, parent.title).changes.push(change);
        continue;
      }
    }
    other.changes.push(change);
  }

  const ranked = [...buckets.values()].sort(
    (left, right) =>
      bestRank(left.changes) - bestRank(right.changes) ||
      right.changes.length - left.changes.length ||
      (issueNumberFromUrl(left.url ?? "") ?? 0) - (issueNumberFromUrl(right.url ?? "") ?? 0) ||
      (left.url ?? "").localeCompare(right.url ?? ""),
  );
  const visible = ranked.slice(0, DIGEST_LIMITS.groups);
  const hidden = ranked.slice(DIGEST_LIMITS.groups);
  if (other.changes.length > 0) visible.push(other);

  const counts: Record<DigestCategory, number> = {
    attention: 0,
    completed: 0,
    new: 0,
    changed: 0,
    removed: 0,
  };
  for (const change of changes) counts[change.category] += 1;

  return {
    schemaVersion: 1,
    date: context.date,
    baselineDate: context.baselineDate,
    groups: visible.map((bucket) => {
      const lines = [...bucket.changes].sort(compareChanges).map(digestLine);
      return {
        kind: bucket.kind,
        url: bucket.url,
        issueNumber: bucket.url ? issueNumberFromUrl(bucket.url) : null,
        title: bucket.title,
        lines: lines.slice(0, DIGEST_LIMITS.linesPerGroup),
        hiddenLineCount: Math.max(0, lines.length - DIGEST_LIMITS.linesPerGroup),
      };
    }),
    hiddenGroupCount: hidden.length,
    hiddenGroupChangeCount: hidden.reduce((total, bucket) => total + bucket.changes.length, 0),
    counts,
  };
}

export function digestLineCount(digest: WorkDiffDigest): number {
  return digest.groups.reduce((total, group) => total + group.lines.length, 0);
}

export function statusLabel(status: WorkStatus): string {
  const labels: Record<WorkStatus, string> = {
    triage: "受付",
    todo: "着手待ち",
    "urgent-unstarted": "未着手・緊急",
    "in-progress": "進行中",
    blocked: "ブロック中",
    "in-review": "レビュー中",
    done: "完了",
  };
  return labels[status];
}

function newItemDetail(item: DigestSnapshotItem): string {
  return `新規（${[
    `状態 ${statusLabel(item.status)}`,
    `担当 ${ownerLabel(item.owner)}`,
    ...(item.targetDate ? [`期限 ${item.targetDate}`] : []),
  ].join("、")}）`;
}

function digestLine(change: DigestChange): WorkDiffDigestLine {
  return {
    category: change.category,
    url: change.item.url,
    issueNumber: issueNumberFromUrl(change.item.url),
    title: truncate(change.item.title, DIGEST_LIMITS.titleLength),
    detail: change.details.join("、"),
  };
}

function compareChanges(left: DigestChange, right: DigestChange): number {
  return (
    CATEGORY_RANK[left.category] - CATEGORY_RANK[right.category] ||
    (issueNumberFromUrl(left.item.url) ?? 0) - (issueNumberFromUrl(right.item.url) ?? 0) ||
    left.item.url.localeCompare(right.item.url)
  );
}

function bestRank(changes: DigestChange[]): number {
  return Math.min(...changes.map((change) => CATEGORY_RANK[change.category]));
}

function isOverdue(item: DigestSnapshotItem, date: string): boolean {
  if (item.status === "done" || !item.targetDate) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(item.targetDate)) return false;
  return item.targetDate < date;
}

function sameOwners(left: string[], right: string[]): boolean {
  const normalize = (values: string[]) =>
    values
      .map((value) => value.toLowerCase())
      .sort()
      .join("\n");
  return normalize(left) === normalize(right);
}

/** 人名はmentionせず、GitHub loginをそのまま書く。 */
function ownerLabel(owners: string[]): string {
  return owners.length > 0 ? owners.join("・") : "未定";
}

function truncate(value: string, length: number): string {
  const characters = [...value];
  return characters.length > length ? `${characters.slice(0, length - 1).join("")}…` : value;
}
