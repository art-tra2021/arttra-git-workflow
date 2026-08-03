import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectReviewerCandidates,
  PullRequestReviewService,
  parsePlannedReviewers,
} from "../src/review-service.ts";
import type {
  GitHubReviewClient,
  GitHubReviewerIdentity,
  PullRequestReviewContext,
  ReviewRequestReadModel,
} from "../src/review-types.ts";
import { LocalStateStore } from "../src/state-store.ts";

describe("PullRequestReviewService", () => {
  test("Issue予定reviewerとCODEOWNERSを統合してGitHub requestと人間向け通知を作る", async () => {
    const github = new FakeReviewClient(context());
    const notifications: ReviewRequestReadModel[] = [];
    let now = Date.parse("2026-08-01T00:00:00Z");
    const service = new PullRequestReviewService(
      github,
      {
        findByGitHubUserId: async (_teamId, githubUserId) =>
          githubUserId === 101
            ? {
                schemaVersion: 1,
                revision: 1,
                slackTeamId: "T123",
                slackUserId: "U_ALICE",
                githubUserId,
                githubLogin: "alice",
                verifiedAt: "2026-08-01T00:00:00Z",
              }
            : null,
      },
      new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-review-"))),
      {
        notify: async (model) => {
          notifications.push(structuredClone(model));
        },
      },
      { slackTeamId: "T123", now: () => now },
    );

    const model = await service.process("example/repo", 28);
    expect(github.requests).toEqual([{ reviewers: ["alice", "bob"], teams: ["frontend"] }]);
    expect(model).toMatchObject({
      schemaVersion: 1,
      kind: "review.request",
      dueDate: "2026-08-15",
      requiredApprovals: 1,
    });
    expect(model?.reviewers.find((reviewer) => reviewer.githubLogin === "alice")).toMatchObject({
      githubUserId: 101,
      slackUserId: "U_ALICE",
      notified: true,
    });
    expect(notifications).toHaveLength(1);

    await service.process("example/repo", 28);
    expect(notifications).toHaveLength(1);
    now += 24 * 60 * 60 * 1000;
    expect(await service.remindPending()).toBe(1);
    expect(notifications).toHaveLength(2);
  });

  test("draft PRはreview requestを作らない", async () => {
    const github = new FakeReviewClient({ ...context(), draft: true });
    const service = new PullRequestReviewService(
      github,
      { findByGitHubUserId: async () => null },
      new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-review-"))),
      { notify: async () => {} },
      { slackTeamId: "T123" },
    );
    expect(await service.process("example/repo", 28)).toBeNull();
    expect(github.requests).toHaveLength(0);
  });

  test("差し戻したreviewerは修正push後だけ再requestする", async () => {
    const github = new FakeReviewClient({
      ...context(),
      changesRequestedReviewerLogins: ["alice"],
    });
    const service = new PullRequestReviewService(
      github,
      { findByGitHubUserId: async () => null },
      new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-review-rerequest-"))),
      { notify: async () => {} },
      { slackTeamId: "T123" },
    );

    await service.process("example/repo", 28);
    expect(github.requests).toEqual([{ reviewers: ["bob"], teams: ["frontend"] }]);
    await service.process("example/repo", 28, { reRequestChanges: true });
    expect(github.requests[1]).toEqual({ reviewers: ["alice", "bob"], teams: ["frontend"] });
  });

  test("GitHubで手動指定されたreviewerをSlack identityへ通知し、再処理で重複通知しない", async () => {
    const github = new FakeReviewClient({
      ...context(),
      files: [],
      linkedIssues: [],
      codeowners: "",
      requestedReviewerLogins: ["carol"],
      requestedTeamSlugs: ["backend"],
    });
    const notifications: ReviewRequestReadModel[] = [];
    const service = new PullRequestReviewService(
      github,
      {
        findByGitHubUserId: async (_teamId, githubUserId) =>
          githubUserId === 303
            ? {
                schemaVersion: 1,
                revision: 1,
                slackTeamId: "T123",
                slackUserId: "U_CAROL",
                githubUserId,
                githubLogin: "carol",
                verifiedAt: "2026-08-01T00:00:00Z",
              }
            : null,
      },
      new LocalStateStore(await mkdtemp(join(tmpdir(), "arttra-review-requested-"))),
      {
        notify: async (model) => {
          notifications.push(structuredClone(model));
        },
      },
      { slackTeamId: "T123" },
    );

    const first = await service.process("example/repo", 28);
    await service.process("example/repo", 28);

    expect(first?.reviewers).toEqual([
      expect.objectContaining({
        githubUserId: 303,
        githubLogin: "carol",
        slackUserId: "U_CAROL",
        notified: true,
        reasons: ["GitHubで指定されたreviewer"],
      }),
    ]);
    expect(first?.teams).toEqual([
      { slug: "backend", reasons: ["GitHubで指定されたreviewer team"] },
    ]);
    expect(notifications).toHaveLength(1);
    expect(
      github.requests.every(({ reviewers, teams }) => reviewers.length === 0 && teams.length === 0),
    ).toBe(true);
  });
});

describe("reviewer構造", () => {
  test("version付きmarkerだけをGitHub ID/loginとして読む", () => {
    expect(
      parsePlannedReviewers(
        '<!-- ar:reviewers:v1 [{"id":101,"login":"alice"},{"id":"bad","login":"bob"}] -->',
      ),
    ).toEqual([{ id: 101, login: "alice" }]);
  });

  test("CODEOWNERSはfileごとの最後の一致を採用する", () => {
    const candidates = collectReviewerCandidates(context());
    expect([...candidates.users.keys()].sort()).toEqual(["alice", "bob"]);
    expect([...candidates.teams.keys()]).toEqual(["frontend"]);
    expect(candidates.users.get("alice")?.reasons).toContain("Issue #29の予定レビュワー");
    expect(candidates.teams.get("frontend")).toContain("CODEOWNERS: src/app.ts");
  });
});

class FakeReviewClient implements GitHubReviewClient {
  readonly requests: Array<{ reviewers: string[]; teams: string[] }> = [];
  private readonly value: PullRequestReviewContext;

  constructor(value: PullRequestReviewContext) {
    this.value = value;
  }

  async loadPullRequestReviewContext(): Promise<PullRequestReviewContext> {
    return this.value;
  }

  async resolveGitHubUsers(logins: string[]): Promise<GitHubReviewerIdentity[]> {
    const ids: Record<string, number> = { alice: 101, bob: 202, carol: 303 };
    return logins.map((login) => ({ id: ids[login] ?? 999, login }));
  }

  async requestPullRequestReviewers(
    _repository: string,
    _pullRequestNumber: number,
    reviewers: string[],
    teams: string[],
  ): Promise<void> {
    this.requests.push({ reviewers, teams });
  }
}

function context(): PullRequestReviewContext {
  return {
    schemaVersion: 1,
    repository: "example/repo",
    number: 28,
    title: "自動reviewer",
    url: "https://github.example/example/repo/pull/28",
    authorLogin: "author",
    headSha: "abc123",
    draft: false,
    state: "open",
    body: "Closes #29",
    files: ["src/app.ts", "docs/guide.md"],
    linkedIssues: [
      {
        number: 29,
        title: "通知を統合する",
        url: "https://github.example/example/repo/issues/29",
        state: "open",
        authorLogin: "requester",
        assigneeLogins: ["owner"],
        labels: ["type/work", "merge/review"],
        body: [
          "## 目標日",
          "",
          "2026-08-15",
          "",
          '<!-- ar:reviewers:v1 [{"id":101,"login":"alice"}] -->',
        ].join("\n"),
      },
    ],
    codeowners: ["*.md @bob", "src/* @alice", "/src/** @example/frontend"].join("\n"),
    requiredApprovals: 1,
    requestedReviewerLogins: [],
    requestedTeamSlugs: [],
    approvedReviewerLogins: [],
    changesRequestedReviewerLogins: [],
  };
}
