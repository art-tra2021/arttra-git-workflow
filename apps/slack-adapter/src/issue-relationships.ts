/**
 * GitHub Issue の親子・依存関係を、Slack/AI/GitHub adapter間で共有する値。
 *
 * 自由記述の本文を関係の正本にせず、Issue作成前にこの構造へ正規化する。
 */
export interface IssueReference {
  repository: string;
  number: number;
}

export interface IssueRelationships {
  parent: IssueReference | null;
  blockedBy: IssueReference[];
  blocking: IssueReference[];
}

export interface IssueRelationshipInput {
  parent?: string | null;
  blockedBy?: string | null;
  blocking?: string | null;
}

export const EMPTY_ISSUE_RELATIONSHIPS: IssueRelationships = Object.freeze({
  parent: null,
  blockedBy: [],
  blocking: [],
});

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
const ISSUE_NUMBER_PATTERN = /^[1-9][0-9]*$/;
const ISSUE_URL_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100})\/issues\/([1-9][0-9]*)\/?$/i;
const ISSUE_SHORTHAND_PATTERN = /^([A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100})#([1-9][0-9]*)$/;

/** repositoryのIssue templateに存在する旧自由入力fieldを専用関係UIへ移行するためのID。 */
export const ISSUE_RELATIONSHIP_FIELD_IDS = new Set(["parent", "blocked_by", "blocking"]);

/**
 * Issue番号、#番号、owner/repository#番号、GitHub Issue URLを正規化する。
 * 同一repositoryの短縮表記だけは呼び出し元repositoryを使う。
 */
export function parseIssueReference(value: string, currentRepository: string): IssueReference {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Issue関係の値が空です。Issue番号またはURLを指定してください。");
  }
  const repository = normalizeRepository(currentRepository);

  if (ISSUE_NUMBER_PATTERN.test(normalized)) {
    return { repository, number: parseIssueNumber(normalized) };
  }
  if (normalized.startsWith("#") && ISSUE_NUMBER_PATTERN.test(normalized.slice(1))) {
    return { repository, number: parseIssueNumber(normalized.slice(1)) };
  }

  const shorthand = ISSUE_SHORTHAND_PATTERN.exec(normalized);
  if (shorthand?.[1] && shorthand[2]) {
    return {
      repository: normalizeRepository(shorthand[1]),
      number: parseIssueNumber(shorthand[2]),
    };
  }

  const url = ISSUE_URL_PATTERN.exec(normalized);
  if (url?.[1] && url[2]) {
    return { repository: normalizeRepository(url[1]), number: parseIssueNumber(url[2]) };
  }

  throw new Error(
    `Issue関係の形式が不正です: ${normalized}。例: 123、owner/repo#123、https://github.com/owner/repo/issues/123`,
  );
}

/** カンマ・改行区切りのIssue関係を正規化し、入力順を維持したまま重複を除く。 */
export function parseIssueReferences(
  value: string | null | undefined,
  currentRepository: string,
): IssueReference[] {
  if (!value?.trim()) return [];
  const references: IssueReference[] = [];
  const seen = new Set<string>();
  for (const token of value.split(/[\n,]+/u)) {
    if (!token.trim()) continue;
    const reference = parseIssueReference(token, currentRepository);
    const key = issueReferenceKey(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(reference);
  }
  return references;
}

/** Slack入力と旧Issue templateのfieldsを同じ構造へ変換する。 */
export function parseIssueRelationships(
  input: IssueRelationshipInput | undefined,
  fields: Record<string, string>,
  currentRepository: string,
): IssueRelationships {
  const parentValue = input?.parent === undefined ? fields.parent : input.parent;
  const blockedByValue = input?.blockedBy === undefined ? fields.blocked_by : input.blockedBy;
  const blockingValue = input?.blocking === undefined ? fields.blocking : input.blocking;
  const parent = parentValue?.trim() ? parseIssueReference(parentValue, currentRepository) : null;
  return {
    parent,
    blockedBy: parseIssueReferences(blockedByValue, currentRepository),
    blocking: parseIssueReferences(blockingValue, currentRepository),
  };
}

/** AI/legacy JSONから受け取った構造化関係を検証し、repository表記を正規化する。 */
export function normalizeIssueRelationships(
  relationships: IssueRelationships,
  currentRepository: string,
): IssueRelationships {
  const normalizeReference = (reference: IssueReference): IssueReference => {
    if (!reference || typeof reference !== "object") {
      throw new Error("Issue関係のJSONが不正です。repositoryとIssue番号を指定してください。");
    }
    const repository = normalizeRepository(reference.repository);
    if (!Number.isSafeInteger(reference.number) || reference.number < 1) {
      throw new Error(`Issue番号が不正です: ${String(reference.number)}`);
    }
    return { repository, number: reference.number };
  };
  const normalizeMany = (references: IssueReference[]): IssueReference[] => {
    if (!Array.isArray(references)) {
      throw new Error("Issue関係のJSON配列が不正です。");
    }
    const seen = new Set<string>();
    return references.reduce<IssueReference[]>((result, reference) => {
      const normalized = normalizeReference(reference);
      const key = issueReferenceKey(normalized);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(normalized);
      }
      return result;
    }, []);
  };
  if (!relationships || typeof relationships !== "object") {
    throw new Error("Issue関係のJSONが不正です。");
  }
  const parent = relationships.parent === null ? null : normalizeReference(relationships.parent);
  const normalized = {
    parent,
    blockedBy: normalizeMany(relationships.blockedBy),
    blocking: normalizeMany(relationships.blocking),
  };
  // 呼び出し元repositoryもここで検証し、AIが作った相対・空repositoryを許容しない。
  normalizeRepository(currentRepository);
  return normalized;
}

export function issueReferenceKey(reference: IssueReference): string {
  return `${reference.repository.toLowerCase()}#${reference.number}`;
}

export function issueReferenceLabel(reference: IssueReference): string {
  return `${reference.repository}#${reference.number}`;
}

/** `gh issue create`へ渡す値。同一repositoryは番号、別repositoryはURLにする。 */
export function issueReferenceArgument(
  reference: IssueReference,
  currentRepository: string,
): string {
  if (reference.repository.toLowerCase() === currentRepository.trim().toLowerCase()) {
    return String(reference.number);
  }
  return `https://github.com/${reference.repository}/issues/${reference.number}`;
}

export function hasIssueRelationships(relationships: IssueRelationships): boolean {
  return (
    relationships.parent !== null ||
    relationships.blockedBy.length > 0 ||
    relationships.blocking.length > 0
  );
}

export function normalizeRepository(value: string): string {
  const normalized = value.trim();
  if (!REPOSITORY_PATTERN.test(normalized)) {
    throw new Error(`repository名が不正です: ${value}`);
  }
  return normalized;
}

function parseIssueNumber(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`Issue番号が不正です: ${value}`);
  }
  return number;
}
