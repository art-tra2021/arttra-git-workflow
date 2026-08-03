use std::process::{Command, Output};

use anyhow::{Context, Result, bail};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::policy::BranchPolicy;

const ISSUE_FIELDS: &str = "number,title,body,state,url,labels,assignees,blockedBy,blocking,parent,subIssues,milestone,projectItems,updatedAt";
const PR_FIELDS: &str =
    "number,title,state,url,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup";

#[derive(Debug, Serialize)]
pub struct StatusReport {
    schema_version: u32,
    repository: String,
    branch: String,
    head: String,
    issue: Option<IssueStatus>,
    pull_request: Option<PullRequestStatus>,
    worktree: WorktreeStatus,
    upstream: UpstreamStatus,
    next_actions: Vec<NextAction>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IssueStatus {
    number: u64,
    title: String,
    url: String,
    state: String,
    body: String,
    purpose: Option<String>,
    completion_items: Vec<ChecklistItem>,
    labels: Vec<String>,
    assignees: Vec<String>,
    blocked_by: Vec<IssueReference>,
    blocking: Vec<IssueReference>,
    parent: Option<IssueReference>,
    sub_issues: Vec<IssueReference>,
    milestone: Option<MilestoneStatus>,
    project_items: Value,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ChecklistItem {
    text: String,
    checked: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct IssueReference {
    number: u64,
    title: String,
    state: String,
    url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MilestoneStatus {
    title: String,
    due_on: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestStatus {
    number: u64,
    title: String,
    url: String,
    state: String,
    is_draft: bool,
    merge_state: String,
    review_decision: String,
    checks: CheckSummary,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct CheckSummary {
    total: usize,
    success: usize,
    pending: usize,
    failure: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct WorktreeStatus {
    clean: bool,
    staged: usize,
    unstaged: usize,
    untracked: usize,
    conflicted: usize,
    files: Vec<ChangedFile>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChangedFile {
    path: String,
    state: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct UpstreamStatus {
    configured: bool,
    ahead: u64,
    behind: u64,
    base_branch: Option<String>,
    commits_ahead_of_base: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NextAction {
    id: &'static str,
    title: String,
    reason: String,
    command: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawIssue {
    number: u64,
    title: String,
    url: String,
    state: String,
    body: String,
    labels: Vec<RawLabel>,
    assignees: Vec<RawAssignee>,
    blocked_by: RawIssueConnection,
    blocking: RawIssueConnection,
    parent: Option<RawIssueReference>,
    sub_issues: RawIssueConnection,
    milestone: Option<RawMilestone>,
    project_items: Value,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
struct RawLabel {
    name: String,
}

#[derive(Debug, Deserialize)]
struct RawAssignee {
    login: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawIssueConnection {
    #[serde(default)]
    nodes: Vec<RawIssueReference>,
}

#[derive(Debug, Deserialize)]
struct RawIssueReference {
    number: u64,
    title: String,
    state: String,
    url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMilestone {
    title: String,
    due_on: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPullRequest {
    number: u64,
    title: String,
    url: String,
    state: String,
    is_draft: bool,
    merge_state_status: String,
    review_decision: String,
    status_check_rollup: Vec<Value>,
}

struct RecommendationFacts<'a> {
    branch: &'a str,
    protected: bool,
    issue: Option<&'a IssueStatus>,
    pull_request: Option<&'a PullRequestStatus>,
    worktree: &'a WorktreeStatus,
    upstream: &'a UpstreamStatus,
}

pub fn show(issue_override: Option<u64>, json: bool, policy: &BranchPolicy) -> Result<()> {
    let branch = git(&["branch", "--show-current"])?;
    if branch.is_empty() {
        bail!("detached HEADでは現在の作業を判定できません");
    }
    let head = git(&["rev-parse", "--short", "HEAD"])?;
    let repository = repository_name().unwrap_or_else(|_| "(unknown)".into());
    let worktree = read_worktree()?;
    let upstream = read_upstream();
    let mut warnings = Vec::new();

    let issue_number = issue_override.or_else(|| issue_number_from_branch(&branch));
    let issue = match issue_number {
        Some(number) => match fetch_issue(number) {
            Ok(issue) => Some(issue),
            Err(error) => {
                warnings.push(format!("Issue #{number}を取得できませんでした: {error:#}"));
                None
            }
        },
        None => None,
    };
    let pull_request = match fetch_pull_request() {
        Ok(pull_request) => pull_request,
        Err(error) => {
            warnings.push(format!("PRを取得できませんでした: {error:#}"));
            None
        }
    };
    let protected = policy
        .protected_branches
        .iter()
        .any(|protected| protected == &branch);
    let next_actions = recommend(&RecommendationFacts {
        branch: &branch,
        protected,
        issue: issue.as_ref(),
        pull_request: pull_request.as_ref(),
        worktree: &worktree,
        upstream: &upstream,
    });
    let report = StatusReport {
        schema_version: 1,
        repository,
        branch,
        head,
        issue,
        pull_request,
        worktree,
        upstream,
        next_actions,
        warnings,
    };

    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        print_human(&report);
    }
    Ok(())
}

fn fetch_issue(number: u64) -> Result<IssueStatus> {
    let output = Command::new("gh")
        .args(["issue", "view", &number.to_string(), "--json", ISSUE_FIELDS])
        .output()
        .context("gh issue viewを起動できませんでした")?;
    ensure_success(&output, "Issue取得")?;
    let raw: RawIssue =
        serde_json::from_slice(&output.stdout).context("IssueのJSONを解析できませんでした")?;
    Ok(normalize_issue(raw))
}

fn fetch_pull_request() -> Result<Option<PullRequestStatus>> {
    let output = Command::new("gh")
        .args(["pr", "view", "--json", PR_FIELDS])
        .output()
        .context("gh pr viewを起動できませんでした")?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        if detail.contains("no pull requests found")
            || detail.contains("Could not resolve to a PullRequest")
        {
            return Ok(None);
        }
        bail!("{}", detail.trim());
    }
    let raw: RawPullRequest =
        serde_json::from_slice(&output.stdout).context("PRのJSONを解析できませんでした")?;
    Ok(Some(PullRequestStatus {
        number: raw.number,
        title: raw.title,
        url: raw.url,
        state: raw.state,
        is_draft: raw.is_draft,
        merge_state: raw.merge_state_status,
        review_decision: raw.review_decision,
        checks: summarize_checks(&raw.status_check_rollup),
    }))
}

fn normalize_issue(raw: RawIssue) -> IssueStatus {
    let purpose = issue_purpose(&raw.body);
    let completion_items = completion_items(&raw.body);
    IssueStatus {
        number: raw.number,
        title: raw.title,
        url: raw.url,
        state: raw.state,
        body: raw.body,
        purpose,
        completion_items,
        labels: raw.labels.into_iter().map(|label| label.name).collect(),
        assignees: raw
            .assignees
            .into_iter()
            .map(|assignee| assignee.login)
            .collect(),
        blocked_by: raw
            .blocked_by
            .nodes
            .into_iter()
            .map(normalize_issue_reference)
            .collect(),
        blocking: raw
            .blocking
            .nodes
            .into_iter()
            .map(normalize_issue_reference)
            .collect(),
        parent: raw.parent.map(normalize_issue_reference),
        sub_issues: raw
            .sub_issues
            .nodes
            .into_iter()
            .map(normalize_issue_reference)
            .collect(),
        milestone: raw.milestone.map(|milestone| MilestoneStatus {
            title: milestone.title,
            due_on: milestone.due_on,
        }),
        project_items: raw.project_items,
        updated_at: raw.updated_at,
    }
}

fn normalize_issue_reference(raw: RawIssueReference) -> IssueReference {
    IssueReference {
        number: raw.number,
        title: raw.title,
        state: raw.state,
        url: raw.url,
    }
}

fn read_worktree() -> Result<WorktreeStatus> {
    let output = Command::new("git")
        .args(["status", "--porcelain=v1"])
        .output()
        .context("git statusを起動できませんでした")?;
    ensure_success(&output, "git status")?;
    Ok(parse_worktree(&String::from_utf8_lossy(&output.stdout)))
}

fn parse_worktree(output: &str) -> WorktreeStatus {
    let mut worktree = WorktreeStatus::default();
    for line in output.lines().filter(|line| !line.is_empty()) {
        let state = line.get(..2).unwrap_or("??");
        let path = line.get(3..).unwrap_or(line).to_owned();
        let bytes = state.as_bytes();
        if state == "??" {
            worktree.untracked += 1;
        } else {
            if bytes.first().is_some_and(|value| *value != b' ') {
                worktree.staged += 1;
            }
            if bytes.get(1).is_some_and(|value| *value != b' ') {
                worktree.unstaged += 1;
            }
            if is_conflict_state(state) {
                worktree.conflicted += 1;
            }
        }
        worktree.files.push(ChangedFile {
            path,
            state: state.into(),
        });
    }
    worktree.clean = worktree.files.is_empty();
    worktree
}

fn read_upstream() -> UpstreamStatus {
    let (configured, behind, ahead) =
        if let Ok(value) = git(&["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]) {
            let mut parts = value.split_whitespace();
            (
                true,
                parts
                    .next()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0),
                parts
                    .next()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0),
            )
        } else {
            (false, 0, 0)
        };
    let base_branch = git(&["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).ok();
    let commits_ahead_of_base = base_branch
        .as_deref()
        .and_then(|base| git(&["rev-list", "--count", &format!("{base}..HEAD")]).ok())
        .and_then(|count| count.parse().ok())
        .unwrap_or(0);
    UpstreamStatus {
        configured,
        ahead,
        behind,
        base_branch,
        commits_ahead_of_base,
    }
}

fn repository_name() -> Result<String> {
    let output = Command::new("gh")
        .args([
            "repo",
            "view",
            "--json",
            "nameWithOwner",
            "--jq",
            ".nameWithOwner",
        ])
        .output()
        .context("gh repo viewを起動できませんでした")?;
    ensure_success(&output, "repository取得")?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn git(args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .args(args)
        .output()
        .context("gitを起動できませんでした")?;
    ensure_success(&output, "git")?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn ensure_success(output: &Output, action: &str) -> Result<()> {
    if output.status.success() {
        Ok(())
    } else {
        bail!(
            "{action}に失敗しました: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
    }
}

fn issue_number_from_branch(branch: &str) -> Option<u64> {
    let pattern = Regex::new(r"^[^/]+/(\d+)(?:-|$)").expect("branch issue pattern is valid");
    pattern
        .captures(branch)
        .and_then(|captures| captures.get(1))
        .and_then(|number| number.as_str().parse().ok())
}

fn issue_purpose(body: &str) -> Option<String> {
    section(body, &["目的", "ゴール", "Goal"])
        .or_else(|| section(body, &["背景", "Background"]))
        .and_then(|section| first_paragraph(&section))
}

fn completion_items(body: &str) -> Vec<ChecklistItem> {
    let source = section(
        body,
        &["完了条件", "受け入れ条件", "Acceptance Criteria", "Done"],
    )
    .unwrap_or_else(|| body.to_owned());
    source
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            let (checked, text) = if let Some(text) = trimmed.strip_prefix("- [ ] ") {
                (false, text)
            } else if let Some(text) = trimmed
                .strip_prefix("- [x] ")
                .or_else(|| trimmed.strip_prefix("- [X] "))
            {
                (true, text)
            } else {
                return None;
            };
            Some(ChecklistItem {
                text: text.trim().to_owned(),
                checked,
            })
        })
        .collect()
}

fn section(body: &str, names: &[&str]) -> Option<String> {
    let lines: Vec<&str> = body.lines().collect();
    let start = lines.iter().position(|line| {
        let heading = line.trim().trim_start_matches('#').trim();
        line.trim_start().starts_with('#') && names.contains(&heading)
    })?;
    let end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, line)| line.trim_start().starts_with('#'))
        .map_or(lines.len(), |(index, _)| index);
    Some(lines[start + 1..end].join("\n"))
}

fn first_paragraph(section: &str) -> Option<String> {
    let paragraph = section
        .split("\n\n")
        .map(str::trim)
        .find(|paragraph| !paragraph.is_empty())?;
    Some(paragraph.lines().collect::<Vec<_>>().join(" "))
}

fn summarize_checks(checks: &[Value]) -> CheckSummary {
    let mut summary = CheckSummary {
        total: checks.len(),
        ..CheckSummary::default()
    };
    for check in checks {
        let state = ["conclusion", "state", "status"]
            .into_iter()
            .find_map(|key| {
                check
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
            })
            .unwrap_or("UNKNOWN")
            .to_ascii_uppercase();
        if matches!(
            state.as_str(),
            "FAILURE" | "ERROR" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED"
        ) {
            summary.failure += 1;
        } else if matches!(
            state.as_str(),
            "PENDING" | "EXPECTED" | "QUEUED" | "IN_PROGRESS" | "REQUESTED" | "WAITING"
        ) {
            summary.pending += 1;
        } else {
            summary.success += 1;
        }
    }
    summary
}

fn recommend(facts: &RecommendationFacts<'_>) -> Vec<NextAction> {
    if facts.worktree.conflicted > 0 {
        return vec![action(
            "resolve-conflicts",
            "コンフリクトを解消する",
            format!("競合中のファイルが{}件ある", facts.worktree.conflicted),
            Some("git status".into()),
        )];
    }
    if facts.protected && !facts.worktree.clean {
        return vec![action(
            "leave-protected-branch",
            "Issueに紐づくbranchへ変更を移す",
            format!("保護branch `{}` に未commit変更がある", facts.branch),
            Some("git ar branch".into()),
        )];
    }
    if let Some(issue) = facts.issue {
        let open_blockers: Vec<_> = issue
            .blocked_by
            .iter()
            .filter(|blocker| blocker.state == "OPEN")
            .collect();
        if !open_blockers.is_empty() || issue.labels.iter().any(|label| label == "status/blocked") {
            let blockers = open_blockers
                .iter()
                .map(|blocker| format!("#{} {}", blocker.number, blocker.title))
                .collect::<Vec<_>>()
                .join(", ");
            return vec![action(
                "wait-for-blocker",
                "ブロック理由を確認する",
                if blockers.is_empty() {
                    "Issueにstatus/blockedが付いている".into()
                } else {
                    format!("未完了のblocked-by: {blockers}")
                },
                Some(format!("gh issue view {} --web", issue.number)),
            )];
        }
        if issue.state != "OPEN" {
            if let Some(item) = issue.completion_items.iter().find(|item| !item.checked) {
                return vec![action(
                    "audit-closed-issue",
                    "閉じたIssueの完了条件を監査する",
                    format!(
                        "Issue #{}は{}だが未確認の完了条件がある: {}",
                        issue.number, issue.state, item.text
                    ),
                    Some(format!("gh issue view {} --web", issue.number)),
                )];
            }
            return vec![action(
                "select-open-task",
                "次のopen Issueを選ぶ",
                format!("Issue #{}は{}である", issue.number, issue.state),
                Some("git ar tasks".into()),
            )];
        }
    }
    if facts.worktree.unstaged > 0 || facts.worktree.untracked > 0 {
        return vec![action(
            "review-local-changes",
            "変更ファイルを確認して必要なものだけstageする",
            format!(
                "未stageが{}件、未追跡が{}件ある",
                facts.worktree.unstaged, facts.worktree.untracked
            ),
            Some("git status --short".into()),
        )];
    }
    if facts.worktree.staged > 0 {
        return vec![
            action(
                "run-quick-check",
                "短い検査を実行する",
                format!("stage済みファイルが{}件ある", facts.worktree.staged),
                Some("git ar check --quick".into()),
            ),
            action(
                "commit-staged-changes",
                "検査後にcommitする",
                "commitはgit arの入口を使う".into(),
                Some("git ar commit".into()),
            ),
        ];
    }
    if facts.upstream.behind > 0 {
        return vec![action(
            "pull-upstream",
            "remoteの変更を取り込む",
            format!("upstreamより{} commit遅れている", facts.upstream.behind),
            Some("git pull --ff-only".into()),
        )];
    }
    if facts.upstream.ahead > 0 {
        return vec![action(
            "push-commits",
            "commitをpushする",
            format!("upstreamより{} commit進んでいる", facts.upstream.ahead),
            Some("git ar push".into()),
        )];
    }
    if let Some(pull_request) = facts.pull_request {
        if pull_request.state != "OPEN" {
            return vec![action(
                "select-open-task",
                "次のopen Issueを選ぶ",
                format!("PR #{}は{}である", pull_request.number, pull_request.state),
                Some("git ar tasks".into()),
            )];
        }
        if pull_request.merge_state == "DIRTY" {
            return vec![action(
                "update-branch",
                "base branchを取り込んで競合を解消する",
                format!("PR #{}は競合している", pull_request.number),
                Some("gh pr update-branch".into()),
            )];
        }
        if pull_request.merge_state == "BEHIND" {
            return vec![action(
                "update-branch",
                "PR branchをbase branchへ追従させる",
                format!("PR #{}はbase branchより遅れている", pull_request.number),
                Some("gh pr update-branch".into()),
            )];
        }
        if pull_request.checks.failure > 0 {
            return vec![action(
                "fix-checks",
                "失敗したcheckを修正する",
                format!("PR checkが{}件失敗している", pull_request.checks.failure),
                Some("gh pr checks".into()),
            )];
        }
        if pull_request.review_decision == "CHANGES_REQUESTED" {
            return vec![action(
                "address-review",
                "レビュー指摘へ対応する",
                format!("PR #{}に修正依頼がある", pull_request.number),
                Some("gh pr view --comments".into()),
            )];
        }
        if pull_request.checks.pending > 0 {
            return vec![action(
                "wait-for-checks",
                "checkの完了を待つ",
                format!("PR checkが{}件実行中である", pull_request.checks.pending),
                Some("gh pr checks --watch".into()),
            )];
        }
        let issue_requires_review = facts
            .issue
            .is_some_and(|issue| issue.labels.iter().any(|label| label == "merge/review"));
        if pull_request.review_decision == "REVIEW_REQUIRED"
            || (issue_requires_review && pull_request.review_decision != "APPROVED")
        {
            return vec![action(
                "wait-for-review",
                "レビューを依頼または待機する",
                format!("PR #{}は承認待ちである", pull_request.number),
                Some(format!("gh pr view {} --web", pull_request.number)),
            )];
        }
        if pull_request.is_draft {
            return vec![action(
                "mark-pr-ready",
                "PRをレビュー可能にする",
                format!("PR #{}はDraftである", pull_request.number),
                Some("gh pr ready".into()),
            )];
        }
        if pull_request.merge_state == "BLOCKED" {
            return vec![action(
                "inspect-merge-requirements",
                "未達のマージ条件を確認する",
                format!("PR #{}はGitHub上でBLOCKEDである", pull_request.number),
                Some(format!("gh pr view {} --web", pull_request.number)),
            )];
        }
        return vec![action(
            "merge-pr",
            "PRの条件を確認してマージする",
            format!(
                "PR #{}のcheckとレビュー条件を満たしている",
                pull_request.number
            ),
            Some("gh pr merge --squash".into()),
        )];
    }
    if facts.upstream.commits_ahead_of_base > 0 {
        return vec![action(
            "create-pr",
            "PRを作成する",
            format!(
                "{}より{} commit進んでいるが、対応するPRがない",
                facts
                    .upstream
                    .base_branch
                    .as_deref()
                    .unwrap_or("default branch"),
                facts.upstream.commits_ahead_of_base
            ),
            Some("git ar pr --create".into()),
        )];
    }
    if facts.upstream.configured
        && let Some(issue) = facts.issue
    {
        return vec![action(
            "implement-next-condition",
            "Issueの未完了条件に着手する",
            next_condition_reason(issue),
            Some(format!("gh issue view {} --web", issue.number)),
        )];
    }
    if facts.protected {
        return vec![action(
            "select-task",
            "担当Issueを選ぶ",
            "現在は保護branchにいて、紐づくIssueがない".into(),
            Some("git ar tasks".into()),
        )];
    }
    vec![action(
        "attach-issue",
        "branchに対応するIssueを確認する",
        "branch名からIssue番号を判定できない".into(),
        Some("git ar status --issue <Issue番号>".into()),
    )]
}

fn next_condition_reason(issue: &IssueStatus) -> String {
    if let Some(item) = issue.completion_items.iter().find(|item| !item.checked) {
        format!("Issue #{}の未完了条件: {}", issue.number, item.text)
    } else if let Some(purpose) = &issue.purpose {
        format!("Issue #{}の目的: {purpose}", issue.number)
    } else {
        format!("Issue #{}の本文を確認して作業を開始する", issue.number)
    }
}

fn action(
    id: &'static str,
    title: impl Into<String>,
    reason: String,
    command: Option<String>,
) -> NextAction {
    NextAction {
        id,
        title: title.into(),
        reason,
        command,
    }
}

fn is_conflict_state(state: &str) -> bool {
    matches!(state, "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU")
}

fn print_human(report: &StatusReport) {
    println!("現在地");
    println!("  repository: {}", report.repository);
    println!("  branch: {} ({})", report.branch, report.head);
    if let Some(issue) = &report.issue {
        println!("  Issue: #{} {}", issue.number, issue.title);
        if let Some(purpose) = &issue.purpose {
            println!("  目的: {purpose}");
        }
        if !issue.completion_items.is_empty() {
            let done = issue
                .completion_items
                .iter()
                .filter(|item| item.checked)
                .count();
            println!(
                "  完了条件: {done}/{}（{}）",
                issue.completion_items.len(),
                issue
                    .completion_items
                    .iter()
                    .find(|item| !item.checked)
                    .map_or("すべて完了", |item| item.text.as_str())
            );
        }
    } else {
        println!("  Issue: branch名から判定できません");
    }
    if let Some(pull_request) = &report.pull_request {
        println!(
            "  PR: #{} {}（check: 成功{} / 実行中{} / 失敗{}）",
            pull_request.number,
            pull_request.state,
            pull_request.checks.success,
            pull_request.checks.pending,
            pull_request.checks.failure
        );
    } else {
        println!("  PR: なし");
    }
    println!(
        "  変更: stage済み{} / 未stage{} / 未追跡{} / 競合{}",
        report.worktree.staged,
        report.worktree.unstaged,
        report.worktree.untracked,
        report.worktree.conflicted
    );
    if report.upstream.configured {
        println!(
            "  upstream: ahead {} / behind {}",
            report.upstream.ahead, report.upstream.behind
        );
    } else {
        println!("  upstream: 未設定");
    }
    if let Some(base) = &report.upstream.base_branch {
        println!(
            "  base: {base}より{} commit進行",
            report.upstream.commits_ahead_of_base
        );
    }

    println!("\n次にやること");
    for (index, action) in report.next_actions.iter().enumerate() {
        println!("  {}. {}", index + 1, action.title);
        println!("     理由: {}", action.reason);
        if let Some(command) = &action.command {
            println!("     実行: {command}");
        }
    }
    for warning in &report.warnings {
        eprintln!("arttra: 警告: {warning}");
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ChecklistItem, IssueStatus, RecommendationFacts, UpstreamStatus, WorktreeStatus,
        completion_items, issue_number_from_branch, issue_purpose, parse_worktree, recommend,
        summarize_checks,
    };
    use serde_json::Value;

    #[test]
    fn reads_issue_number_from_policy_branch() {
        assert_eq!(
            issue_number_from_branch("feature/123-status-guidance-roz"),
            Some(123)
        );
        assert_eq!(issue_number_from_branch("main"), None);
        assert_eq!(issue_number_from_branch("feature/no-issue"), None);
    }

    #[test]
    fn extracts_purpose_and_completion_items() {
        let body = "## 背景\n\n背景。\n\n## 目的\n\n次にやることを表示する。\n\n## 完了条件\n\n- [x] Issueを読む\n- [ ] 次の行動を返す\n";
        assert_eq!(
            issue_purpose(body).as_deref(),
            Some("次にやることを表示する。")
        );
        assert_eq!(
            completion_items(body),
            vec![
                ChecklistItem {
                    text: "Issueを読む".into(),
                    checked: true,
                },
                ChecklistItem {
                    text: "次の行動を返す".into(),
                    checked: false,
                },
            ]
        );
    }

    #[test]
    fn preserves_leading_porcelain_status_column() {
        let worktree = parse_worktree(" M src/main.rs\n?? src/status.rs\n");
        assert_eq!(worktree.staged, 0);
        assert_eq!(worktree.unstaged, 1);
        assert_eq!(worktree.untracked, 1);
        assert_eq!(worktree.files[0].path, "src/main.rs");
        assert_eq!(worktree.files[0].state, " M");
    }

    #[test]
    fn running_check_with_empty_conclusion_is_pending() {
        let checks = vec![
            serde_json::json!({"conclusion": "", "status": "IN_PROGRESS"}),
            serde_json::json!({"conclusion": "SUCCESS", "status": "COMPLETED"}),
        ];
        let summary = summarize_checks(&checks);
        assert_eq!(summary.total, 2);
        assert_eq!(summary.success, 1);
        assert_eq!(summary.pending, 1);
        assert_eq!(summary.failure, 0);
    }

    #[test]
    fn conflict_is_the_first_action() {
        let worktree = WorktreeStatus {
            clean: false,
            conflicted: 1,
            ..WorktreeStatus::default()
        };
        let upstream = UpstreamStatus::default();
        let actions = recommend(&RecommendationFacts {
            branch: "feature/1-test-roz",
            protected: false,
            issue: None,
            pull_request: None,
            worktree: &worktree,
            upstream: &upstream,
        });
        assert_eq!(actions[0].id, "resolve-conflicts");
    }

    #[test]
    fn clean_issue_branch_points_to_unchecked_condition() {
        let issue = IssueStatus {
            number: 1,
            title: "Status".into(),
            url: "https://example.test/1".into(),
            state: "OPEN".into(),
            body: String::new(),
            purpose: Some("現在地を示す".into()),
            completion_items: vec![ChecklistItem {
                text: "JSONを返す".into(),
                checked: false,
            }],
            labels: Vec::new(),
            assignees: Vec::new(),
            blocked_by: Vec::new(),
            blocking: Vec::new(),
            parent: None,
            sub_issues: Vec::new(),
            milestone: None,
            project_items: Value::Array(Vec::new()),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        let worktree = WorktreeStatus {
            clean: true,
            ..WorktreeStatus::default()
        };
        let upstream = UpstreamStatus {
            configured: true,
            ..UpstreamStatus::default()
        };
        let actions = recommend(&RecommendationFacts {
            branch: "feature/1-status-roz",
            protected: false,
            issue: Some(&issue),
            pull_request: None,
            worktree: &worktree,
            upstream: &upstream,
        });
        assert_eq!(actions[0].id, "implement-next-condition");
        assert!(actions[0].reason.contains("JSONを返す"));
    }

    #[test]
    fn closed_issue_with_unchecked_condition_requires_audit() {
        let issue = IssueStatus {
            number: 2,
            title: "Closed".into(),
            url: "https://example.test/2".into(),
            state: "CLOSED".into(),
            body: String::new(),
            purpose: None,
            completion_items: vec![ChecklistItem {
                text: "本番確認".into(),
                checked: false,
            }],
            labels: Vec::new(),
            assignees: Vec::new(),
            blocked_by: Vec::new(),
            blocking: Vec::new(),
            parent: None,
            sub_issues: Vec::new(),
            milestone: None,
            project_items: Value::Array(Vec::new()),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        let worktree = WorktreeStatus {
            clean: true,
            ..WorktreeStatus::default()
        };
        let upstream = UpstreamStatus {
            configured: true,
            ..UpstreamStatus::default()
        };
        let actions = recommend(&RecommendationFacts {
            branch: "feature/2-closed-roz",
            protected: false,
            issue: Some(&issue),
            pull_request: None,
            worktree: &worktree,
            upstream: &upstream,
        });
        assert_eq!(actions[0].id, "audit-closed-issue");
        assert!(actions[0].reason.contains("本番確認"));
    }
}
