import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LifecycleNotification,
  LifecycleNotificationService,
} from "../src/lifecycle-notification-service.ts";
import { NotificationThreadService } from "../src/notification-thread-service.ts";
import type {
  GitHubIssueContext,
  GitHubLifecycleClient,
  PullRequestReviewContext,
} from "../src/review-types.ts";
import { LocalStateStore } from "../src/state-store.ts";

describe("LifecycleNotificationService", () => {
  test("通常Issue作成をchannel rootへ即時通知し、セルフマージ予定を同じthreadで強調する", async () => {
    const harness = await createHarness();
    harness.github.issue = {
      ...harness.github.issue,
      labels: ["type/work", "merge/self"],
      parentIssueUrl: "https://api.github.com/repos/example/parent/issues/7",
      body: "## 完了条件\n\n- [ ] Slackへ通知する\n\n## 目標日\n\n2026-08-04",
    };
    harness.github.pullRequest = {
      ...harness.github.pullRequest,
      linkedIssues: [harness.github.issue],
    };

    expect(await harness.service.process(issueOpenedJob())).toBe(2);
    expect(harness.sent.map((value) => value.notification.kind)).toEqual([
      "issue-opened",
      "self-merge-scheduled",
    ]);
    expect(harness.sent.map((value) => value.threadTs)).toEqual([null, "900.1"]);
    expect(harness.sent[0]?.notification.detail).toContain("親Issue: example/parent#7");
    expect(harness.sent[0]?.notification.detail).toContain("完了条件: Slackへ通知する");
    expect(harness.sent[0]?.notification.detail).toContain("目標日: 2026-08-04");
    expect(harness.sent[1]?.notification).toMatchObject({
      selfMergeControl: { repository: "example/repo", issueNumber: 44 },
      detail: "第三者承認を待たず、PR作成者本人が必須CI通過後にマージします。",
    });
  });

  test("セルフマージPRのCI成功をIssue threadへ通知する", async () => {
    const harness = await createHarness();
    harness.github.issue = {
      ...harness.github.issue,
      labels: ["type/work", "merge/self"],
    };
    harness.github.pullRequest = {
      ...harness.github.pullRequest,
      linkedIssues: [harness.github.issue],
    };
    await harness.service.process(issueOpenedJob());

    expect(await harness.service.process(checkSuiteCompletedJob())).toBe(1);
    expect(harness.sent.at(-1)).toMatchObject({
      threadTs: "900.1",
      notification: {
        kind: "self-merge-ready",
        selfMergeControl: { repository: "example/repo", issueNumber: 44 },
      },
    });
  });

  test("Issueコメントの担当者と明示mentionを同じthreadへ通知し、closeも同居させる", async () => {
    const harness = await createHarness();
    const comment = issueCommentJob("delivery-comment");

    expect(await harness.service.process(comment)).toBe(1);
    expect(
      await harness.service.process({ ...comment, deliveryId: "delivery-comment-redelivery" }),
    ).toBe(0);
    expect(harness.sent[0]).toMatchObject({
      threadTs: null,
      notification: {
        kind: "comment-created",
        actorLogin: "commenter",
        slackUserIds: ["UOWNER", "UMENTIONED"],
      },
    });

    expect(await harness.service.process(issueClosedJob())).toBe(1);
    expect(harness.sent[1]).toMatchObject({
      threadTs: "900.1",
      notification: { kind: "issue-completed", slackUserIds: ["UOWNER", "UREQUESTER"] },
    });
  });

  test("差し戻し、修正push、マージを関連Issueのthreadへ集約する", async () => {
    const harness = await createHarness();

    expect(await harness.service.process(changesRequestedJob())).toBe(1);
    expect(await harness.service.process(synchronizeJob("head-2"))).toBe(1);
    expect(
      await harness.service.process(synchronizeJob("head-2", "delivery-sync-redelivery")),
    ).toBe(0);
    harness.github.pullRequest = {
      ...harness.github.pullRequest,
      state: "closed",
      headSha: "head-2",
    };
    expect(await harness.service.process(mergedJob())).toBe(1);

    expect(harness.sent.map((value) => value.notification.kind)).toEqual([
      "review-changes-requested",
      "revision-pushed",
      "pr-merged",
    ]);
    expect(harness.sent.map((value) => value.threadTs)).toEqual([null, "900.1", "900.1"]);
    expect(harness.sent[0]?.notification.slackUserIds).toEqual(["UAUTHOR"]);
    expect(harness.sent[1]?.notification.slackUserIds).toEqual(["UREVIEWER"]);
    expect(harness.sent[2]?.notification.slackUserIds).toEqual(["UAUTHOR", "UOWNER"]);
  });

  test("PR会話とコードコメントではPR作成者をmentionする", async () => {
    const harness = await createHarness();

    expect(await harness.service.process(pullRequestCommentJob())).toBe(1);
    expect(await harness.service.process(reviewCommentJob())).toBe(1);

    expect(harness.sent.map((value) => value.notification.kind)).toEqual([
      "comment-created",
      "review-commented",
    ]);
    expect(harness.sent[0]?.notification.slackUserIds).toEqual(["UAUTHOR", "UMENTIONED"]);
    expect(harness.sent[1]?.notification.slackUserIds).toEqual(["UAUTHOR"]);
    expect(harness.sent[1]?.threadTs).toBe("900.1");
  });

  test("関連IssueがないPRはPR単位のthreadを作る", async () => {
    const harness = await createHarness();
    harness.github.pullRequest = { ...harness.github.pullRequest, linkedIssues: [] };

    expect(await harness.service.process(changesRequestedJob())).toBe(1);

    expect(harness.sent[0]?.notification.resource).toEqual({
      kind: "pull-request",
      number: 45,
      title: "ライフサイクル通知",
      url: "https://github.example/example/repo/pull/45",
    });
  });
});

async function createHarness() {
  const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-lifecycle-")));
  const github = new FakeLifecycleClient();
  const sent: Array<{ notification: LifecycleNotification; threadTs: string | null }> = [];
  const ids: Record<string, string> = {
    author: "UAUTHOR",
    mentioned: "UMENTIONED",
    owner: "UOWNER",
    requester: "UREQUESTER",
    reviewer: "UREVIEWER",
  };
  const service = new LifecycleNotificationService(
    github,
    store,
    new NotificationThreadService(store, () => Date.parse("2026-08-02T00:00:00Z")),
    {
      notify: async (notification, threadTs) => {
        sent.push({ notification, threadTs });
        return { messageTs: threadTs ?? "900.1" };
      },
    },
    async (login) => ids[login] ?? null,
    () => Date.parse("2026-08-02T00:00:00Z"),
  );
  return { service, github, sent };
}

class FakeLifecycleClient implements GitHubLifecycleClient {
  issue: GitHubIssueContext = {
    number: 44,
    title: "ライフサイクル通知",
    url: "https://github.example/example/repo/issues/44",
    body: "",
    state: "open",
    authorLogin: "requester",
    assigneeLogins: ["owner"],
    labels: ["type/work", "merge/review"],
  };

  pullRequest: PullRequestReviewContext = {
    schemaVersion: 1,
    repository: "example/repo",
    number: 45,
    title: "ライフサイクル通知",
    url: "https://github.example/example/repo/pull/45",
    authorLogin: "author",
    headSha: "head-2",
    draft: false,
    state: "open",
    mergeableState: "clean",
    body: "Closes #44",
    files: ["src/app.ts"],
    linkedIssues: [this.issue],
    codeowners: "* @reviewer",
    requiredApprovals: 1,
    requestedReviewerLogins: ["reviewer"],
    requestedTeamSlugs: [],
    approvedReviewerLogins: [],
    changesRequestedReviewerLogins: ["reviewer"],
  };

  async loadIssueContext(): Promise<GitHubIssueContext> {
    return this.issue;
  }

  async loadPullRequestReviewContext(): Promise<PullRequestReviewContext> {
    return this.pullRequest;
  }
}

function basePayload() {
  return {
    repository: { full_name: "example/repo" },
    sender: { login: "merger" },
  };
}

function issueCommentJob(deliveryId: string) {
  return {
    schemaVersion: 1 as const,
    deliveryId,
    event: "issue_comment",
    payload: {
      ...basePayload(),
      action: "created",
      issue: { number: 44 },
      comment: {
        id: 101,
        body: "確認をお願いします @mentioned",
        html_url: "https://github.example/example/repo/issues/44#issuecomment-101",
        user: { login: "commenter" },
      },
    },
  };
}

function issueClosedJob() {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-close",
    event: "issues",
    payload: { ...basePayload(), action: "closed", issue: { number: 44 } },
  };
}

function issueOpenedJob() {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-open",
    event: "issues",
    payload: { ...basePayload(), action: "opened", issue: { number: 44 } },
  };
}

function checkSuiteCompletedJob() {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-check-success",
    event: "check_suite",
    payload: {
      ...basePayload(),
      action: "completed",
      check_suite: { conclusion: "success", pull_requests: [{ number: 45 }] },
    },
  };
}

function changesRequestedJob() {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-review",
    event: "pull_request_review",
    payload: {
      ...basePayload(),
      action: "submitted",
      pull_request: {
        number: 45,
        html_url: "https://github.example/example/repo/pull/45",
      },
      review: {
        id: 201,
        state: "changes_requested",
        body: "ここを修正してください",
        html_url: "https://github.example/example/repo/pull/45#pullrequestreview-201",
        user: { login: "reviewer" },
      },
    },
  };
}

function synchronizeJob(headSha: string, deliveryId = "delivery-sync") {
  return {
    schemaVersion: 1 as const,
    deliveryId,
    event: "pull_request",
    payload: {
      ...basePayload(),
      action: "synchronize",
      pull_request: { number: 45, head: { sha: headSha } },
    },
  };
}

function mergedJob() {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-merge",
    event: "pull_request",
    payload: {
      ...basePayload(),
      action: "closed",
      pull_request: { number: 45, merged: true, merge_commit_sha: "merge-sha" },
    },
  };
}

function pullRequestCommentJob() {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-pr-comment",
    event: "issue_comment",
    payload: {
      ...basePayload(),
      action: "created",
      issue: { number: 45, pull_request: { url: "https://api.example/pulls/45" } },
      comment: {
        id: 301,
        body: "確認してください @mentioned",
        html_url: "https://github.example/example/repo/pull/45#issuecomment-301",
        user: { login: "commenter" },
      },
    },
  };
}

function reviewCommentJob() {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-code-comment",
    event: "pull_request_review_comment",
    payload: {
      ...basePayload(),
      action: "created",
      pull_request: { number: 45 },
      comment: {
        id: 302,
        body: "この条件を確認してください",
        html_url: "https://github.example/example/repo/pull/45#discussion_r302",
        user: { login: "reviewer" },
      },
    },
  };
}
