use std::fmt;
use std::path::Path;
use std::process::{Command, Output};

use anyhow::{Context, Result, bail};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RevertCandidate {
    pub commit: String,
    pub short_commit: String,
    pub subject: String,
    pub author: String,
    pub committed_at: String,
}

impl fmt::Display for RevertCandidate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} {} — {}",
            self.short_commit, self.subject, self.committed_at
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RevertPlan {
    pub schema_version: u32,
    pub action: &'static str,
    pub target: RevertCandidate,
    pub worktree_clean: bool,
    pub command: Vec<String>,
}

pub fn candidates(limit: u8) -> Result<Vec<RevertCandidate>> {
    candidates_in(Path::new("."), limit)
}

fn candidates_in(root: &Path, limit: u8) -> Result<Vec<RevertCandidate>> {
    let output = Command::new("git")
        .args([
            "log",
            "--no-merges",
            "-z",
            "--format=%H%x00%h%x00%s%x00%an%x00%aI",
            "-n",
            &limit.to_string(),
        ])
        .current_dir(root)
        .output()
        .context("revert候補のcommit履歴を取得できませんでした")?;
    ensure_success(&output, "revert候補の取得")?;
    parse_log(&output.stdout)
}

pub fn build_plan(commit: &str) -> Result<RevertPlan> {
    build_plan_in(Path::new("."), commit)
}

fn build_plan_in(root: &Path, commit: &str) -> Result<RevertPlan> {
    let commit = resolve_commit_in(root, commit)?;
    ensure_on_current_history_in(root, &commit)?;
    ensure_not_merge_commit_in(root, &commit)?;
    let output = Command::new("git")
        .args([
            "log",
            "-1",
            "-z",
            "--format=%H%x00%h%x00%s%x00%an%x00%aI",
            &commit,
        ])
        .current_dir(root)
        .output()
        .context("revert対象のcommit情報を取得できませんでした")?;
    ensure_success(&output, "revert対象の取得")?;
    let target = parse_log(&output.stdout)?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("revert対象のcommit情報が空です"))?;
    Ok(RevertPlan {
        schema_version: 1,
        action: "revert",
        worktree_clean: worktree_is_clean_in(root)?,
        command: vec![
            "git".into(),
            "revert".into(),
            "--no-edit".into(),
            target.commit.clone(),
        ],
        target,
    })
}

pub fn execute(plan: &RevertPlan) -> Result<()> {
    execute_in(Path::new("."), plan)
}

fn execute_in(root: &Path, plan: &RevertPlan) -> Result<()> {
    if !worktree_is_clean_in(root)? {
        bail!(
            "未コミット変更があるためrevertを開始しません。先にcommitするか、branch作成時のstash移送を利用してください"
        );
    }
    let output = Command::new("git")
        .args(["revert", "--no-edit", &plan.target.commit])
        .current_dir(root)
        .output()
        .context("git revertを起動できませんでした")?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        if !revert_in_progress(root)? {
            bail!("打ち消しcommitを作成できませんでした: {detail}");
        }
        let abort = Command::new("git")
            .args(["revert", "--abort"])
            .current_dir(root)
            .output()
            .context("失敗したrevertの自動中止を起動できませんでした")?;
        if abort.status.success() {
            bail!("打ち消しcommitを作成できなかったためrevertを自動中止しました: {detail}");
        }
        bail!(
            "打ち消しcommitの作成と自動中止に失敗しました: {detail}\n`git revert --abort`で状態を確認してください"
        );
    }
    Ok(())
}

fn revert_in_progress(root: &Path) -> Result<bool> {
    let output = Command::new("git")
        .args(["rev-parse", "--quiet", "--verify", "REVERT_HEAD"])
        .current_dir(root)
        .output()
        .context("revertの進行状態を確認できませんでした")?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        code => bail!("revertの進行状態を確認できませんでした（終了コード: {code:?}）"),
    }
}

fn worktree_is_clean_in(root: &Path) -> Result<bool> {
    let output = Command::new("git")
        .args(["status", "--porcelain=v1"])
        .current_dir(root)
        .output()
        .context("revert前の変更状態を確認できませんでした")?;
    ensure_success(&output, "revert前の変更確認")?;
    Ok(output.stdout.is_empty())
}

fn resolve_commit_in(root: &Path, commit: &str) -> Result<String> {
    let requested = commit.trim();
    if requested.is_empty() {
        bail!("revert対象が空です。`--commit <SHA>`を指定してください");
    }
    let output = Command::new("git")
        .args([
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{requested}^{{commit}}"),
        ])
        .current_dir(root)
        .output()
        .context("revert対象をcommitとして解決できませんでした")?;
    ensure_success(&output, "revert対象の検証")?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn ensure_on_current_history_in(root: &Path, commit: &str) -> Result<()> {
    let status = Command::new("git")
        .args(["merge-base", "--is-ancestor", commit, "HEAD"])
        .current_dir(root)
        .status()
        .context("revert対象が現在の履歴に含まれるか確認できませんでした")?;
    match status.code() {
        Some(0) => Ok(()),
        Some(1) => bail!("指定したcommitは現在のbranchの履歴に含まれていません"),
        code => bail!("commit履歴の確認に失敗しました（終了コード: {code:?}）"),
    }
}

fn ensure_not_merge_commit_in(root: &Path, commit: &str) -> Result<()> {
    let output = Command::new("git")
        .args(["rev-list", "--parents", "-n", "1", commit])
        .current_dir(root)
        .output()
        .context("revert対象の親commitを確認できませんでした")?;
    ensure_success(&output, "revert対象の親commit確認")?;
    if String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .count()
        > 2
    {
        bail!("merge commitのrevertには親の選択が必要なため、現在のTUIでは扱いません");
    }
    Ok(())
}

fn parse_log(output: &[u8]) -> Result<Vec<RevertCandidate>> {
    let fields = output.split(|byte| *byte == 0).collect::<Vec<_>>();
    let fields = fields.strip_suffix(&[&[][..]]).unwrap_or(&fields);
    if fields.len() % 5 != 0 {
        bail!("git logから未知の形式を受け取りました");
    }
    fields
        .chunks_exact(5)
        .map(|fields| {
            Ok(RevertCandidate {
                commit: utf8_field(fields[0], "commit SHA")?,
                short_commit: utf8_field(fields[1], "短縮commit SHA")?,
                subject: utf8_field(fields[2], "commit件名")?,
                author: utf8_field(fields[3], "commit作成者")?,
                committed_at: utf8_field(fields[4], "commit日時")?,
            })
        })
        .collect()
}

fn utf8_field(value: &[u8], label: &str) -> Result<String> {
    String::from_utf8(value.to_vec()).with_context(|| format!("{label}をUTF-8として読めません"))
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
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    use anyhow::{Result, bail};
    use tempfile::TempDir;

    use super::{build_plan_in, execute_in, parse_log, worktree_is_clean_in};

    fn git(root: &Path, args: &[&str]) -> Result<String> {
        let output = Command::new("git").args(args).current_dir(root).output()?;
        if !output.status.success() {
            bail!(
                "git {}: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    fn repository() -> Result<TempDir> {
        let directory = tempfile::tempdir()?;
        let root = directory.path();
        git(root, &["init", "-b", "main"])?;
        git(root, &["config", "user.name", "ART-TRA Test"])?;
        git(root, &["config", "user.email", "arttra@example.test"])?;
        git(root, &["config", "commit.gpgsign", "false"])?;
        git(root, &["config", "core.hooksPath", ".git/no-hooks"])?;
        fs::write(root.join("file.txt"), "base\n")?;
        git(root, &["add", "file.txt"])?;
        git(root, &["commit", "-m", "initial"])?;
        git(root, &["switch", "-c", "feature/82-revert-test"])?;
        Ok(directory)
    }

    #[test]
    fn parses_null_delimited_commit_candidates() {
        let record = [
            "0123456789abcdef",
            "0123456",
            "fix(tui): addを追加する",
            "Roz",
            "2026-08-03T16:00:00+09:00",
            "",
        ]
        .join("\0");
        let parsed = parse_log(record.as_bytes()).expect("parse git log");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].short_commit, "0123456");
        assert_eq!(parsed[0].subject, "fix(tui): addを追加する");
        assert_eq!(parsed[0].author, "Roz");
    }

    #[test]
    fn rejects_incomplete_git_log_records() {
        let error = parse_log(b"sha\0short\0subject\0").expect_err("reject incomplete record");
        assert!(error.to_string().contains("未知の形式"));
    }

    #[test]
    fn creates_a_revert_commit_without_deleting_history() -> Result<()> {
        let repository = repository()?;
        let root = repository.path();
        fs::write(root.join("file.txt"), "changed\n")?;
        git(root, &["add", "file.txt"])?;
        git(root, &["commit", "-m", "change file"])?;
        let target = git(root, &["rev-parse", "HEAD"])?.trim().to_owned();

        let plan = build_plan_in(root, &target)?;
        assert!(plan.worktree_clean);
        execute_in(root, &plan)?;

        assert_eq!(fs::read_to_string(root.join("file.txt"))?, "base\n");
        assert!(git(root, &["log", "-1", "--format=%s"])?.starts_with("Revert \"change file\""));
        assert!(worktree_is_clean_in(root)?);
        assert_eq!(git(root, &["rev-list", "--count", "HEAD"])?.trim(), "3");
        Ok(())
    }

    #[test]
    fn conflicting_revert_is_aborted_and_original_state_is_restored() -> Result<()> {
        let repository = repository()?;
        let root = repository.path();
        fs::write(root.join("file.txt"), "first change\n")?;
        git(root, &["add", "file.txt"])?;
        git(root, &["commit", "-m", "first change"])?;
        let target = git(root, &["rev-parse", "HEAD"])?.trim().to_owned();
        fs::write(root.join("file.txt"), "later change\n")?;
        git(root, &["add", "file.txt"])?;
        git(root, &["commit", "-m", "later change"])?;
        let original_head = git(root, &["rev-parse", "HEAD"])?.trim().to_owned();

        let plan = build_plan_in(root, &target)?;
        let error = execute_in(root, &plan).expect_err("revert should conflict");

        assert!(error.to_string().contains("自動中止"));
        assert_eq!(git(root, &["rev-parse", "HEAD"])?.trim(), original_head);
        assert_eq!(fs::read_to_string(root.join("file.txt"))?, "later change\n");
        assert!(worktree_is_clean_in(root)?);
        Ok(())
    }
}
