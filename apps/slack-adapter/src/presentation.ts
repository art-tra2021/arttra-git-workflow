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
          value: item.url,
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

function statusLabel(status: HumanWorkItem["status"]): string {
  const labels: Record<HumanWorkItem["status"], string> = {
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
