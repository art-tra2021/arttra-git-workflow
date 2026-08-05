use std::process::{Command, Output};

use anyhow::{Context, Result, bail};
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::branch;
use crate::policy::BranchPolicy;

#[derive(Debug, Serialize)]
pub struct PushPlan {
    pub schema_version: u32,
    pub branch: String,
    pub remote: String,
    pub upstream: Option<String>,
    pub commits_to_push: Option<u64>,
    pub uncommitted_files: usize,
    pub command: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct PullRequestDraft {
    pub schema_version: u32,
    pub branch: String,
    pub base: String,
    /// The single type/task Issue closed by this Pull Request.
    pub issue: u64,
    pub issue_kind: &'static str,
    pub merge_mode: String,
    pub parent_issue_url: String,
    pub title: String,
    pub body: String,
    pub draft: bool,
    pub reviewers: Vec<String>,
    pub commits_ahead_of_base: Option<u64>,
    pub uncommitted_files: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitHubIssueMetadata {
    pub number: u64,
    pub title: String,
    pub kind: String,
    pub url: String,
    pub state: String,
    pub merge_mode: Option<String>,
    pub parent: Option<GitHubIssueParent>,
    pub sub_issues: Vec<GitHubIssueChild>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GitHubIssueParent {
    pub number: u64,
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GitHubIssueChild {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub url: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawGitHubIssueConnection {
    #[serde(default)]
    nodes: Vec<GitHubIssueChild>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawGitHubIssueMetadata {
    number: u64,
    title: String,
    url: String,
    state: String,
    labels: Vec<RawGitHubLabel>,
    parent: Option<GitHubIssueParent>,
    sub_issues: RawGitHubIssueConnection,
}

#[derive(Debug, Deserialize)]
struct RawGitHubLabel {
    name: String,
}

pub fn build_push_plan(policy: &BranchPolicy, remote: Option<&str>) -> Result<PushPlan> {
    let branch = branch::current_branch()?;
    ensure_work_branch(&branch, policy)?;

    let remote_was_explicit = remote.is_some();
    let remote = remote.unwrap_or("origin").trim();
    if remote.is_empty() {
        bail!("push先が空です。例: `git ar push --remote origin`");
    }
    git(&["remote", "get-url", remote])
        .with_context(|| format!("remote `{remote}` が見つかりません"))?;

    let upstream = git_optional(&[
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
    ]);
    let target_ref = if remote_was_explicit {
        let candidate = format!("refs/remotes/{remote}/{branch}");
        git_optional(&["rev-parse", "--verify", &candidate]).map(|_| candidate)
    } else {
        upstream.as_ref().map(|_| "@{upstream}".into())
    };
    let commits_to_push = target_ref.as_ref().and_then(|target| {
        let range = format!("{target}..HEAD");
        git_optional(&["rev-list", "--count", &range]).and_then(|value| value.parse().ok())
    });
    let command = match (&upstream, remote_was_explicit) {
        (Some(_), false) => vec!["git".into(), "push".into()],
        (Some(_), true) => vec!["git".into(), "push".into(), remote.into(), branch.clone()],
        (None, _) => vec![
            "git".into(),
            "push".into(),
            "--set-upstream".into(),
            remote.into(),
            branch.clone(),
        ],
    };

    Ok(PushPlan {
        schema_version: 1,
        branch,
        remote: remote.into(),
        upstream,
        commits_to_push,
        uncommitted_files: uncommitted_file_count()?,
        command,
    })
}

pub fn execute_push(plan: &PushPlan) -> Result<()> {
    if plan.commits_to_push == Some(0) {
        if plan.uncommitted_files > 0 {
            bail!(
                "pushするcommitがありません。未commitの変更が{}件あるため、先に `git ar commit` を実行してください",
                plan.uncommitted_files
            );
        }
        bail!("pushする新しいcommitがありません");
    }
    let mut command = Command::new(&plan.command[0]);
    command.args(&plan.command[1..]);
    let output = command.output().context("git pushを起動できませんでした")?;
    ensure_success(&output, "push")?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn build_pull_request_draft(
    policy: &BranchPolicy,
    title: Option<String>,
    body: Option<String>,
    issue: Option<u64>,
    base: Option<String>,
    draft: bool,
    reviewers: Vec<String>,
) -> Result<PullRequestDraft> {
    let branch = branch::current_branch()?;
    ensure_work_branch(&branch, policy)?;
    let issue = issue
        .or_else(|| issue_number_from_branch(&branch))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "Pull Requestが閉じるTaskが必要です。`--issue <type/taskのIssue番号>`を指定してください"
            )
        })?;
    require_matching_branch_issue(&branch, issue)?;
    let issue_metadata = github_issue_metadata(&issue.to_string())?;
    require_issue_kind(&issue_metadata, &["task"], "Pull Requestの対象")?;
    let merge_mode = issue_metadata.merge_mode.clone().ok_or_else(|| {
        anyhow::anyhow!(
            "Task #{issue}にはmerge/review, merge/self, merge/emergencyのどれか一つが必要です"
        )
    })?;
    let parent = issue_metadata.parent.as_ref().ok_or_else(|| {
        anyhow::anyhow!(
            "Task #{issue}には親WorkまたはBusinessが必要です。GitHubのnative parentを設定してください"
        )
    })?;
    let parent_metadata = github_issue_metadata(&parent.url)?;
    require_issue_kind(&parent_metadata, &["work", "business"], "Taskの親")?;
    require_no_merge_mode(&parent_metadata, "Taskの親")?;
    let base = non_blank(
        base.unwrap_or_else(|| default_base(policy)),
        "PRの作成先branch",
    )?;
    let title = match title {
        Some(title) => non_blank(title, "PRタイトル")?,
        None => non_blank(issue_metadata.title.clone(), "Taskタイトル")?,
    };
    let body = match body {
        Some(body) => {
            let body = non_blank(body, "PR本文")?;
            validate_pull_request_closing_task(&body, issue, &parent.url)?;
            body
        }
        None => default_pull_request_body(&title, issue, &parent.url),
    };
    let reviewers = reviewers
        .into_iter()
        .map(|reviewer| non_blank(reviewer, "reviewer"))
        .collect::<Result<Vec<_>>>()?;
    let commits_ahead_of_base = {
        let range = format!("{base}..HEAD");
        git_optional(&["rev-list", "--count", &range]).and_then(|value| value.parse().ok())
    };

    Ok(PullRequestDraft {
        schema_version: 1,
        branch,
        base,
        issue,
        issue_kind: "task",
        merge_mode,
        parent_issue_url: parent.url.clone(),
        title,
        body,
        draft,
        reviewers,
        commits_ahead_of_base,
        uncommitted_files: uncommitted_file_count()?,
    })
}

pub fn create_pull_request(draft: &PullRequestDraft) -> Result<String> {
    if draft.commits_ahead_of_base == Some(0) {
        bail!(
            "Pull Requestに含めるcommitがありません。先に `git ar commit` と `git ar push` を実行してください"
        );
    }
    if git_optional(&[
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
    ])
    .is_none()
    {
        bail!("branchがまだpushされていません。先に `git ar push` を実行してください");
    }

    if let Some(url) = existing_pull_request_url()? {
        bail!("このbranchには既にPull Requestがあります: {url}");
    }

    let mut command = Command::new("gh");
    command.args([
        "pr",
        "create",
        "--title",
        &draft.title,
        "--body",
        &draft.body,
        "--base",
        &draft.base,
        "--head",
        &draft.branch,
    ]);
    if draft.draft {
        command.arg("--draft");
    }
    for reviewer in &draft.reviewers {
        command.args(["--reviewer", reviewer]);
    }

    let output = command
        .output()
        .context("gh pr createを起動できませんでした")?;
    ensure_success(&output, "Pull Request作成")?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

pub fn issue_number_from_branch(branch: &str) -> Option<u64> {
    let (_, suffix) = branch.split_once('/')?;
    suffix.split('-').next()?.parse().ok()
}

fn require_matching_branch_issue(branch: &str, issue: u64) -> Result<()> {
    let branch_issue = issue_number_from_branch(branch).ok_or_else(|| {
        anyhow::anyhow!("branch名からTask番号を判定できません。`git ar branch`でTaskに紐づくbranchを作成してください")
    })?;
    if issue != branch_issue {
        bail!(
            "branchはTask #{branch_issue}に紐づいていますが、PRはTask #{issue}を指定しています。`--issue {branch_issue}`を指定してください"
        );
    }
    Ok(())
}

pub fn suggested_pull_request_title(issue: Option<u64>) -> Result<String> {
    if let Some(issue) = issue
        && let Some(title) = gh_optional(&[
            "issue",
            "view",
            &issue.to_string(),
            "--json",
            "title",
            "--jq",
            ".title",
        ])
    {
        return non_blank(title, "Issueタイトル");
    }

    let subject = git(&["log", "-1", "--pretty=%s"])?;
    let conventional_prefix =
        Regex::new(r"^[a-z]+(?:\([^)]+\))?!?:\s+").expect("commit prefix pattern is valid");
    non_blank(
        conventional_prefix.replace(&subject, "").into_owned(),
        "最新commitのタイトル",
    )
}

fn ensure_work_branch(branch: &str, policy: &BranchPolicy) -> Result<()> {
    if policy
        .protected_branches
        .iter()
        .any(|protected| protected == branch)
    {
        bail!(
            "保護branch `{branch}` からは実行できません。先に `git ar branch` で作業branchを作ってください"
        );
    }
    let validation = branch::validate(branch, policy);
    if validation.valid {
        return Ok(());
    }
    let message = validation
        .message_ja
        .as_deref()
        .unwrap_or("branch名が規則に一致しません");
    let fix = validation.fix_command.as_deref().unwrap_or("git ar branch");
    bail!("{message}\n次を実行してください: {fix}")
}

fn default_base(policy: &BranchPolicy) -> String {
    policy
        .protected_branches
        .first()
        .cloned()
        .unwrap_or_else(|| "main".into())
}

fn default_pull_request_body(title: &str, issue: u64, parent_url: &str) -> String {
    format!(
        "## 変更内容\n\n{title}\n\n## Closing Task\n\nCloses #{issue}\n\n## 親Issue\n\nRelates to {parent_url}\n\n## 確認方法\n\n- `mise run verify`\n"
    )
}

pub fn normalize_issue_reference(reference: &str) -> Result<String> {
    let reference = reference.trim();
    if reference.parse::<u64>().is_ok_and(|number| number > 0) {
        return Ok(reference.to_owned());
    }
    let shorthand = Regex::new(r"^([^/\s]+/[^/#\s]+)#([1-9][0-9]*)$")
        .expect("Issue shorthand pattern is valid");
    if let Some(captures) = shorthand.captures(reference) {
        return Ok(format!(
            "https://github.com/{}/issues/{}",
            &captures[1], &captures[2]
        ));
    }
    let url = Regex::new(r"^https://github\.com/[^/\s]+/[^/\s]+/issues/[1-9][0-9]*/?$")
        .expect("GitHub Issue URL pattern is valid");
    if url.is_match(reference) {
        return Ok(reference.trim_end_matches('/').to_owned());
    }
    bail!(
        "Issue参照は番号、owner/repo#番号、またはGitHub Issue URLで指定してください（現在: `{reference}`）"
    )
}

pub fn github_issue_metadata(reference: &str) -> Result<GitHubIssueMetadata> {
    let issue = normalize_issue_reference(reference)?;
    let output = Command::new("gh")
        .args([
            "issue",
            "view",
            &issue,
            "--json",
            "number,title,url,state,labels,parent,subIssues",
        ])
        .output()
        .with_context(|| format!("Issue `{reference}`を確認できませんでした"))?;
    ensure_success(&output, &format!("Issue `{reference}`の確認"))?;
    let raw: RawGitHubIssueMetadata = serde_json::from_slice(&output.stdout)
        .with_context(|| format!("Issue `{reference}`の情報を解釈できませんでした"))?;
    let kinds = raw
        .labels
        .iter()
        .filter_map(|label| label.name.strip_prefix("type/"))
        .collect::<Vec<_>>();
    if kinds.len() != 1 {
        bail!(
            "Issue #{}にはtypeラベルがちょうど1件必要です（現在: {}）",
            raw.number,
            if kinds.is_empty() {
                "なし".into()
            } else {
                kinds.join(", ")
            }
        );
    }
    let merge_modes = raw
        .labels
        .iter()
        .filter_map(|label| label.name.strip_prefix("merge/"))
        .collect::<Vec<_>>();
    let merge_mode = match merge_modes.as_slice() {
        [] => None,
        [mode] if matches!(*mode, "review" | "self" | "emergency") => Some(format!("merge/{mode}")),
        _ => bail!(
            "Issue #{}にはmerge/review, merge/self, merge/emergencyのどれか一つだけが必要です（現在: {}）",
            raw.number,
            if merge_modes.is_empty() {
                "なし".into()
            } else {
                merge_modes
                    .iter()
                    .map(|mode| format!("merge/{mode}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        ),
    };
    Ok(GitHubIssueMetadata {
        number: raw.number,
        title: raw.title,
        kind: kinds[0].to_owned(),
        url: raw.url,
        state: raw.state,
        merge_mode,
        parent: raw.parent,
        sub_issues: raw.sub_issues.nodes,
    })
}

pub fn require_issue_kind(issue: &GitHubIssueMetadata, allowed: &[&str], role: &str) -> Result<()> {
    if allowed.iter().any(|kind| *kind == issue.kind) {
        return Ok(());
    }
    bail!(
        "{role}のIssue #{}はtype/{}です。type/{}を指定してください",
        issue.number,
        issue.kind,
        allowed.join("またはtype/")
    )
}

pub fn require_no_merge_mode(issue: &GitHubIssueMetadata, role: &str) -> Result<()> {
    if let Some(mode) = &issue.merge_mode {
        bail!(
            "{role}のIssue #{}はtype/{}なので{mode}を持てません。merge方針はtype/taskだけに設定してください",
            issue.number,
            issue.kind
        );
    }
    Ok(())
}

fn validate_pull_request_closing_task(
    body: &str,
    expected_issue: u64,
    parent_url: &str,
) -> Result<()> {
    let closing_pattern =
        Regex::new(r"(?im)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([1-9][0-9]*)\b")
            .expect("closing Issue pattern is valid");
    let closing_issues = closing_pattern
        .captures_iter(body)
        .filter_map(|captures| captures[1].parse::<u64>().ok())
        .collect::<Vec<_>>();
    if closing_issues != [expected_issue] {
        bail!(
            "PR本文は対応するTaskだけを`Closes #{expected_issue}`で閉じる必要があります（検出: {}）",
            if closing_issues.is_empty() {
                "なし".into()
            } else {
                closing_issues
                    .iter()
                    .map(|number| format!("#{number}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        );
    }
    let exact_closes = Regex::new(&format!(r"(?im)\bCloses\s+#{expected_issue}\b"))
        .expect("exact Closes pattern is valid");
    if !exact_closes.is_match(body) {
        bail!("PR本文では`Closes #{expected_issue}`を使用してください");
    }
    let expected_relation = format!("Relates to {parent_url}");
    if !body.lines().any(|line| line.trim() == expected_relation) {
        bail!("PR本文にはTaskの実際の親を`{expected_relation}`として1件記載してください");
    }
    Ok(())
}

fn existing_pull_request_url() -> Result<Option<String>> {
    let output = Command::new("gh")
        .args(["pr", "view", "--json", "url", "--jq", ".url"])
        .output()
        .context("既存Pull Requestを確認できませんでした")?;
    if output.status.success() {
        return Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        ));
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    if detail.contains("no pull requests found")
        || detail.contains("Could not resolve to a PullRequest")
    {
        Ok(None)
    } else {
        bail!("既存Pull Requestの確認に失敗しました: {}", detail.trim())
    }
}

fn non_blank(value: String, label: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        bail!("{label}は空にできません");
    }
    Ok(value.into())
}

fn git(args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .args(args)
        .output()
        .context("gitを起動できませんでした")?;
    ensure_success(&output, "Git情報の取得")?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn uncommitted_file_count() -> Result<usize> {
    Ok(git(&["status", "--porcelain=v1"])?
        .lines()
        .filter(|line| !line.is_empty())
        .count())
}

fn git_optional(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn gh_optional(args: &[&str]) -> Option<String> {
    let output = Command::new("gh").args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn ensure_success(output: &Output, action: &str) -> Result<()> {
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr);
        bail!("{action}に失敗しました: {}", detail.trim())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        GitHubIssueMetadata, default_pull_request_body, issue_number_from_branch,
        normalize_issue_reference, require_issue_kind, require_matching_branch_issue,
        require_no_merge_mode, validate_pull_request_closing_task,
    };

    #[test]
    fn reads_issue_number_from_compliant_branch() {
        assert_eq!(
            issue_number_from_branch("feature/71-tui-home-rozwer"),
            Some(71)
        );
        assert_eq!(issue_number_from_branch("main"), None);
        assert_eq!(issue_number_from_branch("feature/not-an-issue"), None);
    }

    #[test]
    fn pull_request_task_matches_branch_task() {
        assert!(require_matching_branch_issue("fix/89-task-roz", 89).is_ok());
        assert!(require_matching_branch_issue("fix/89-task-roz", 90).is_err());
        assert!(require_matching_branch_issue("main", 89).is_err());
    }

    #[test]
    fn pull_request_body_closes_related_issue() {
        let body = default_pull_request_body(
            "TUIを改善する",
            71,
            "https://github.com/art-tra2021/example/issues/70",
        );
        assert!(body.contains("Closes #71"));
        assert!(body.contains("Relates to https://github.com/art-tra2021/example/issues/70"));
        assert!(body.contains("mise run verify"));
    }

    #[test]
    fn pull_request_body_closes_exactly_one_expected_task() {
        let parent = "https://github.com/art-tra2021/example/issues/70";
        let valid = format!("Closes #71\nRelates to {parent}");
        assert!(validate_pull_request_closing_task(&valid, 71, parent).is_ok());
        assert!(validate_pull_request_closing_task("Closes #71", 71, parent).is_err());
        assert!(validate_pull_request_closing_task("Fixes #71", 71, parent).is_err());
        assert!(validate_pull_request_closing_task("Closes #72", 71, parent).is_err());
        assert!(validate_pull_request_closing_task("Closes #71\nCloses #72", 71, parent).is_err());
        assert!(validate_pull_request_closing_task("Relates to #71", 71, parent).is_err());
    }

    #[test]
    fn normalizes_cross_repository_issue_references() {
        assert_eq!(normalize_issue_reference("71").unwrap(), "71");
        assert_eq!(
            normalize_issue_reference("art-tra2021/project#7").unwrap(),
            "https://github.com/art-tra2021/project/issues/7"
        );
        assert_eq!(
            normalize_issue_reference("https://github.com/art-tra2021/project/issues/7/").unwrap(),
            "https://github.com/art-tra2021/project/issues/7"
        );
        assert!(normalize_issue_reference("project#7").is_err());
    }

    #[test]
    fn branch_and_pr_issue_kind_is_deterministic_after_github_lookup() {
        let task = GitHubIssueMetadata {
            number: 71,
            title: "Task".into(),
            kind: "task".into(),
            url: "https://github.com/example/repo/issues/71".into(),
            state: "OPEN".into(),
            merge_mode: Some("merge/review".into()),
            parent: None,
            sub_issues: Vec::new(),
        };
        let work = GitHubIssueMetadata {
            number: 72,
            title: "Work".into(),
            kind: "work".into(),
            url: "https://github.com/example/repo/issues/72".into(),
            state: "OPEN".into(),
            merge_mode: None,
            parent: None,
            sub_issues: Vec::new(),
        };
        assert!(require_issue_kind(&task, &["task"], "PRの対象").is_ok());
        assert!(require_issue_kind(&work, &["task"], "PRの対象").is_err());
        assert!(require_issue_kind(&work, &["work", "business"], "親").is_ok());
        assert!(require_no_merge_mode(&work, "親").is_ok());

        let stale_work = GitHubIssueMetadata {
            merge_mode: Some("merge/self".into()),
            ..work
        };
        assert!(require_no_merge_mode(&stale_work, "親").is_err());
    }
}
