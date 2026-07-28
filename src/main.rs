mod policy;

use std::io::{self, IsTerminal};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use anyhow::{Context, Result, anyhow, bail};
use clap::{Args, Parser, Subcommand};
use inquire::{Confirm, Select, Text};
use serde::Serialize;

use crate::policy::{Policy, ValidationMode};

#[derive(Debug, Parser)]
#[command(
    name = "git-ar",
    bin_name = "git ar",
    version,
    about = "Human-friendly, AI-ready Git workflow assistant"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Check the local environment and repository integration.
    Doctor {
        /// Return machine-readable output.
        #[arg(long)]
        json: bool,
    },
    /// Build and optionally create a commit.
    Commit(CommitArgs),
    /// Build and optionally create a GitHub Issue.
    Issue(IssueArgs),
    /// Emit minimal repository context for AI or automation.
    Context {
        /// Return machine-readable output.
        #[arg(long)]
        json: bool,
    },
    /// Show the effective repository policy.
    Policy {
        /// Return machine-readable output.
        #[arg(long)]
        json: bool,
    },
    /// Validate the commit message stored at PATH. Intended for commit-msg hooks.
    #[command(hide = true)]
    ValidateCommitFile { path: PathBuf },
}

#[derive(Debug, Args, Default)]
struct CommitArgs {
    /// Conventional commit type.
    #[arg(long = "type", value_name = "TYPE")]
    kind: Option<String>,
    /// Optional conventional commit scope.
    #[arg(long)]
    scope: Option<String>,
    /// Short imperative summary.
    #[arg(long)]
    summary: Option<String>,
    /// Related GitHub Issue number.
    #[arg(long)]
    issue: Option<u64>,
    /// Print the generated message without committing.
    #[arg(long)]
    dry_run: bool,
    /// Commit without an interactive confirmation.
    #[arg(long)]
    yes: bool,
}

#[derive(Debug, Args, Default)]
struct IssueArgs {
    #[arg(long)]
    title: Option<String>,
    #[arg(long)]
    background: Option<String>,
    #[arg(long)]
    goal: Option<String>,
    #[arg(long)]
    done: Option<String>,
    /// Create the Issue with GitHub CLI. Otherwise only preview it.
    #[arg(long)]
    create: bool,
    /// Return the draft as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Serialize)]
struct CommitDraft {
    subject: String,
    body: Option<String>,
}

#[derive(Debug, Serialize)]
struct IssueDraft {
    title: String,
    background: String,
    goal: String,
    done: String,
}

impl IssueDraft {
    fn body(&self) -> String {
        format!(
            "## 背景\n\n{}\n\n## 目的\n\n{}\n\n## 完了条件\n\n- [ ] {}\n",
            self.background, self.goal, self.done
        )
    }
}

#[derive(Debug, Serialize)]
struct DoctorReport {
    repository: Check,
    hooks: Check,
    git_ar: Check,
    mise: Check,
    gh: Check,
}

#[derive(Debug, Serialize)]
struct Check {
    ok: bool,
    detail: String,
}

#[derive(Debug, Serialize)]
struct RepositoryContext {
    root: String,
    branch: String,
    remote: Option<String>,
    status: Vec<String>,
    staged_files: Vec<String>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("arttra: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Some(Commands::Doctor { json }) => doctor(json),
        Some(Commands::Commit(args)) => commit(args),
        Some(Commands::Issue(args)) => issue(args),
        Some(Commands::Context { json }) => context(json),
        Some(Commands::Policy { json }) => show_policy(json),
        Some(Commands::ValidateCommitFile { path }) => validate_commit_file(&path),
        None => tui(),
    }
}

fn tui() -> Result<()> {
    ensure_interactive()?;
    let action = Select::new(
        "何をしますか？",
        vec![
            "commitを作る",
            "Issueを作る",
            "環境を診断する",
            "AI向けコンテキストを見る",
            "終了する",
        ],
    )
    .prompt()?;

    match action {
        "commitを作る" => commit(CommitArgs::default()),
        "Issueを作る" => issue(IssueArgs::default()),
        "環境を診断する" => doctor(false),
        "AI向けコンテキストを見る" => context(false),
        _ => Ok(()),
    }
}

fn commit(mut args: CommitArgs) -> Result<()> {
    let policy = Policy::load()?;
    let interactive = io::stdin().is_terminal();

    if args.kind.is_none() {
        ensure_interactive()?;
        args.kind = Some(Select::new("変更の種類", policy.commit.allowed_types.clone()).prompt()?);
    }
    if args.summary.is_none() {
        ensure_interactive()?;
        args.summary = Some(
            Text::new("変更を一言で")
                .with_help_message("例: add non-interactive commit input")
                .prompt()?,
        );
    }
    if interactive && args.scope.is_none() {
        let scope = Text::new("scope（任意）").prompt()?;
        if !scope.trim().is_empty() {
            args.scope = Some(scope);
        }
    }
    if interactive && args.issue.is_none() {
        let issue = Text::new("Issue番号（任意）").prompt()?;
        if !issue.trim().is_empty() {
            args.issue = Some(issue.parse().context("Issue番号は整数で指定してください")?);
        }
    }

    let kind = required(args.kind, "--type")?;
    let summary = required(args.summary, "--summary")?;
    let subject = match args
        .scope
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(scope) => format!("{kind}({scope}): {summary}"),
        None => format!("{kind}: {summary}"),
    };
    let draft = CommitDraft {
        subject,
        body: args.issue.map(|number| format!("Refs #{number}")),
    };
    policy.commit.validate_or_report(&draft.subject)?;

    println!("{}", draft.subject);
    if let Some(body) = &draft.body {
        println!("\n{body}");
    }

    if args.dry_run {
        return Ok(());
    }
    if !args.yes {
        ensure_interactive()?;
        if !Confirm::new("この内容でcommitしますか？")
            .with_default(false)
            .prompt()?
        {
            return Ok(());
        }
    }

    let mut command = Command::new("git");
    command.args(["commit", "-m", &draft.subject]);
    if let Some(body) = &draft.body {
        command.args(["-m", body]);
    }
    run_status(&mut command, "git commit")
}

fn issue(mut args: IssueArgs) -> Result<()> {
    if args.title.is_none() {
        ensure_interactive()?;
        args.title = Some(Text::new("Issueタイトル").prompt()?);
    }
    if args.background.is_none() {
        ensure_interactive()?;
        args.background = Some(Text::new("背景").prompt()?);
    }
    if args.goal.is_none() {
        ensure_interactive()?;
        args.goal = Some(Text::new("目的").prompt()?);
    }
    if args.done.is_none() {
        ensure_interactive()?;
        args.done = Some(Text::new("完了条件").prompt()?);
    }

    let draft = IssueDraft {
        title: required(args.title, "--title")?,
        background: required(args.background, "--background")?,
        goal: required(args.goal, "--goal")?,
        done: required(args.done, "--done")?,
    };

    if args.json {
        println!("{}", serde_json::to_string_pretty(&draft)?);
    } else {
        println!("# {}\n\n{}", draft.title, draft.body());
    }

    if !args.create {
        return Ok(());
    }

    let output = Command::new("gh")
        .args([
            "issue",
            "create",
            "--title",
            &draft.title,
            "--body",
            &draft.body(),
        ])
        .output()
        .context("gh issue createを起動できませんでした")?;
    ensure_success(&output, "gh issue create")?;
    print!("{}", String::from_utf8_lossy(&output.stdout));
    Ok(())
}

fn doctor(json: bool) -> Result<()> {
    let root = git_output(["rev-parse", "--show-toplevel"]);
    let hooks = git_output(["config", "--get", "core.hooksPath"]);
    let report = DoctorReport {
        repository: check_result(root, |value| format!("repository: {value}")),
        hooks: match hooks {
            Ok(value) if value.trim() == ".githooks" => Check {
                ok: true,
                detail: "core.hooksPath=.githooks".into(),
            },
            Ok(value) => Check {
                ok: false,
                detail: format!("core.hooksPath={value}; run `mise run setup`"),
            },
            Err(_) => Check {
                ok: false,
                detail: "core.hooksPath is unset; run `mise run setup`".into(),
            },
        },
        git_ar: command_check("git-ar", ["--version"]),
        mise: command_check("mise", ["--version"]),
        gh: command_check("gh", ["auth", "status"]),
    };

    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        for (name, check) in [
            ("repository", &report.repository),
            ("hooks", &report.hooks),
            ("git-ar", &report.git_ar),
            ("mise", &report.mise),
            ("GitHub", &report.gh),
        ] {
            println!(
                "{} {name}: {}",
                if check.ok { "✓" } else { "✗" },
                check.detail
            );
        }
    }

    if [
        &report.repository,
        &report.hooks,
        &report.git_ar,
        &report.mise,
        &report.gh,
    ]
    .iter()
    .all(|check| check.ok)
    {
        Ok(())
    } else {
        bail!("doctor found setup problems")
    }
}

fn context(json: bool) -> Result<()> {
    let root = git_output(["rev-parse", "--show-toplevel"])?;
    let branch = git_output(["branch", "--show-current"])?;
    let remote = git_output(["remote", "get-url", "origin"]).ok();
    let status = lines(git_output(["status", "--short"])?);
    let staged_files = lines(git_output(["diff", "--cached", "--name-only"])?);
    let context = RepositoryContext {
        root,
        branch,
        remote,
        status,
        staged_files,
    };

    if json {
        println!("{}", serde_json::to_string_pretty(&context)?);
    } else {
        println!("repository: {}", context.root);
        println!("branch: {}", context.branch);
        println!("remote: {}", context.remote.as_deref().unwrap_or("(none)"));
        println!("changes: {}", context.status.len());
        println!("staged: {}", context.staged_files.len());
    }
    Ok(())
}

fn show_policy(json: bool) -> Result<()> {
    let policy = Policy::load()?;
    if json {
        println!("{}", serde_json::to_string_pretty(&policy)?);
    } else {
        println!("policy version: {}", policy.version);
        println!("commit mode: {}", policy.commit.mode);
        println!("max subject: {}", policy.commit.max_subject_length);
        println!("types: {}", policy.commit.allowed_types.join(", "));
    }
    Ok(())
}

fn validate_commit_file(path: &Path) -> Result<()> {
    let message = std::fs::read_to_string(path)
        .with_context(|| format!("{}を読み込めませんでした", path.display()))?;
    let subject = message.lines().next().unwrap_or_default();
    let policy = Policy::load()?;
    let violations = policy.commit.violations(subject);
    if violations.is_empty() {
        return Ok(());
    }

    for violation in &violations {
        eprintln!("arttra: {violation}");
    }
    match policy.commit.mode {
        ValidationMode::Warn => {
            eprintln!("arttra: warning only; commit is allowed");
            Ok(())
        }
        ValidationMode::Block => bail!("commit message rejected by arttra policy"),
    }
}

fn ensure_interactive() -> Result<()> {
    if io::stdin().is_terminal() {
        Ok(())
    } else {
        bail!("non-interactive execution requires complete command arguments")
    }
}

fn required(value: Option<String>, flag: &str) -> Result<String> {
    value
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("{flag} is required"))
}

fn git_output<const N: usize>(args: [&str; N]) -> Result<String> {
    let output = Command::new("git")
        .args(args)
        .output()
        .context("gitを起動できませんでした")?;
    ensure_success(&output, "git")?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn command_check<const N: usize>(program: &str, args: [&str; N]) -> Check {
    match Command::new(program).args(args).output() {
        Ok(output) if output.status.success() => Check {
            ok: true,
            detail: first_output_line(&output),
        },
        Ok(output) => Check {
            ok: false,
            detail: first_output_line(&output),
        },
        Err(error) => Check {
            ok: false,
            detail: error.to_string(),
        },
    }
}

fn check_result<F>(result: Result<String>, format: F) -> Check
where
    F: FnOnce(String) -> String,
{
    match result {
        Ok(value) => Check {
            ok: true,
            detail: format(value),
        },
        Err(error) => Check {
            ok: false,
            detail: error.to_string(),
        },
    }
}

fn first_output_line(output: &Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    stdout
        .lines()
        .chain(stderr.lines())
        .find(|line| !line.trim().is_empty())
        .unwrap_or("(no output)")
        .to_owned()
}

fn ensure_success(output: &Output, action: &str) -> Result<()> {
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr);
        bail!("{action} failed: {}", detail.trim())
    }
}

fn run_status(command: &mut Command, action: &str) -> Result<()> {
    let status = command
        .status()
        .with_context(|| format!("{action}を起動できませんでした"))?;
    if status.success() {
        Ok(())
    } else {
        bail!("{action} failed with {status}")
    }
}

fn lines(value: String) -> Vec<String> {
    value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::IssueDraft;

    #[test]
    fn issue_body_has_stable_sections() {
        let draft = IssueDraft {
            title: "title".into(),
            background: "background".into(),
            goal: "goal".into(),
            done: "done".into(),
        };
        assert_eq!(
            draft.body(),
            "## 背景\n\nbackground\n\n## 目的\n\ngoal\n\n## 完了条件\n\n- [ ] done\n"
        );
    }
}
