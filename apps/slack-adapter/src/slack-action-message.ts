export interface SlackActionMessage {
  recipientSlackUserIds: string[];
  mentions: string;
  text: string;
}

export function approvalRequestMessage(input: {
  approverSlackUserIds: Iterable<string>;
  requesterSlackUserId: string;
  requesterGitHubLogin: string | null;
}): SlackActionMessage {
  return actionMessage(
    input.approverSlackUserIds,
    input.requesterSlackUserId,
    input.requesterGitHubLogin,
    "Issue作成の承認をお願いします。",
  );
}

export function approvalDecisionMessage(input: {
  decision: "approved" | "rejected";
  requesterSlackUserId: string;
  actorSlackUserId: string;
  actorGitHubLogin: string | null;
  issue?: { number: number; url: string };
}): SlackActionMessage {
  const content =
    input.decision === "approved"
      ? `Issue #${input.issue?.number ?? "?"}が承認され作成されました: ${input.issue?.url ?? ""}`.trim()
      : "Issue作成申請が却下されました。";
  return actionMessage(
    [input.requesterSlackUserId],
    input.actorSlackUserId,
    input.actorGitHubLogin,
    content,
  );
}

export function selfMergeStoppedMessage(input: {
  ownerSlackUserIds: Iterable<string>;
  actorSlackUserId: string;
  actorGitHubLogin: string | null;
  reason: string;
  issueUrl: string;
}): SlackActionMessage {
  return actionMessage(
    input.ownerSlackUserIds,
    input.actorSlackUserId,
    input.actorGitHubLogin,
    `セルフマージが停止されました。理由: ${input.reason} ${input.issueUrl}`,
  );
}

function actionMessage(
  candidates: Iterable<string>,
  actorSlackUserId: string,
  actorGitHubLogin: string | null,
  content: string,
): SlackActionMessage {
  const recipientSlackUserIds = [...new Set(candidates)].filter(
    (slackUserId) => slackUserId && slackUserId !== actorSlackUserId,
  );
  const mentions = recipientSlackUserIds.map((slackUserId) => `<@${slackUserId}>`).join(" ");
  const text = [mentions, content, actorAttribution(actorGitHubLogin)].filter(Boolean).join(" ");
  return { recipientSlackUserIds, mentions, text };
}

function actorAttribution(githubLogin: string | null): string {
  return githubLogin && /^[A-Za-z0-9-]{1,39}$/.test(githubLogin)
    ? `実行者: @${githubLogin}`
    : "実行者";
}
