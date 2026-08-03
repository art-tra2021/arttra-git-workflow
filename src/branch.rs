use std::env;
use std::path::Path;
use std::process::{Command, Output};

use anyhow::{Context, Result, bail};
use regex::Regex;
use serde::Serialize;

use crate::policy::{BranchPolicy, ValidationMode};

#[derive(Debug, Serialize)]
pub struct BranchDraft {
    pub name: String,
    pub kind: String,
    pub issue: u64,
    pub slug: String,
    pub owner: String,
}

#[derive(Debug, Serialize)]
pub struct BranchValidation {
    pub schema_version: u32,
    pub valid: bool,
    pub error_code: Option<&'static str>,
    pub message_ja: Option<String>,
    pub fix_command: Option<String>,
}

pub fn draft(
    policy: &BranchPolicy,
    kind: String,
    issue: u64,
    slug: String,
    owner: String,
) -> Result<BranchDraft> {
    if !policy.allowed_types.iter().any(|allowed| allowed == &kind) {
        bail!(
            "branch種別`{kind}`は使用できません。候補: {}",
            policy.allowed_types.join(", ")
        );
    }
    if issue == 0 {
        bail!("Issue番号は1以上で指定してください");
    }
    let slug = kebab(&slug)?;
    let owner = kebab(&owner)?;
    let name = format!("{kind}/{issue}-{slug}-{owner}");
    let validation = validate(&name, policy);
    if !validation.valid {
        bail!(
            "生成したbranch名を検証できませんでした: {}",
            validation.message_ja.as_deref().unwrap_or("branch規則違反")
        );
    }
    Ok(BranchDraft {
        name,
        kind,
        issue,
        slug,
        owner,
    })
}

pub fn create(draft: &BranchDraft, from: Option<&str>) -> Result<()> {
    let mut command = Command::new("gh");
    command.args([
        "issue",
        "develop",
        &draft.issue.to_string(),
        "--name",
        &draft.name,
        "--checkout",
    ]);
    if let Some(from) = from.filter(|value| !value.trim().is_empty()) {
        command.args(["--base", from]);
    }
    let output = command
        .output()
        .context("gh issue developを起動できませんでした")?;
    ensure_success(&output, "Issueに紐づくbranch作成")?;
    Ok(())
}

pub fn has_changes() -> Result<bool> {
    has_changes_in(Path::new("."))
}

fn has_changes_in(root: &Path) -> Result<bool> {
    let output = Command::new("git")
        .args(["status", "--porcelain=v1"])
        .current_dir(root)
        .output()
        .context("branch移動前の変更状態を確認できませんでした")?;
    ensure_success(&output, "変更状態の確認")?;
    Ok(!output.stdout.is_empty())
}

pub fn create_transferring_changes(draft: &BranchDraft, from: Option<&str>) -> Result<()> {
    transfer_changes_in(Path::new("."), &draft.name, || create(draft, from))
}

fn transfer_changes_in<F>(root: &Path, target_branch: &str, create_branch: F) -> Result<()>
where
    F: FnOnce() -> Result<()>,
{
    if !has_changes_in(root)? {
        return create_branch();
    }

    let original_branch = current_branch_in(root)?;
    let previous_stash = stash_head_in(root)?;
    let output = Command::new("git")
        .args([
            "stash",
            "push",
            "--include-untracked",
            "--message",
            &format!("git-ar branch transfer: {target_branch}"),
        ])
        .current_dir(root)
        .output()
        .context("branch移動のために変更を一時退避できませんでした")?;
    ensure_success(&output, "変更の一時退避")?;
    let Some(created_stash) = stash_head_in(root)? else {
        bail!("変更を一時退避したはずですがstashを確認できませんでした");
    };
    if previous_stash.as_deref() == Some(created_stash.as_str()) {
        bail!("新しいstashが作成されなかったためbranch作成を中止しました");
    }

    if let Err(create_error) = create_branch() {
        let current_branch = current_branch_in(root).with_context(|| {
            format!(
                "{create_error:#}\nbranch作成失敗後の現在地を確認できませんでした。変更はstash `{created_stash}` に残しています。`git switch {original_branch}`の後、stash先頭が同じことを確認して`git stash pop --index stash@{{0}}`を実行してください"
            )
        })?;
        if current_branch != original_branch {
            let switch = Command::new("git")
                .args(["switch", &original_branch])
                .current_dir(root)
                .output()
                .context("元のbranchへ戻す処理を起動できませんでした")?;
            if let Err(switch_error) = ensure_success(&switch, "元のbranchへの復帰") {
                bail!(
                    "{create_error:#}\n元のbranchへ戻せませんでした: {switch_error:#}\n変更はstash `{created_stash}` に残しています"
                );
            }
        }
        if let Err(restore_error) = restore_stash_in(root, &created_stash) {
            bail!(
                "{create_error:#}\n退避した変更も自動復元できませんでした: {restore_error:#}\n変更はstash `{created_stash}` に残しています"
            );
        }
        return Err(create_error);
    }

    let current_branch = current_branch_in(root)?;
    if current_branch != target_branch {
        bail!(
            "branch作成後の移動先が想定と異なります（現在: `{current_branch}`）。変更はstash `{created_stash}` に残しています"
        );
    }
    restore_stash_in(root, &created_stash).with_context(|| {
        format!(
            "branchは作成済みですが変更を自動復元できませんでした。stash `{created_stash}` は削除していません"
        )
    })?;
    Ok(())
}

fn stash_head_in(root: &Path) -> Result<Option<String>> {
    let output = Command::new("git")
        .args(["rev-parse", "--quiet", "--verify", "refs/stash"])
        .current_dir(root)
        .output()
        .context("stashの状態を確認できませんでした")?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(Some(
        String::from_utf8_lossy(&output.stdout).trim().to_owned(),
    ))
}

fn restore_stash_in(root: &Path, expected: &str) -> Result<()> {
    let current = stash_head_in(root)?;
    if current.as_deref() != Some(expected) {
        bail!("退避後に別のstashが追加されたため、自動popを中止しました（復元対象: `{expected}`）");
    }
    let output = Command::new("git")
        .args(["stash", "pop", "--index", "stash@{0}"])
        .current_dir(root)
        .output()
        .context("退避した変更の復元を起動できませんでした")?;
    ensure_success(&output, "退避した変更の復元")
}

pub fn validate_push_input(input: &str, policy: &BranchPolicy) -> Result<()> {
    for line in input.lines().filter(|line| !line.trim().is_empty()) {
        let Some(local_ref) = line.split_whitespace().next() else {
            continue;
        };
        let Some(branch) = local_ref.strip_prefix("refs/heads/") else {
            continue;
        };
        validate_or_report(branch, policy, false)?;
    }
    Ok(())
}

pub fn validate(branch: &str, policy: &BranchPolicy) -> BranchValidation {
    if matches!(policy.mode, ValidationMode::Off)
        || policy
            .protected_branches
            .iter()
            .any(|allowed| allowed == branch)
        || policy
            .bypass_prefixes
            .iter()
            .any(|prefix| branch.starts_with(prefix))
    {
        return valid();
    }

    let Some((kind, suffix)) = branch.split_once('/') else {
        return invalid(branch, policy, "branch名に種別と`/`が必要です");
    };
    if !policy.allowed_types.iter().any(|allowed| allowed == kind) {
        return invalid(
            branch,
            policy,
            &format!(
                "branch種別`{kind}`は使用できません。候補: {}",
                policy.allowed_types.join(", ")
            ),
        );
    }
    let shape = Regex::new(r"^[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)+$")
        .expect("branch shape pattern is valid");
    if !shape.is_match(suffix) {
        return invalid(
            branch,
            policy,
            "branch名は`type/issue-slug-owner`形式の英小文字・数字・ハイフンで指定してください",
        );
    }
    valid()
}

pub fn validate_or_report(branch: &str, policy: &BranchPolicy, json: bool) -> Result<()> {
    let result = validate(branch, policy);
    if json {
        println!("{}", serde_json::to_string_pretty(&result)?);
    } else if result.valid {
        println!("✓ branch名は規則に一致しています: {branch}");
    } else {
        let code = result.error_code.unwrap_or("AR-BRANCH-001");
        eprintln!(
            "{code}: {}",
            result
                .message_ja
                .as_deref()
                .unwrap_or("branch名が規則に一致しません")
        );
        if let Some(command) = &result.fix_command {
            eprintln!("\n次を実行してください:\n{command}");
        }
    }

    if !result.valid && matches!(policy.mode, ValidationMode::Block) {
        bail!("branch名がリポジトリ規則により拒否されました");
    }
    Ok(())
}

pub fn current_branch() -> Result<String> {
    current_branch_in(Path::new("."))
}

fn current_branch_in(root: &Path) -> Result<String> {
    let output = Command::new("git")
        .args(["branch", "--show-current"])
        .current_dir(root)
        .output()
        .context("現在のbranchを確認できませんでした")?;
    ensure_success(&output, "branch確認")?;
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if branch.is_empty() {
        bail!("detached HEADではbranch名を検証できません");
    }
    Ok(branch)
}

pub fn detect_owner() -> String {
    for key in ["GITHUB_ACTOR", "USER", "USERNAME"] {
        if let Ok(value) = env::var(key)
            && let Ok(value) = kebab(&value)
        {
            return value;
        }
    }
    "owner".into()
}

fn valid() -> BranchValidation {
    BranchValidation {
        schema_version: 1,
        valid: true,
        error_code: None,
        message_ja: None,
        fix_command: None,
    }
}

fn invalid(branch: &str, policy: &BranchPolicy, reason: &str) -> BranchValidation {
    let issue_pattern = Regex::new(r"[1-9][0-9]*").expect("issue pattern is valid");
    let issue = issue_pattern.find(branch).map(|value| value.as_str());
    let kind = branch
        .split('/')
        .next()
        .filter(|kind| policy.allowed_types.iter().any(|allowed| allowed == kind))
        .unwrap_or("feature");
    let last_component = branch.rsplit('/').next().unwrap_or(branch);
    let without_issue = issue.map_or(last_component, |issue| {
        last_component
            .strip_prefix(issue)
            .and_then(|value| value.strip_prefix(['-', '_']))
            .unwrap_or(last_component)
    });
    let slug = kebab(without_issue).unwrap_or_else(|_| "change".into());
    let owner = detect_owner();
    let fix_command = issue.map_or_else(
        || Some("git ar branch".into()),
        |issue| Some(format!("git branch -m {kind}/{issue}-{slug}-{owner}")),
    );
    BranchValidation {
        schema_version: 1,
        valid: false,
        error_code: Some("AR-BRANCH-001"),
        message_ja: Some(format!("{reason}（現在: `{branch}`）")),
        fix_command,
    }
}

fn kebab(value: &str) -> Result<String> {
    let mut output = String::new();
    let mut previous_dash = false;
    for character in value.trim().chars() {
        if character.is_ascii_alphanumeric() {
            output.push(character.to_ascii_lowercase());
            previous_dash = false;
        } else if !previous_dash {
            output.push('-');
            previous_dash = true;
        }
    }
    let output = output.trim_matches('-');
    if output.is_empty() {
        bail!("英数字を1文字以上入力してください");
    }
    Ok(output.into())
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

    use super::{
        current_branch_in, draft, stash_head_in, transfer_changes_in, validate, validate_push_input,
    };
    use crate::policy::{BranchPolicy, ValidationMode};

    fn policy(mode: ValidationMode) -> BranchPolicy {
        BranchPolicy {
            mode,
            allowed_types: vec!["feature".into(), "fix".into()],
            protected_branches: vec!["main".into()],
            bypass_prefixes: vec!["dependabot/".into()],
        }
    }

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
        fs::write(root.join("tracked.txt"), "base\n")?;
        git(root, &["add", "tracked.txt"])?;
        git(root, &["commit", "-m", "initial"])?;
        Ok(directory)
    }

    #[test]
    fn builds_ascii_branch_name_from_human_input() {
        let branch = draft(
            &policy(ValidationMode::Block),
            "feature".into(),
            42,
            "Login Screen".into(),
            "Roz".into(),
        )
        .expect("draft");
        assert_eq!(branch.name, "feature/42-login-screen-roz");
    }

    #[test]
    fn validates_every_branch_and_ignores_tags_from_pre_push() {
        let input = concat!(
            "refs/heads/feature/42-login-screen-roz abc refs/heads/feature/42-login-screen-roz def\n",
            "refs/tags/v1.0.0 abc refs/tags/v1.0.0 def\n",
        );
        validate_push_input(input, &policy(ValidationMode::Block)).expect("valid push input");
    }

    #[test]
    fn rejects_invalid_branch_from_pre_push() {
        let input = "refs/heads/bad-name abc refs/heads/bad-name def\n";
        assert!(validate_push_input(input, &policy(ValidationMode::Block)).is_err());
    }

    #[test]
    fn validates_normal_and_protected_branches() {
        assert!(
            validate(
                "feature/42-login-screen-roz",
                &policy(ValidationMode::Block)
            )
            .valid
        );
        assert!(validate("main", &policy(ValidationMode::Block)).valid);
        assert!(validate("dependabot/cargo/serde-1.0", &policy(ValidationMode::Block)).valid);
    }

    #[test]
    fn rejects_missing_issue_and_returns_fix_command() {
        let validation = validate("feature/login-screen", &policy(ValidationMode::Block));
        assert!(!validation.valid);
        assert_eq!(validation.error_code, Some("AR-BRANCH-001"));
        assert_eq!(validation.fix_command.as_deref(), Some("git ar branch"));
    }

    #[test]
    fn stash_transfer_restores_staged_and_untracked_changes_on_new_branch() -> Result<()> {
        let repository = repository()?;
        let root = repository.path();
        fs::write(root.join("tracked.txt"), "changed\n")?;
        git(root, &["add", "tracked.txt"])?;
        fs::write(root.join("untracked.txt"), "new\n")?;

        transfer_changes_in(root, "feature/82-transfer-test", || {
            git(root, &["switch", "-c", "feature/82-transfer-test"])?;
            Ok(())
        })?;

        assert_eq!(current_branch_in(root)?, "feature/82-transfer-test");
        let status = git(root, &["status", "--porcelain=v1", "--untracked-files=all"])?;
        assert!(status.lines().any(|line| line == "M  tracked.txt"));
        assert!(status.lines().any(|line| line == "?? untracked.txt"));
        assert_eq!(
            git(root, &["diff", "--cached", "--name-only"])?.trim(),
            "tracked.txt"
        );
        assert_eq!(stash_head_in(root)?, None);
        Ok(())
    }

    #[test]
    fn failed_branch_creation_restores_original_branch_and_changes() -> Result<()> {
        let repository = repository()?;
        let root = repository.path();
        fs::write(root.join("tracked.txt"), "changed\n")?;
        fs::write(root.join("untracked.txt"), "new\n")?;

        let error = transfer_changes_in(root, "feature/82-failure-test", || {
            bail!("simulated branch creation failure")
        })
        .expect_err("branch creation should fail");

        assert!(
            error
                .to_string()
                .contains("simulated branch creation failure")
        );
        assert_eq!(current_branch_in(root)?, "main");
        let status = git(root, &["status", "--porcelain=v1", "--untracked-files=all"])?;
        assert!(status.lines().any(|line| line == " M tracked.txt"));
        assert!(status.lines().any(|line| line == "?? untracked.txt"));
        assert_eq!(stash_head_in(root)?, None);
        Ok(())
    }
}
