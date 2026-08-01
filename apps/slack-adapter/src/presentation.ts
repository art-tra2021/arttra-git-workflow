import type { HumanWorkItem } from "./types.ts";

export interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

export function workItemBlocks(item: HumanWorkItem): SlackBlock[] {
  const fields = [
    `*状態*\n${statusLabel(item.status)}`,
    `*優先度*\n${item.priority}`,
    `*次に動く人*\n${item.nextActor}`,
    `*目標日*\n${item.targetDate ?? "未設定"}`,
  ];
  const elements: Array<Record<string, unknown>> = item.actions.map((action) =>
    action === "claim"
      ? {
          type: "button",
          action_id: "ar.claim",
          text: { type: "plain_text", text: "自分が着手する" },
          value: String(item.issueNumber),
        }
      : {
          type: "button",
          action_id: "ar.open-github",
          text: { type: "plain_text", text: "GitHubで開く" },
          url: item.url,
          value: String(item.issueNumber),
        },
  );

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `#${item.issueNumber} ${item.title}` },
    },
    { type: "section", fields: fields.map((text) => ({ type: "mrkdwn", text })) },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*次の行動*\n${item.nextAction}\n*理由*\n${item.reason}`,
      },
    },
    { type: "actions", elements },
  ];
}

export function renderWorkCanvas(items: HumanWorkItem[], generatedAt: string): string {
  const visible = items.filter((item) => item.delivery !== "silent").slice(0, 45);
  const rows = visible.map(
    (item) =>
      `|[${escapeCell(`#${item.issueNumber} ${item.title}`)}](${item.url})|${statusLabel(item.status)}|${item.priority}|${escapeCell(item.nextActor)}|${item.targetDate ?? "未設定"}|${escapeCell(item.nextAction)}|`,
  );
  const omitted = items.filter((item) => item.delivery !== "silent").length - visible.length;

  return [
    "# ART-TRA Work",
    "",
    `更新: ${generatedAt}`,
    "",
    "|Issue|状態|優先度|次に動く人|目標日|次の行動|",
    "|---|---|---|---|---|---|",
    ...rows,
    ...(omitted > 0
      ? ["", `${omitted}件は表の上限により省略した。GitHub Projectsで確認する。`]
      : []),
  ].join("\n");
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function statusLabel(status: HumanWorkItem["status"]): string {
  const labels: Record<HumanWorkItem["status"], string> = {
    triage: "Triage",
    todo: "Todo",
    "urgent-unstarted": "Urgent Unstarted",
    "in-progress": "In Progress",
    blocked: "Blocked",
    "in-review": "In Review",
    done: "Done",
  };
  return labels[status];
}
