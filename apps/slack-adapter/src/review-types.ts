export interface GitHubIssueContext {
  number: number;
  title: string;
  url: string;
  body: string;
  state: "open" | "closed";
  authorLogin: string;
  assigneeLogins: string[];
  labels: string[];
  parentIssueUrl?: string | null;
}

export interface PullRequestReviewContext {
  schemaVersion: 1;
  repository: string;
  number: number;
  title: string;
  url: string;
  authorLogin: string;
  headSha: string;
  draft: boolean;
  state: "open" | "closed";
  mergeableState?: string;
  body: string;
  files: string[];
  /** GitHubがclosing referenceとして解決したIssueがちょうど1件のときだけ設定する。 */
  primaryIssue: GitHubIssueContext | null;
  /** GitHubのclosingIssuesReferences.totalCount。0件と複数件を区別する。 */
  closingIssueCount: number;
  /**
   * GitHubが解決したclosing Issue一覧。
   *
   * @deprecated 通知routeにはprimaryIssueを使う。互換性のため一時的に保持する。
   */
  linkedIssues: GitHubIssueContext[];
  codeowners: string;
  requiredApprovals: number;
  requestedReviewerLogins: string[];
  requestedTeamSlugs: string[];
  approvedReviewerLogins: string[];
  changesRequestedReviewerLogins: string[];
}

export interface GitHubReviewerIdentity {
  id: number;
  login: string;
}

export interface GitHubReviewClient {
  loadPullRequestReviewContext(
    repository: string,
    pullRequestNumber: number,
  ): Promise<PullRequestReviewContext>;
  resolveGitHubUsers(logins: string[]): Promise<GitHubReviewerIdentity[]>;
  requestPullRequestReviewers(
    repository: string,
    pullRequestNumber: number,
    reviewerLogins: string[],
    teamSlugs: string[],
  ): Promise<void>;
}

export interface GitHubLifecycleClient
  extends Pick<GitHubReviewClient, "loadPullRequestReviewContext"> {
  loadIssueContext(repository: string, issueNumber: number): Promise<GitHubIssueContext>;
  loadCheckFailureDiagnostics(
    repository: string,
    check: GitHubCheckFailure,
  ): Promise<GitHubCheckFailureDiagnostics>;
  stopSelfMerge?(
    repository: string,
    issueNumber: number,
    actorLogin: string,
    reason: string,
  ): Promise<GitHubIssueContext>;
}

export interface GitHubCheckFailure {
  kind: "check_run" | "check_suite";
  id: number;
}

export interface GitHubCheckFailureDiagnostics {
  /** GitHub Actions error annotationから抽出した決定的なPR Policy code。 */
  policyCodes: string[];
  /** 失敗runのすべてをPolicy codeで説明できる場合だけtrue。 */
  complete: boolean;
}

export interface ReviewRequestReadModel {
  schemaVersion: 1;
  kind: "review.request";
  repository: string;
  pullRequest: {
    number: number;
    title: string;
    url: string;
    headSha: string;
  };
  authorLogin: string;
  primaryIssue: GitHubIssueContext | null;
  closingIssueCount: number;
  linkedIssues: GitHubIssueContext[];
  requiredApprovals: number;
  reviewers: Array<{
    githubUserId: number;
    githubLogin: string;
    slackUserId: string | null;
    reasons: string[];
    notified: boolean;
  }>;
  teams: Array<{ slug: string; reasons: string[] }>;
  dueDate: string | null;
  nextAction: string;
  updatedAt: string;
}
