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

export function lifecycleTone(kind: LifecycleNotificationKind): SlackMessageTone {
  const tones: Record<LifecycleNotificationKind, SlackMessageTone> = {
    "comment-created": "comment",
    "issue-completed": "completed",
    "pr-merged": "merged",
    "review-approved": "approved",
    "review-changes-requested": "warning",
    "review-commented": "comment",
    "review-dismissed": "warning",
    "review-requested": "review",
    "revision-pushed": "revision",
  };
  return tones[kind];
}
