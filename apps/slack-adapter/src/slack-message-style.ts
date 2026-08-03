import type { LifecycleNotificationKind } from "./lifecycle-notification-service.ts";

export type SlackMessageTone =
  | "action"
  | "approved"
  | "comment"
  | "completed"
  | "deadline"
  | "digest"
  | "error"
  | "info"
  | "merged"
  | "review"
  | "revision"
  | "success"
  | "warning"
  | "work";

const EMOJI: Record<SlackMessageTone, string> = {
  action: "🧩",
  approved: "✅",
  comment: "💬",
  completed: "🏁",
  deadline: "⏰",
  digest: "📋",
  error: "🚨",
  info: "ℹ️",
  merged: "🎉",
  review: "👀",
  revision: "🛠️",
  success: "✅",
  warning: "⚠️",
  work: "🚧",
};

export function slackPlain(tone: SlackMessageTone, text: string): string {
  return `${EMOJI[tone]} ${text}`;
}

export function slackHeading(tone: SlackMessageTone, label: string): string {
  return `${EMOJI[tone]} *${label}*`;
}

export function slackHeader(tone: SlackMessageTone, label: string) {
  return {
    type: "header" as const,
    text: {
      type: "plain_text" as const,
      text: `${EMOJI[tone]} ${label}`,
      emoji: true,
    },
  };
}

export function slackDivider() {
  return { type: "divider" as const };
}

export function lifecycleTone(kind: LifecycleNotificationKind): SlackMessageTone {
  const tones: Record<LifecycleNotificationKind, SlackMessageTone> = {
    "issue-opened": "work",
    "issue-reopened": "work",
    "issue-assignment-changed": "action",
    "comment-created": "comment",
    "issue-completed": "completed",
    "pr-merged": "merged",
    "review-approved": "approved",
    "review-changes-requested": "warning",
    "review-commented": "comment",
    "review-dismissed": "warning",
    "review-requested": "review",
    "revision-pushed": "revision",
    "ci-failed": "error",
    "self-merge-scheduled": "warning",
    "self-merge-ready": "warning",
  };
  return tones[kind];
}
