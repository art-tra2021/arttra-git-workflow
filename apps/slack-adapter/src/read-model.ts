import type { HumanWorkItem, WorkItemSnapshot } from "./types.ts";

export function toHumanWorkItem(snapshot: WorkItemSnapshot, viewer: string): HumanWorkItem {
  const base = {
    schemaVersion: 1 as const,
    repository: snapshot.repository ?? null,
    issueNumber: snapshot.issue.number,
    title: snapshot.issue.title,
    url: snapshot.issue.url,
    status: snapshot.project.status,
    priority: snapshot.project.priority,
    owner: snapshot.project.owner,
    targetDate: snapshot.project.targetDate,
  };
  const owner = snapshot.project.owner ?? "担当者未定";

  if (snapshot.relationships.blockedBy.length > 0 || snapshot.project.status === "blocked") {
    const blockers = snapshot.relationships.blockedBy
      .map((item) => `#${item.number} ${item.title}`)
      .join("、");
    return {
      ...base,
      delivery: "immediate",
      reasonCode: "BLOCKED",
      nextActor: owner,
      nextAction: "blockerの解消条件を確認する",
      reason: blockers ? `未完了のblocker: ${blockers}` : "ProjectsでBlockedになっている",
      actions: ["open-github"],
    };
  }

  if (snapshot.project.status === "urgent-unstarted" && snapshot.project.owner === null) {
    return {
      ...base,
      delivery: "immediate",
      reasonCode: "URGENT_UNASSIGNED",
      nextActor: "チーム",
      nextAction: "担当者を決める",
      reason: "急ぎだが担当者がいない",
      actions: ["claim", "open-github"],
    };
  }

  if (snapshot.pullRequest?.checks === "failed") {
    return {
      ...base,
      delivery: "immediate",
      reasonCode: "CHECKS_FAILED",
      nextActor: owner,
      nextAction: "失敗したcheckを確認する",
      reason: `PR #${snapshot.pullRequest.number}のcheckが失敗している`,
      actions: ["open-github"],
    };
  }

  if (snapshot.pullRequest?.mergeState === "conflicting") {
    return {
      ...base,
      delivery: "immediate",
      reasonCode: "CONFLICTING",
      nextActor: owner,
      nextAction: "base branchとのconflictを解消する",
      reason: `PR #${snapshot.pullRequest.number}がconflictしている`,
      actions: ["open-github"],
    };
  }

  if (snapshot.pullRequest?.requestedReviewers.includes(viewer)) {
    return {
      ...base,
      delivery: "immediate",
      reasonCode: "REVIEW_REQUESTED",
      nextActor: viewer,
      nextAction: "PRをreviewする",
      reason: `PR #${snapshot.pullRequest.number}のreviewを依頼されている`,
      actions: ["open-github"],
    };
  }

  if (snapshot.project.status === "done") {
    return {
      ...base,
      delivery: "silent",
      reasonCode: "COMPLETED",
      nextActor: "なし",
      nextAction: "なし",
      reason: "完了済み",
      actions: ["open-github"],
    };
  }

  return {
    ...base,
    delivery: "digest",
    reasonCode: "ACTIVE_WORK",
    nextActor: owner,
    nextAction: nextAction(snapshot),
    reason: "日次一覧で確認する",
    actions: snapshot.project.owner === null ? ["claim", "open-github"] : ["open-github"],
  };
}

function nextAction(snapshot: WorkItemSnapshot): string {
  switch (snapshot.project.status) {
    case "triage":
      return "IntakeをWorkまたはBusinessへ整える";
    case "todo":
    case "urgent-unstarted":
      return "着手する";
    case "in-progress":
      return "次の完了条件を進める";
    case "in-review":
      return "reviewとcheckの完了を確認する";
    case "blocked":
      return "blockerを確認する";
    case "done":
      return "なし";
  }
}
