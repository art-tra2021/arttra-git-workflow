use std::process::{Command, Output};

use anyhow::{Context, Result, bail};
use regex::Regex;
use serde::Serialize;

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
    pub issue: Option<u64>,
    pub title: String,
    pub body: String,
    pub draft: bool,
    pub reviewers: Vec<String>,
    pub commits_ahead_of_base: Option<u64>,
    pub uncommitted_files: usize,
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
    let issue = issue.or_else(|| issue_number_from_branch(&branch));
    let base = non_blank(
        base.unwrap_or_else(|| default_base(policy)),
        "PRの作成先branch",
    )?;
    let title = match title {
        Some(title) => non_blank(title, "PRタイトル")?,
        None => suggested_pull_request_title(issue)?,
    };
    let body = match body {
        Some(body) => non_blank(body, "PR本文")?,
        None => default_pull_request_body(&title, issue),
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

fn default_pull_request_body(title: &str, issue: Option<u64>) -> String {
    let relation = issue
        .map(|number| format!("Closes #{number}"))
        .unwrap_or_else(|| "関連Issueなし".into());
    format!(
        "## 変更内容\n\n{title}\n\n## 関連Issue\n\n{relation}\n\n## 確認方法\n\n- `mise run verify`\n"
    )
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
    use super::{default_pull_request_body, issue_number_from_branch};

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
    fn pull_request_body_closes_related_issue() {
        let body = default_pull_request_body("TUIを改善する", Some(71));
        assert!(body.contains("Closes #71"));
        assert!(body.contains("mise run verify"));
    }
}
