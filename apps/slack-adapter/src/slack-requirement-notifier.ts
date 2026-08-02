import type { WebClient } from "@slack/web-api";
import { slackDivider, slackHeader, slackPlain } from "./slack-message-style.ts";
import type { StateStore } from "./state-store.ts";

const NAMESPACE = "requirement-notification";
const DEFAULT_COOLDOWN_MILLISECONDS = 24 * 60 * 60 * 1000;

interface RequirementNotificationState {
  schemaVersion: 1;
  slackTeamId: string;
  slackUserId: string;
  kind: "github-connect";
  notifiedAt: string;
}

export interface GitHubConnectionRequirement {
  channelId: string;
  slackTeamId: string;
  slackUserIds: string[];
}

export class SlackRequirementNotifier {
  private readonly client: Pick<WebClient, "chat">;
  private readonly store: StateStore;
  private readonly now: () => number;
  private readonly cooldownMilliseconds: number;

  constructor(
    client: Pick<WebClient, "chat">,
    store: StateStore,
    now: () => number = Date.now,
    cooldownMilliseconds = DEFAULT_COOLDOWN_MILLISECONDS,
  ) {
    this.client = client;
    this.store = store;
    this.now = now;
    this.cooldownMilliseconds = cooldownMilliseconds;
  }

  async requireGitHubConnection(requirement: GitHubConnectionRequirement): Promise<number> {
    const targets: string[] = [];
    for (const slackUserId of [...new Set(requirement.slackUserIds)]) {
      const previous = await this.store.get<RequirementNotificationState>(
        NAMESPACE,
        stateKey(requirement.slackTeamId, slackUserId),
      );
      const previousTime = previous ? Date.parse(previous.notifiedAt) : Number.NaN;
      if (Number.isFinite(previousTime) && this.now() - previousTime < this.cooldownMilliseconds) {
        continue;
      }
      targets.push(slackUserId);
    }
    if (targets.length === 0) return 0;

    const mentions = targets.map((slackUserId) => `<@${slackUserId}>`).join(" ");
    await this.client.chat.postMessage({
      channel: requirement.channelId,
      text: slackPlain(
        "action",
        `${mentions} GitHub連携が必要です。Slackで /ar connect github を実行してください。`,
      ),
      blocks: [
        slackHeader("action", "GitHub連携が必要です"),
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: [
              mentions,
              "担当者または予定レビュワーとしてGitHubへ反映するには、本人確認が必要です。",
            ].join("\n"),
          },
        },
        slackDivider(),
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*次の操作*\nSlackで `/ar connect github` を実行し、自分のGitHubアカウントで認証する",
          },
        },
      ],
      unfurl_links: false,
      unfurl_media: false,
    });

    const notifiedAt = new Date(this.now()).toISOString();
    await Promise.all(
      targets.map((slackUserId) =>
        this.store.set<RequirementNotificationState>(
          NAMESPACE,
          stateKey(requirement.slackTeamId, slackUserId),
          {
            schemaVersion: 1,
            slackTeamId: requirement.slackTeamId,
            slackUserId,
            kind: "github-connect",
            notifiedAt,
          },
        ),
      ),
    );
    return targets.length;
  }
}

function stateKey(slackTeamId: string, slackUserId: string): string {
  return `github-connect:${slackTeamId}:${slackUserId}`;
}
