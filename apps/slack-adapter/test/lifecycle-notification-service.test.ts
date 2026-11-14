import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubCapabilityGrants } from "../src/github-capabilities.ts";
import {
  type LifecycleNotification,
  LifecycleNotificationService,
} from "../src/lifecycle-notification-service.ts";
import type { NotificationIntentMetadata } from "../src/notification-outbox.ts";
import { NotificationThreadService } from "../src/notification-thread-service.ts";
import {
  LifecycleNotifierWithRequiredActionDm,
  RequiredActionDmService,
} from "../src/required-action-dm-service.ts";
import type {
  GitHubIssueContext,
  GitHubLifecycleClient,
  PullRequestReviewContext,
} from "../src/review-types.ts";
import { SlackLifecycleNotifier } from "../src/slack-lifecycle-notifier.ts";
import { LocalStateStore } from "../src/state-store.ts";

describe("LifecycleNotificationService", () => {
  test("Task作成を親Work threadへ集約し、セルフマージ予定も同じthreadで強調する", async () => {
    const harness = await createHarness();
    harness.github.issue = {
      ...harness.github.issue,
      labels: ["type/task", "merge/self"],
      parentIssueUrl: "https://github.example/example/repo/issues/86",
      body: "## 完了条件\n\n- [ ] Slackへ通知する\n\n## 目標日\n\n2026-08-04",
    };
    harness.github.pullRequest = {
      ...harness.github.pullRequest,
      linkedIssues: [harness.github.issue],
    };

    expect(await harness.service.process(issueOpenedJob())).toBe(2);
    expect(await harness.service.process(selfMergeLabeledJob())).toBe(0);
    expect(harness.sent.map((value) => value.notification.kind)).toEqual([
      "issue-opened",
      "issue-opened",
      "self-merge-scheduled",
    ]);
    expect(harness.sent.map((value) => value.threadTs)).toEqual([null, "900.1", "900.1"]);
    expect(harness.sent[0]?.notification).toMatchObject({
      issueType: "work",
      resource: { number: 86 },
    });
    expect(harness.sent[1]?.notification.detail).toContain("親Issue: example/repo#86");
    expect(harness.sent[1]?.notification.detail).toContain("完了条件: Slackへ通知する");
    expect(harness.sent[1]?.notification.detail).toContain("目標日: 2026-08-04");
    expect(harness.sent[1]?.notification).toMatchObject({
      issueType: "task",
      slackUserIds: ["UOWNER"],
    });
    expect(harness.sent[2]?.notification).toMatchObject({
      selfMergeControl: { repository: "example/repo", issueNumber: 44 },
      replyBroadcast: true,
      detail: "第三者承認を待たず、PR作成者本人が必須CI通過後にマージします。",
    });
  });

  test("GitHub App作成Issueでも検証済み依頼者markerから重複なくmentionする", async () => {
    const harness = await createHarness();
    harness.github.issue = {
      ...harness.github.issue,
      authorLogin: "arttra-app[bot]",
      assigneeLogins: ["requester", "owner"],
      body: '<!-- ar:requester:v1 {"id":101,"login":"requester"} -->',
    };

    expect(await harness.service.process(issueOpenedJob())).toBe(1);
    expect(harness.sent[0]?.notification.slackUserIds).toEqual(["UOWNER"]);
    expect(harness.sent[0]?.notification).toMatchObject({
      actorLogin: "requester",
      actorSlackUserId: null,
    });
  });

  test("自己assignmentとセルフマージ選択は実行者本人をmentionしない", async () => {
    const assignmentHarness = await createHarness();
    expect(await assignmentHarness.service.process(issueOpenedJob())).toBe(1);
    expect(await assignmentHarness.service.process(issueAssignedJob("owner"))).toBe(0);
    assignmentHarness.github.issue = {
      ...assignmentHarness.github.issue,
      assigneeLogins: [],
    };
    expect(await assignmentHarness.service.process(issueUnassignedJob("owner"))).toBe(1);
    assignmentHarness.github.issue = {
      ...assignmentHarness.github.issue,
      assigneeLogins: ["owner"],
    };
    expect(
      await assignmentHarness.service.process(issueAssignedJob("owner", 44, "delivery-reassigned")),
    ).toBe(1);
    expect(assignmentHarness.sent.map(({ notification }) => notification.slackUserIds)).toEqual([
      ["UOWNER"],
      ["UOWNER"],
      ["UREQUESTER"],
      ["UREQUESTER"],
    ]);

    const mergeHarness = await createHarness();
    mergeHarness.github.issue = {
      ...mergeHarness.github.issue,
      assigneeLogins: ["owner"],
      labels: ["type/task", "merge/self"],
    };
    expect(await mergeHarness.service.process(selfMergeLabeledJob("owner"))).toBe(1);
    expect(mergeHarness.sent.map(({ notification }) => notification.slackUserIds)).toEqual([
      ["UOWNER"],
      ["UOWNER"],
      [],
    ]);
  });

  test("作成直後のassignmentを概要へ吸収し、Task概要をセルフマージ警告より先に置く", async () => {
    const harness = await createHarness();
    harness.github.issue = {
      ...harness.github.issue,
      labels: ["type/task", "merge/self"],
    };

    expect(await harness.service.process(issueAssignedJob("owner"))).toBe(1);
    expect(await harness.service.process(selfMergeLabeledJob("owner"))).toBe(1);
    expect(await harness.service.process(issueOpenedJob())).toBe(0);
    expect(harness.sent.map(({ notification }) => notification.kind)).toEqual([
      "issue-opened",
      "issue-opened",
      "self-merge-scheduled",
    ]);
    expect(harness.sent.map(({ threadTs }) => threadTs)).toEqual([null, "900.1", "900.1"]);

    const reversedHarness = await createHarness();
    reversedHarness.github.issue = {
      ...reversedHarness.github.issue,
      labels: ["type/task", "merge/self"],
    };
    expect(await reversedHarness.service.process(selfMergeLabeledJob("owner"))).toBe(1);
    expect(await reversedHarness.service.process(issueAssignedJob("owner"))).toBe(0);
    expect(await reversedHarness.service.process(issueOpenedJob())).toBe(0);
    expect(reversedHarness.sent.map(({ notification }) => notification.kind)).toEqual([
      "issue-opened",
      "issue-opened",
      "self-merge-scheduled",
    ]);
  });

  test("Intake・Work・Business作成直後のassignmentも親投稿へ吸収する", async () => {
    for (const issueType of ["intake", "work", "business"] as const) {
      const harness = await createHarness();
      harness.github.issue = {
        ...harness.github.issue,
        number: 86,
        url: "https://github.example/example/repo/issues/86",
        labels: [`type/${issueType}`],
      };

      expect(await harness.service.process(issueOpenedJob(86, `delivery-${issueType}-open`))).toBe(
        1,
      );
      expect(await harness.service.process(issueAssignedJob("owner", 86))).toBe(0);
      expect(harness.sent).toHaveLength(1);
      expect(harness.sent[0]?.notification.issueType).toBe(issueType);
    }
  });

  test("App bot経由のセルフマージ作成でもmarkerの選択者をpingしない", async () => {
    const harness = await createHarness(
      GitHubCapabilityGrants.fromJson(
        JSON.stringify({ suppress_self_merge_channel_broadcast: ["rozwer"] }),
      ),
    );
    harness.github.issue = {
      ...harness.github.issue,
      authorLogin: "arttra-app[bot]",
      assigneeLogins: ["rozwer"],
      labels: ["type/task", "merge/self"],
      body: '<!-- ar:requester:v1 {"id":202,"login":"rozwer"} -->',
    };

    expect(await harness.service.process(issueOpenedJob())).toBe(2);
    const warning = harness.sent[2]?.notification;
    expect(warning?.slackUserIds).toEqual([]);
    expect(warning?.replyBroadcast).toBe(false);
    const calls: Array<Record<string, unknown>> = [];
    const notifier = new SlackLifecycleNotifier(
      {
        chat: {
          postMessage: async (arguments_: Record<string, unknown>) => {
            calls.push(arguments_);
            return { ok: true, ts: "980.1" };
          },
        },
      } as unknown as ConstructorParameters<typeof SlackLifecycleNotifier>[0],
      "CWORK",
    );
    if (!warning) throw new Error("セルフマージ警告fixtureが必要です");
    await notifier.notify(warning, "980.0");

    expect(JSON.stringify(calls[0])).not.toContain("<@UOWNER>");
    expect(calls[0]?.reply_broadcast).toBe(false);
  });

  test("セルフマージPRのCI成功をIssue threadへ通知する", async () => {
    const harness = await createHarness();
    harness.github.issue = {
      ...harness.github.issue,
      labels: ["type/task", "merge/self"],
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
        kind: "issue-opened",
        slackUserIds: ["UOWNER"],
      },
    });
    expect(harness.sent[1]).toMatchObject({
      threadTs: "900.1",
      notification: {
        kind: "issue-opened",
        slackUserIds: ["UOWNER"],
      },
    });
    expect(harness.sent[2]).toMatchObject({
      threadTs: "900.1",
      notification: {
        kind: "comment-created",
        actorLogin: "commenter",
        slackUserIds: ["UOWNER", "UMENTIONED"],
      },
    });
    expect(await harness.service.process(issueClosedJob())).toBe(1);
    expect(harness.sent[3]).toMatchObject({
      threadTs: "900.1",
      notification: { kind: "issue-completed", slackUserIds: ["UOWNER", "UREQUESTER"] },
    });
  });

  test("close→reopen→closeを別cycleとして通知し、同じcycleの再配信は重複させない", async () => {
    const harness = await createHarness();
    harness.github.issue = {
      ...harness.github.issue,
      labels: ["type/work"],
      parentIssueUrl: "https://github.example/example/intake/issues/7",
    };

    expect(
      await harness.service.process(issueClosedJob("delivery-close-1", "2026-08-04T00:00:00Z")),
    ).toBe(1);
    expect(
      await harness.service.process(
        issueClosedJob("delivery-close-1-redelivery", "2026-08-04T00:00:00Z"),
      ),
    ).toBe(0);

    harness.github.issue = { ...harness.github.issue, state: "open" };
    expect(
      await harness.service.process(issueReopenedJob("delivery-reopen-1", "2026-08-04T01:00:00Z")),
    ).toBe(1);
    expect(
      await harness.service.process(
        issueReopenedJob("delivery-reopen-1-redelivery", "2026-08-04T01:00:00Z"),
      ),
    ).toBe(0);

    harness.github.issue = { ...harness.github.issue, state: "closed" };
    expect(
      await harness.service.process(issueClosedJob("delivery-close-2", "2026-08-04T02:00:00Z")),
    ).toBe(1);

    expect(
      harness.sent
        .map(({ notification }) => notification.kind)
        .filter((kind) => kind === "issue-reopened" || kind === "issue-completed"),
    ).toEqual(["issue-completed", "issue-reopened", "issue-completed"]);
  });

  test("コメントは投稿者を派生recipientから外し、明示mentionした他者を残す", async () => {
    const harness = await createHarness();
    harness.github.issue = {
      ...harness.github.issue,
      assigneeLogins: ["commenter", "owner"],
    };

    expect(
      await harness.service.process(issueCommentJob("delivery-self-comment", "commenter")),
    ).toBe(1);
    expect(harness.sent[2]?.notification).toMatchObject({
      actorLogin: "commenter",
      slackUserIds: ["UOWNER", "UMENTIONED"],
    });
  });

  test("WorkはTaskと別の親投稿を持ち、merge方針を表示しない", async () => {
    const harness = await createHarness();
    harness.github.issue = {
      ...harness.github.issue,
      number: 86,
      url: "https://github.example/example/repo/issues/86",
      labels: ["type/work"],
      parentIssueUrl: "https://github.example/example/intake/issues/7",
    };

    expect(await harness.service.process(issueOpenedJob(86, "delivery-work-open"))).toBe(1);
    expect(harness.sent[0]).toMatchObject({
      threadTs: null,
      notification: { kind: "issue-opened", issueType: "work" },
    });
    expect(harness.sent[0]?.notification.detail).not.toContain("マージ方針");
  });

  test("親WorkまたはBusinessを解決できないTaskはchannel直下へfallbackしない", async () => {
    const harness = await createHarness();
    harness.github.issue = { ...harness.github.issue, parentIssueUrl: null };

    expect(await harness.service.process(issueOpenedJob())).toBe(0);
    expect(harness.sent).toHaveLength(0);
  });

  test("Business配下のTaskもBusiness threadへ集約する", async () => {
    const harness = await createHarness();
    harness.github.parentIssue = {
      ...harness.github.parentIssue,
      labels: ["type/business"],
    };

    expect(await harness.service.process(issueOpenedJob())).toBe(1);
    expect(harness.sent).toHaveLength(2);
    expect(harness.sent[0]).toMatchObject({
      threadTs: null,
      notification: { issueType: "business", resource: { number: 86 } },
    });
    expect(harness.sent[1]).toMatchObject({
      threadTs: "900.1",
      notification: { issueType: "task", resource: { number: 44 } },
    });
  });

  test("共有channelのrepository scope外にある親Issueを表示しない", async () => {
    const harness = await createHarness(GitHubCapabilityGrants.empty(), ["example/repo"]);
    harness.github.issue = {
      ...harness.github.issue,
      parentIssueUrl: "https://github.example/another/repo/issues/86",
    };

    expect(await harness.service.process(issueOpenedJob())).toBe(0);
    expect(harness.sent).toHaveLength(0);
  });

  test("通知対象外のprojects_v2_itemはrepositoryなしでも処理できる", async () => {
    const harness = await createHarness(GitHubCapabilityGrants.empty(), ["example/repo"]);

    expect(
      await harness.service.process({
        schemaVersion: 1,
        deliveryId: "delivery-project-item",
        event: "projects_v2_item",
        payload: {
          action: "edited",
          projects_v2_item: { content_node_id: "I_kwDOExample" },
        },
      }),
    ).toBe(0);
    expect(harness.sent).toHaveLength(0);
  });

  test("通知対象eventのrepository必須条件とscope境界を維持する", async () => {
    const harness = await createHarness(GitHubCapabilityGrants.empty(), ["example/repo"]);
    const missingRepository = issueOpenedJob();
    delete (missingRepository.payload as { repository?: unknown }).repository;

    await expect(harness.service.process(missingRepository)).rejects.toThrow(
      "GitHub webhookのrepository.full_nameを読み取れませんでした。",
    );
    expect(
      await harness.service.process({
        ...issueOpenedJob(),
        deliveryId: "delivery-outside-scope",
        payload: {
          ...issueOpenedJob().payload,
          repository: { full_name: "outside/repo" },
        },
      }),
    ).toBe(0);
    expect(harness.sent).toHaveLength(0);
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
      "issue-opened",
      "issue-opened",
      "review-changes-requested",
      "revision-pushed",
      "pr-merged",
    ]);
    expect(harness.sent.map((value) => value.threadTs)).toEqual([
      null,
      "900.1",
      "900.1",
      "900.1",
      "900.1",
    ]);
    expect(harness.sent[0]?.notification.resource.number).toBe(86);
    expect(harness.sent.slice(1).map((value) => value.notification.resource.number)).toEqual([
      44, 44, 44, 44,
    ]);
    expect(harness.sent[2]?.notification.slackUserIds).toEqual(["UAUTHOR"]);
    expect(harness.sent[3]?.notification.slackUserIds).toEqual(["UREVIEWER"]);
    expect(harness.sent[4]?.notification.slackUserIds).toEqual(["UAUTHOR", "UOWNER"]);
  });

  test("PR会話とコードコメントではPR作成者をmentionする", async () => {
    const harness = await createHarness();

    expect(await harness.service.process(pullRequestCommentJob())).toBe(1);
    expect(await harness.service.process(reviewCommentJob())).toBe(1);

    expect(harness.sent.map((value) => value.notification.kind)).toEqual([
      "issue-opened",
      "issue-opened",
      "comment-created",
      "review-commented",
    ]);
    expect(harness.sent[2]?.notification.slackUserIds).toEqual(["UAUTHOR", "UMENTIONED"]);
    expect(harness.sent[3]?.notification.slackUserIds).toEqual(["UAUTHOR"]);
    expect(harness.sent[3]?.threadTs).toBe("900.1");
  });

  test("primary Issueが一意でないPRはchannel直下にもIssue threadにも通知しない", async () => {
    const harness = await createHarness();
    harness.github.pullRequest = {
      ...harness.github.pullRequest,
      primaryIssue: null,
      closingIssueCount: 0,
      linkedIssues: [],
    };

    expect(await harness.service.process(changesRequestedJob())).toBe(0);
    expect(harness.sent).toHaveLength(0);
  });

  test("closing IssueがWorkなら一意でもPR通知先にしない", async () => {
    const harness = await createHarness();
    harness.github.pullRequest = {
      ...harness.github.pullRequest,
      primaryIssue: { ...harness.github.issue, labels: ["type/work"] },
      linkedIssues: [{ ...harness.github.issue, labels: ["type/work"] }],
    };

    expect(await harness.service.process(changesRequestedJob())).toBe(0);
    expect(harness.sent).toHaveLength(0);
  });

  test("CI失敗をprimary Issue threadへ通知し、PR作成者と担当者を呼び出す", async () => {
    const harness = await createHarness();

    expect(await harness.service.process(checkRunFailedJob("author"))).toBe(1);
    expect(await harness.service.process(checkSuiteFailedJob())).toBe(0);

    expect(harness.sent.map((value) => value.notification.kind)).toEqual([
      "issue-opened",
      "issue-opened",
      "ci-failed",
    ]);
    expect(harness.sent[2]).toMatchObject({
      threadTs: "900.1",
      notification: {
        slackUserIds: ["UAUTHOR", "UOWNER"],
        actionUrl: "https://github.example/checks/501",
      },
    });
    expect(harness.sent[2]?.metadata?.requiredAction).toEqual({
      kind: "ci-failed",
      recipientSlackUserIds: ["UAUTHOR", "UOWNER"],
      actorSlackUserId: "UAUTHOR",
    });
  });

  test("AR-PR-004だけでreviewer指定済みならCI失敗mentionを重ねない", async () => {
    const harness = await createHarness();
    harness.github.checkDiagnostics = { policyCodes: ["AR-PR-004"], complete: true };

    expect(await harness.service.process(checkRunFailedJob("github-actions[bot]"))).toBe(0);
    expect(await harness.service.process(checkSuiteFailedJob())).toBe(0);
    expect(harness.sent).toHaveLength(0);
  });

  test("AR-PR-004だけでreviewer未指定ならauthorへ指定依頼を一度送る", async () => {
    const harness = await createHarness();
    harness.github.checkDiagnostics = { policyCodes: ["AR-PR-004"], complete: true };
    harness.github.pullRequest = {
      ...harness.github.pullRequest,
      requestedReviewerLogins: [],
      requestedTeamSlugs: [],
    };

    expect(await harness.service.process(checkRunFailedJob("github-actions[bot]"))).toBe(1);
    expect(await harness.service.process(checkSuiteFailedJob())).toBe(0);
    expect(harness.sent[2]?.notification).toMatchObject({
      slackUserIds: ["UAUTHOR"],
      summary: "PRのreviewer指定が必要です。",
      nextAction: "PR作成者以外のreviewerを指定してレビューを依頼する",
    });
    expect(harness.sent[2]?.metadata?.requiredAction).toEqual({
      kind: "approval-wait",
      recipientSlackUserIds: ["UAUTHOR"],
      actorSlackUserId: null,
    });
  });

  test("AR-PR-004と別失敗が混在する場合は通常CI通知を維持する", async () => {
    const harness = await createHarness();
    harness.github.checkDiagnostics = {
      policyCodes: ["AR-PR-004", "AR-PR-016"],
      complete: true,
    };

    expect(await harness.service.process(checkRunFailedJob("github-actions[bot]"))).toBe(1);
    expect(harness.sent[2]?.notification).toMatchObject({
      slackUserIds: ["UAUTHOR", "UOWNER"],
      summary: "PRのCIに対応が必要です。",
    });
  });

  test("annotation取得がthrowしても通常CI失敗通知へfallbackして一度だけ送る", async () => {
    const harness = await createHarness();
    harness.github.checkDiagnosticsError = new Error("Resource not accessible by integration");

    expect(await harness.service.process(checkRunFailedJob("github-actions[bot]"))).toBe(1);
    expect(await harness.service.process(checkSuiteFailedJob())).toBe(0);

    expect(harness.sent.map((value) => value.notification.kind)).toEqual([
      "issue-opened",
      "issue-opened",
      "ci-failed",
    ]);
    expect(harness.sent[2]?.notification).toMatchObject({
      slackUserIds: ["UAUTHOR", "UOWNER"],
      summary: "PRのCIに対応が必要です。",
      nextAction: "CIの失敗内容を確認し、修正または再実行する",
    });
  });

  test("自分でpushしたPRのCI失敗でもPR作成者本人へDMし、thread通知は一件のまま", async () => {
    const harness = await createHarness();

    expect(await harness.service.process(checkRunFailedJob("author"))).toBe(1);
    expect(
      await harness.service.process({
        ...checkRunFailedJob("author"),
        deliveryId: "delivery-check-failure-redelivery",
      }),
    ).toBe(0);

    expect(harness.sent).toHaveLength(3);
    expect(harness.dms).toEqual([
      { slackUserId: "UAUTHOR", kind: "ci-failed", notificationKind: "ci-failed" },
      { slackUserId: "UOWNER", kind: "ci-failed", notificationKind: "ci-failed" },
    ]);
  });

  test("差し戻しはPR作成者へ、修正pushは差し戻したreviewerへ一度だけDMする", async () => {
    const harness = await createHarness();

    expect(await harness.service.process(changesRequestedJob())).toBe(1);
    expect(
      await harness.service.process({ ...changesRequestedJob(), deliveryId: "delivery-review-2" }),
    ).toBe(0);
    expect(await harness.service.process(synchronizeJob("head-2"))).toBe(1);
    expect(
      await harness.service.process(synchronizeJob("head-2", "delivery-sync-redelivery")),
    ).toBe(0);

    expect(harness.sent.map((value) => value.notification.kind)).toEqual([
      "issue-opened",
      "issue-opened",
      "review-changes-requested",
      "revision-pushed",
    ]);
    expect(harness.sent[2]?.notification.slackUserIds).toEqual(["UAUTHOR"]);
    expect(harness.dms).toEqual([
      {
        slackUserId: "UAUTHOR",
        kind: "changes-requested",
        notificationKind: "review-changes-requested",
      },
      { slackUserId: "UREVIEWER", kind: "revision-pushed", notificationKind: "revision-pushed" },
    ]);
  });

  test("差し戻し本文のmentionはthreadに残し、DMはPR作成者だけへ送る", async () => {
    const harness = await createHarness();
    const job = changesRequestedJob();
    job.payload.review.body = "@mentioned も確認してください";

    expect(await harness.service.process(job)).toBe(1);
    expect(harness.sent[2]?.notification.slackUserIds).toEqual(["UAUTHOR", "UMENTIONED"]);
    expect(harness.dms.map((value) => value.slackUserId)).toEqual(["UAUTHOR"]);
  });

  test("ApproveはPR作成者へ一度だけDMし、自分のApproveはDMしない", async () => {
    const harness = await createHarness();

    expect(await harness.service.process(approvedJob("reviewer"))).toBe(1);
    expect(
      await harness.service.process({
        ...approvedJob("reviewer"),
        deliveryId: "delivery-approve-redelivery",
      }),
    ).toBe(0);
    expect(harness.sent).toHaveLength(3);
    expect(harness.dms).toEqual([
      { slackUserId: "UAUTHOR", kind: "approved", notificationKind: "review-approved" },
    ]);

    const selfHarness = await createHarness();
    expect(await selfHarness.service.process(approvedJob("author", 203))).toBe(1);
    expect(selfHarness.dms).toEqual([]);
  });

  test("Issueコメントは本文で明示mentionされた人だけへDMし、担当者への参考mentionはDMしない", async () => {
    const harness = await createHarness();
    const comment = issueCommentJob("delivery-comment");

    expect(await harness.service.process(comment)).toBe(1);
    expect(
      await harness.service.process({ ...comment, deliveryId: "delivery-comment-redelivery" }),
    ).toBe(0);

    expect(harness.sent).toHaveLength(3);
    expect(harness.sent[2]?.notification.slackUserIds).toEqual(["UOWNER", "UMENTIONED"]);
    expect(harness.dms).toEqual([
      { slackUserId: "UMENTIONED", kind: "mentioned", notificationKind: "comment-created" },
    ]);
  });

  test("PR会話コメントのmentionもその人だけへDMし、PR作成者へはDMしない", async () => {
    const harness = await createHarness();

    expect(await harness.service.process(pullRequestCommentJob())).toBe(1);
    expect(await harness.service.process(reviewCommentJob())).toBe(1);

    expect(harness.sent[2]?.notification.slackUserIds).toEqual(["UAUTHOR", "UMENTIONED"]);
    expect(harness.dms).toEqual([
      { slackUserId: "UMENTIONED", kind: "mentioned", notificationKind: "comment-created" },
    ]);
  });

  test("自分自身へのmentionとbotコメントはDMしない", async () => {
    const harness = await createHarness();
    const selfMention = issueCommentJob("delivery-self-mention", "mentioned");
    const botComment = commentWithId(issueCommentJob("delivery-bot", "arttra-app[bot]"), 102);
    const typedBot = commentWithId(issueCommentJob("delivery-typed-bot", "ci-helper"), 103);
    const typedBotUser: { login: string; type?: string } = typedBot.payload.comment.user;
    typedBotUser.type = "Bot";

    expect(await harness.service.process(selfMention)).toBe(1);
    expect(await harness.service.process(botComment)).toBe(1);
    expect(await harness.service.process(typedBot)).toBe(1);

    expect(
      harness.sent.filter((value) => value.notification.kind === "comment-created"),
    ).toHaveLength(3);
    expect(harness.dms).toEqual([]);
  });

  test("担当変更は新しい担当者へ一度だけDMし、自己assignmentと解除はDMしない", async () => {
    const harness = await createHarness();
    expect(await harness.service.process(issueOpenedJob())).toBe(1);
    harness.github.issue = { ...harness.github.issue, assigneeLogins: ["owner", "reviewer"] };
    const assigned = issueAssignedJob("merger", 44, "delivery-assign-reviewer");
    assigned.payload.assignee = { login: "reviewer" };

    expect(await harness.service.process(assigned)).toBe(1);
    expect(
      await harness.service.process({ ...assigned, deliveryId: "delivery-assign-redelivery" }),
    ).toBe(0);
    expect(harness.dms).toEqual([
      { slackUserId: "UOWNER", kind: "assigned", notificationKind: "issue-opened" },
      { slackUserId: "UREVIEWER", kind: "assigned", notificationKind: "issue-assignment-changed" },
    ]);

    harness.github.issue = { ...harness.github.issue, assigneeLogins: ["owner"] };
    const unassigned = issueAssignedJob("merger", 44, "delivery-unassign-reviewer");
    unassigned.payload.action = "unassigned";
    unassigned.payload.assignee = { login: "reviewer" };
    expect(await harness.service.process(unassigned)).toBe(1);
    harness.github.issue = { ...harness.github.issue, assigneeLogins: ["owner", "mentioned"] };
    expect(
      await harness.service.process(issueAssignedJob("mentioned", 44, "delivery-self-assign")),
    ).toBe(1);

    expect(harness.sent.map((value) => value.notification.kind)).toEqual([
      "issue-opened",
      "issue-opened",
      "issue-assignment-changed",
      "issue-assignment-changed",
      "issue-assignment-changed",
    ]);
    expect(harness.dms).toHaveLength(2);
  });

  test("Issue作成時の担当者へ一度だけDMし、初期assignment返信はthreadへ出さない", async () => {
    const initialAssigned = issueAssignedJob("requester", 44, "delivery-initial-assign");
    initialAssigned.payload.assignee = { login: "owner" };
    for (const order of ["opened-first", "assigned-first"] as const) {
      const harness = await createHarness();
      const jobs =
        order === "opened-first"
          ? [issueOpenedJob(), initialAssigned]
          : [initialAssigned, issueOpenedJob()];
      for (const job of jobs) await harness.service.process(job);
      // webhookの再配信は別delivery IDで同じ出来事を運ぶ。
      await harness.service.process(issueOpenedJob(44, "delivery-open-redelivery"));
      await harness.service.process({ ...initialAssigned, deliveryId: "delivery-assign-redo" });

      // 親Workのrootと、Task概要の返信だけ。担当変更の返信は増えない。
      expect(harness.sent.map((value) => value.notification.kind)).toEqual([
        "issue-opened",
        "issue-opened",
      ]);
      expect(harness.dms).toEqual([
        { slackUserId: "UOWNER", kind: "assigned", notificationKind: "issue-opened" },
      ]);
    }

    for (const issueType of ["work", "business"] as const) {
      const harness = await createHarness();
      harness.github.issue = {
        ...harness.github.issue,
        number: 86,
        url: "https://github.example/example/repo/issues/86",
        labels: [`type/${issueType}`],
      };
      expect(await harness.service.process(issueOpenedJob(86, `delivery-${issueType}`))).toBe(1);
      expect(await harness.service.process(issueAssignedJob("owner", 86))).toBe(0);
      expect(harness.sent).toHaveLength(1);
      expect(harness.dms).toEqual([
        { slackUserId: "UOWNER", kind: "assigned", notificationKind: "issue-opened" },
      ]);
    }
  });

  test("担当者を一度に複数追加しても、新しい担当者それぞれへ一度だけDMする", async () => {
    const harness = await createHarness();
    expect(await harness.service.process(issueOpenedJob())).toBe(1);
    // gh issue edit --add-assignee reviewer,mentioned は、担当一覧がそろった状態のassignedを2通運ぶ。
    harness.github.issue = {
      ...harness.github.issue,
      assigneeLogins: ["owner", "reviewer", "mentioned"],
    };
    const first = issueAssignedJob("merger", 44, "delivery-assign-reviewer");
    first.payload.assignee = { login: "reviewer" };
    const second = issueAssignedJob("merger", 44, "delivery-assign-mentioned");
    second.payload.assignee = { login: "mentioned" };

    expect(await harness.service.process(first)).toBe(1);
    expect(await harness.service.process(second)).toBe(0);
    // 同じdeliveryの再処理と、別delivery IDでの再配信。
    await harness.service.process(first);
    await harness.service.process(second);
    await harness.service.process({ ...first, deliveryId: "delivery-assign-reviewer-redo" });
    await harness.service.process({ ...second, deliveryId: "delivery-assign-mentioned-redo" });

    // 担当変更の返信は従来どおり担当一覧ごとに1件。
    expect(harness.sent.map((value) => value.notification.kind)).toEqual([
      "issue-opened",
      "issue-opened",
      "issue-assignment-changed",
    ]);
    expect(harness.dms).toEqual([
      { slackUserId: "UOWNER", kind: "assigned", notificationKind: "issue-opened" },
      { slackUserId: "UREVIEWER", kind: "assigned", notificationKind: "issue-assignment-changed" },
      { slackUserId: "UMENTIONED", kind: "assigned", notificationKind: "issue-assignment-changed" },
    ]);

    // 1人ずつ追加した場合も同じ件数になる。
    const oneByOne = await createHarness();
    expect(await oneByOne.service.process(issueOpenedJob())).toBe(1);
    oneByOne.github.issue = { ...oneByOne.github.issue, assigneeLogins: ["owner", "reviewer"] };
    expect(await oneByOne.service.process(first)).toBe(1);
    oneByOne.github.issue = {
      ...oneByOne.github.issue,
      assigneeLogins: ["owner", "reviewer", "mentioned"],
    };
    expect(await oneByOne.service.process(second)).toBe(1);
    expect(oneByOne.dms).toEqual(harness.dms);
  });

  test("担当を外して付け直すと新しい付与として一度だけDMし、再配信では増やさない", async () => {
    const harness = await createHarness();
    expect(await harness.service.process(issueOpenedJob())).toBe(1);
    const assigned = issueAssignedJob("merger", 44, "delivery-assign-reviewer");
    assigned.payload.assignee = { login: "reviewer" };
    const unassigned = issueAssignedJob("merger", 44, "delivery-unassign-reviewer");
    unassigned.payload.action = "unassigned";
    unassigned.payload.assignee = { login: "reviewer" };
    const reassigned = { ...assigned, deliveryId: "delivery-reassign-reviewer" };

    harness.github.issue = { ...harness.github.issue, assigneeLogins: ["owner", "reviewer"] };
    await harness.service.process(assigned);
    harness.github.issue = { ...harness.github.issue, assigneeLogins: ["owner"] };
    await harness.service.process(unassigned);
    // 解除後に古いassignedが再配信されても、現在の担当でないので送らない。
    await harness.service.process({ ...assigned, deliveryId: "delivery-assign-late-redo" });
    harness.github.issue = { ...harness.github.issue, assigneeLogins: ["owner", "reviewer"] };
    await harness.service.process(reassigned);
    await harness.service.process({ ...reassigned, deliveryId: "delivery-reassign-redo" });
    // 付け直した後に古いunassignedが再配信されても、現在の付与は終わらない。
    await harness.service.process({ ...unassigned, deliveryId: "delivery-unassign-late-redo" });
    await harness.service.process({ ...reassigned, deliveryId: "delivery-reassign-redo-2" });

    const reviewerDms = harness.dmDetails.filter((_, index) => {
      return harness.dms[index]?.slackUserId === "UREVIEWER";
    });
    expect(reviewerDms).toHaveLength(2);
    // 付与ごとに別のDM intentになる。
    expect(new Set(reviewerDms.map((value) => value.intentId)).size).toBe(2);
  });

  test("作成時の担当者へ後からassignedが届いてもDMは一件のまま", async () => {
    const harness = await createHarness();
    harness.github.issue = { ...harness.github.issue, assigneeLogins: ["owner", "reviewer"] };
    const ownerAssigned = issueAssignedJob("requester", 44, "delivery-initial-owner");
    ownerAssigned.payload.assignee = { login: "owner" };
    const reviewerAssigned = issueAssignedJob("requester", 44, "delivery-initial-reviewer");
    reviewerAssigned.payload.assignee = { login: "reviewer" };

    await harness.service.process(issueOpenedJob());
    await harness.service.process(ownerAssigned);
    await harness.service.process(reviewerAssigned);
    await harness.service.process({ ...reviewerAssigned, deliveryId: "delivery-initial-redo" });

    expect(harness.sent.map((value) => value.notification.kind)).toEqual([
      "issue-opened",
      "issue-opened",
    ]);
    expect(harness.dms).toEqual([
      { slackUserId: "UOWNER", kind: "assigned", notificationKind: "issue-opened" },
      { slackUserId: "UREVIEWER", kind: "assigned", notificationKind: "issue-opened" },
    ]);
  });

  test("操作者本人が自分を担当にした場合は、一度に複数追加しても本人へDMしない", async () => {
    const harness = await createHarness();
    expect(await harness.service.process(issueOpenedJob())).toBe(1);
    harness.github.issue = { ...harness.github.issue, assigneeLogins: ["owner", "reviewer"] };
    const selfAssigned = issueAssignedJob("reviewer", 44, "delivery-self-assign");

    expect(await harness.service.process(selfAssigned)).toBe(1);
    await harness.service.process({ ...selfAssigned, deliveryId: "delivery-self-assign-redo" });

    expect(harness.dms.filter((value) => value.slackUserId === "UREVIEWER")).toEqual([]);
  });

  test("Work親投稿が先に別経路で作られていても、Work作成時の担当者へDMする", async () => {
    const harness = await createHarness();
    harness.github.parentIssue = { ...harness.github.parentIssue, assigneeLogins: ["reviewer"] };

    // Taskの概要が先に処理され、親Workのrootを作る。
    expect(await harness.service.process(issueOpenedJob())).toBe(1);
    const sentBeforeWork = harness.sent.length;
    expect(await harness.service.process(issueOpenedJob(86, "delivery-work-open"))).toBe(1);
    await harness.service.process(issueOpenedJob(86, "delivery-work-open-redo"));

    // Workの概要はroot作成済みなので投稿されないが、担当DMは届く。
    expect(harness.sent).toHaveLength(sentBeforeWork);
    expect(harness.dms).toEqual([
      { slackUserId: "UOWNER", kind: "assigned", notificationKind: "issue-opened" },
      { slackUserId: "UREVIEWER", kind: "assigned", notificationKind: "issue-opened" },
    ]);
    expect(harness.dmDetails.map((value) => value.resourceUrl)).toEqual([
      "https://github.example/example/repo/issues/44",
      "https://github.example/example/repo/issues/86",
    ]);
  });

  test("作成者本人だけが担当のIssueは作成時の担当DMを送らない", async () => {
    const harness = await createHarness();
    harness.github.issue = { ...harness.github.issue, assigneeLogins: ["requester"] };

    expect(await harness.service.process(issueOpenedJob())).toBe(1);
    expect(await harness.service.process(issueAssignedJob("requester"))).toBe(0);

    expect(harness.sent).toHaveLength(2);
    expect(harness.dms).toEqual([]);
  });

  test("PRコードコメントの本文mentionはその人だけへDMし、PR作成者へはDMしない", async () => {
    const harness = await createHarness();
    const job = reviewCommentJob();
    job.payload.comment.body = "@mentioned この条件を確認してください";

    expect(await harness.service.process(job)).toBe(1);
    expect(await harness.service.process({ ...job, deliveryId: "delivery-code-redo" })).toBe(0);

    expect(harness.sent[2]?.notification.kind).toBe("review-commented");
    expect(harness.sent[2]?.notification.slackUserIds).toEqual(["UAUTHOR", "UMENTIONED"]);
    expect(harness.dms).toEqual([
      { slackUserId: "UMENTIONED", kind: "mentioned", notificationKind: "review-commented" },
    ]);
  });

  test("COMMENTEDレビュー本文のmentionはその人だけへDMし、PR作成者へはDMしない", async () => {
    const harness = await createHarness();
    const job = approvedJob("reviewer", 204);
    job.payload.review.state = "commented";
    job.payload.review.body = "@mentioned 設計の意図を教えてください";

    expect(await harness.service.process(job)).toBe(1);
    expect(await harness.service.process({ ...job, deliveryId: "delivery-review-redo" })).toBe(0);

    expect(harness.sent).toHaveLength(3);
    expect(harness.sent[2]?.notification.kind).toBe("review-commented");
    expect(harness.sent[2]?.notification.slackUserIds).toEqual(["UAUTHOR", "UMENTIONED"]);
    expect(harness.dms).toEqual([
      { slackUserId: "UMENTIONED", kind: "mentioned", notificationKind: "review-commented" },
    ]);
  });
});

async function createHarness(
  githubCapabilities = GitHubCapabilityGrants.empty(),
  allowedRepositories: readonly string[] | null = null,
) {
  const store = new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-lifecycle-")));
  const github = new FakeLifecycleClient();
  const sent: Array<{
    notification: LifecycleNotification;
    threadTs: string | null;
    metadata?: NotificationIntentMetadata;
  }> = [];
  const ids: Record<string, string> = {
    author: "UAUTHOR",
    mentioned: "UMENTIONED",
    owner: "UOWNER",
    requester: "UREQUESTER",
    reviewer: "UREVIEWER",
  };
  const dms: Array<{
    slackUserId: string;
    kind: string | undefined;
    notificationKind: LifecycleNotification["kind"];
  }> = [];
  const dmDetails: Array<{ resourceUrl: string; intentId: string | undefined }> = [];
  // channel/thread通知の記録はDM wrapperの有無で変わらない。DMは別配列へ記録する。
  const notifier = new LifecycleNotifierWithRequiredActionDm(
    {
      notify: async (notification, threadTs, metadata) => {
        sent.push({ notification, threadTs, ...(metadata ? { metadata } : {}) });
        return { messageTs: threadTs ?? "900.1" };
      },
    },
    new RequiredActionDmService((slackUserId) => ({
      lifecycle: {
        notify: async (notification, _threadTs, metadata) => {
          dms.push({
            slackUserId,
            kind: metadata?.requiredAction?.kind,
            notificationKind: notification.kind,
          });
          dmDetails.push({ resourceUrl: notification.resource.url, intentId: metadata?.intentId });
          return { messageTs: "990.1" };
        },
      },
      work: {
        notify: async () => ({ messageTs: "990.2" }),
        digest: async () => {},
      },
    })),
  );
  const service = new LifecycleNotificationService(
    github,
    store,
    new NotificationThreadService(store, () => Date.parse("2026-08-02T00:00:00Z")),
    notifier,
    async (login) => ids[login] ?? null,
    () => Date.parse("2026-08-02T00:00:00Z"),
    allowedRepositories,
    githubCapabilities,
  );
  return { service, github, sent, dms, dmDetails };
}

class FakeLifecycleClient implements GitHubLifecycleClient {
  checkDiagnostics = { policyCodes: [] as string[], complete: false };
  checkDiagnosticsError: Error | null = null;
  issue: GitHubIssueContext = {
    number: 44,
    title: "ライフサイクル通知",
    url: "https://github.example/example/repo/issues/44",
    body: "",
    state: "open",
    authorLogin: "requester",
    assigneeLogins: ["owner"],
    labels: ["type/task", "merge/review"],
    parentIssueUrl: "https://github.example/example/repo/issues/86",
  };

  parentIssue: GitHubIssueContext = {
    number: 86,
    title: "通知をまとめるWork",
    url: "https://github.example/example/repo/issues/86",
    body: "",
    state: "open",
    authorLogin: "requester",
    assigneeLogins: ["owner"],
    labels: ["type/work"],
    parentIssueUrl: "https://github.example/example/repo/issues/7",
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
    primaryIssue: this.issue,
    closingIssueCount: 1,
    linkedIssues: [this.issue],
    codeowners: "* @reviewer",
    requiredApprovals: 1,
    requestedReviewerLogins: ["reviewer"],
    requestedTeamSlugs: [],
    approvedReviewerLogins: [],
    changesRequestedReviewerLogins: ["reviewer"],
  };

  async loadIssueContext(_repository: string, issueNumber: number): Promise<GitHubIssueContext> {
    if (issueNumber === this.issue.number) return this.issue;
    if (issueNumber === this.parentIssue.number) return this.parentIssue;
    throw new Error(`Issue #${issueNumber}がfixtureにありません。`);
  }

  async loadPullRequestReviewContext(): Promise<PullRequestReviewContext> {
    return {
      ...this.pullRequest,
      primaryIssue:
        this.pullRequest.closingIssueCount === 1
          ? (this.pullRequest.linkedIssues[0] ?? null)
          : null,
    };
  }

  async loadCheckFailureDiagnostics() {
    if (this.checkDiagnosticsError) throw this.checkDiagnosticsError;
    return this.checkDiagnostics;
  }
}

function basePayload() {
  return {
    repository: { full_name: "example/repo" },
    sender: { login: "merger" },
  };
}

function issueCommentJob(deliveryId: string, actor = "commenter") {
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
        user: { login: actor },
      },
    },
  };
}

function commentWithId(job: ReturnType<typeof issueCommentJob>, id: number) {
  job.payload.comment.id = id;
  job.payload.comment.html_url = `https://github.example/example/repo/issues/44#issuecomment-${id}`;
  return job;
}

function issueClosedJob(deliveryId = "delivery-close", updatedAt = "2026-08-02T00:00:00Z") {
  return {
    schemaVersion: 1 as const,
    deliveryId,
    event: "issues",
    payload: {
      ...basePayload(),
      action: "closed",
      issue: { number: 44, updated_at: updatedAt },
    },
  };
}

function issueReopenedJob(deliveryId: string, updatedAt: string) {
  return {
    schemaVersion: 1 as const,
    deliveryId,
    event: "issues",
    payload: {
      ...basePayload(),
      action: "reopened",
      issue: { number: 44, updated_at: updatedAt },
    },
  };
}

function issueOpenedJob(issueNumber = 44, deliveryId = "delivery-open") {
  return {
    schemaVersion: 1 as const,
    deliveryId,
    event: "issues",
    payload: { ...basePayload(), action: "opened", issue: { number: issueNumber } },
  };
}

function selfMergeLabeledJob(actor = "merger") {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-self-merge-label",
    event: "issues",
    payload: {
      ...basePayload(),
      sender: { login: actor },
      action: "labeled",
      issue: { number: 44 },
      label: { name: "merge/self" },
    },
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

function checkRunFailedJob(actor = "merger") {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-check-failure",
    event: "check_run",
    payload: {
      ...basePayload(),
      sender: { login: actor },
      action: "completed",
      check_run: {
        id: 501,
        name: "verify",
        conclusion: "failure",
        html_url: "https://github.example/checks/501",
        pull_requests: [{ number: 45 }],
      },
    },
  };
}

function issueAssignedJob(actor: string, issueNumber = 44, deliveryId = "delivery-assigned") {
  return {
    schemaVersion: 1 as const,
    deliveryId,
    event: "issues",
    payload: {
      ...basePayload(),
      sender: { login: actor },
      action: "assigned",
      issue: { number: issueNumber },
      assignee: { login: actor },
    },
  };
}

function issueUnassignedJob(actor: string, issueNumber = 44) {
  return {
    ...issueAssignedJob(actor, issueNumber, "delivery-unassigned"),
    payload: {
      ...issueAssignedJob(actor, issueNumber).payload,
      action: "unassigned",
    },
  };
}

function checkSuiteFailedJob() {
  return {
    schemaVersion: 1 as const,
    deliveryId: "delivery-check-suite-failure",
    event: "check_suite",
    payload: {
      ...basePayload(),
      action: "completed",
      check_suite: { id: 601, conclusion: "failure", pull_requests: [{ number: 45 }] },
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

function approvedJob(actor: string, reviewId = 202) {
  return {
    schemaVersion: 1 as const,
    deliveryId: `delivery-approve-${reviewId}`,
    event: "pull_request_review",
    payload: {
      ...basePayload(),
      action: "submitted",
      pull_request: {
        number: 45,
        html_url: "https://github.example/example/repo/pull/45",
      },
      review: {
        id: reviewId,
        state: "approved",
        body: "",
        html_url: `https://github.example/example/repo/pull/45#pullrequestreview-${reviewId}`,
        user: { login: actor },
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
