import { describe, expect, test } from "bun:test";
import {
  approvalDecisionMessage,
  approvalRequestMessage,
  selfMergeStoppedMessage,
} from "../src/slack-action-message.ts";

describe("Slack操作結果のrecipient", () => {
  test("承認申請は申請者本人を呼ばず、承認者だけを一度呼ぶ", () => {
    const message = approvalRequestMessage({
      approverSlackUserIds: ["U_REQUESTER", "U_APPROVER", "U_APPROVER"],
      requesterSlackUserId: "U_REQUESTER",
      requesterGitHubLogin: "requester",
    });

    expect(message.recipientSlackUserIds).toEqual(["U_APPROVER"]);
    expect(message.text).toContain("<@U_APPROVER>");
    expect(message.text).not.toContain("<@U_REQUESTER>");
    expect(message.text).toContain("実行者: @requester");
  });

  test.each(["approved", "rejected"] as const)(
    "%s結果は操作した本人を呼ばず、申請者だけを呼ぶ",
    (decision) => {
      const message = approvalDecisionMessage({
        decision,
        requesterSlackUserId: "U_REQUESTER",
        actorSlackUserId: "U_APPROVER",
        actorGitHubLogin: "approver",
        issue: { number: 108, url: "https://github.example/issues/108" },
      });

      expect(message.recipientSlackUserIds).toEqual(["U_REQUESTER"]);
      expect(message.text).toContain("<@U_REQUESTER>");
      expect(message.text).not.toContain("<@U_APPROVER>");
      expect(message.text).toContain("実行者: @approver");
    },
  );

  test("セルフマージ停止は停止者を除外・重複排除し、別ownerだけを呼ぶ", () => {
    const message = selfMergeStoppedMessage({
      ownerSlackUserIds: ["U_STOPPER", "U_OTHER", "U_OTHER"],
      actorSlackUserId: "U_STOPPER",
      actorGitHubLogin: "stopper",
      reason: "レビューが必要",
      issueUrl: "https://github.example/issues/108",
    });

    expect(message.recipientSlackUserIds).toEqual(["U_OTHER"]);
    expect(message.text).toContain("<@U_OTHER>");
    expect(message.text).not.toContain("<@U_STOPPER>");
    expect(message.text.match(/<@U_OTHER>/g)).toHaveLength(1);
  });

  test("検証済みGitHub loginがなければneutralな実行者表記にする", () => {
    const message = approvalDecisionMessage({
      decision: "rejected",
      requesterSlackUserId: "U_REQUESTER",
      actorSlackUserId: "U_APPROVER",
      actorGitHubLogin: null,
    });

    expect(message.text).toContain("実行者");
    expect(message.text).not.toContain("@U_APPROVER");
    expect(message.text).not.toContain("<@U_APPROVER>");
  });
});
