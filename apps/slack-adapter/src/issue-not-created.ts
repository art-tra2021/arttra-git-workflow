/**
 * Issue作成が「GitHubにIssueを作っていない」と確定できる失敗に付ける印。
 * 作成要求を送る前の検証の失敗と、GitHubが4xxで拒んだ作成要求がこれに当たる。
 * 印の無い失敗（timeout、5xx、通信断）は、GitHub側で作られた可能性が残る。
 * 例外のclassとmessageは変えないため、既存の呼び出し元の扱いは変わらない。
 */
const ISSUE_NOT_CREATED = Symbol.for("arttra.issueNotCreated");

export function markIssueNotCreated(error: unknown): unknown {
  const target = error instanceof Error ? error : new Error(String(error));
  Object.defineProperty(target, ISSUE_NOT_CREATED, { value: true, enumerable: false });
  return target;
}

export function isIssueNotCreated(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { [ISSUE_NOT_CREATED]?: unknown })[ISSUE_NOT_CREATED] === true
  );
}
