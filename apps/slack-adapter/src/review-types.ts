export interface GitHubIssueContext {
  number: number;
  title: string;
  url: string;
  body: string;
  state: "open" | "closed";
  authorLogin: string;
  assigneeLogins: string[];
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
  body: string;
  files: string[];
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
