import type { WebClient } from "@slack/web-api";
import type { ReviewRequestReadModel } from "./review-types.ts";

export class SlackReviewNotifier {
  private readonly client: WebClient;
  private readonly channelId: string;

  constructor(client: WebClient, channelId: string) {
    this.client = client;
    this.channelId = channelId;
  }

  async notify(model: ReviewRequestReadModel): Promise<void> {
    const mentions = model.reviewers
      .flatMap((reviewer) => (reviewer.slackUserId ? [`<@${reviewer.slackUserId}>`] : []))
      .join(" ");
    const reviewerLines = model.reviewers.map((reviewer) => {
      const target = reviewer.slackUserId
        ? `<@${reviewer.slackUserId}>`
        : `@${reviewer.githubLogin}`;
      return `• ${target}: ${reviewer.reasons.join("、")}`;
    });
    const teamLines = model.teams.map(
      (team) => `• @${team.slug}: ${team.reasons.join("、")}（GitHub team）`,
    );
    const due = model.dueDate ?? "未設定";
    await this.client.chat.postMessage({
      channel: this.channelId,
      text: `${mentions} PR #${model.pullRequest.number}のレビューをお願いします。`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: [
              mentions,
              `*<${model.pullRequest.url}|PR #${model.pullRequest.number} ${model.pullRequest.title}>*`,
              `*理由*\n${[...reviewerLines, ...teamLines].join("\n") || "Rulesetによるレビュー要求"}`,
              `*期限:* ${due}`,
              `*必要承認数:* ${model.requiredApprovals}`,
              `*次の操作:* ${model.nextAction}`,
            ].join("\n"),
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "PRを確認" },
              url: model.pullRequest.url,
              action_id: "ar.review.open",
            },
          ],
        },
      ],
      unfurl_links: false,
      unfurl_media: false,
    });
  }
}
