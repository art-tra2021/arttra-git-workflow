mod branch;
mod guard;
mod policy;
mod presence;
mod scheduler;
mod setup;
mod tasks;
mod telemetry;

use std::io::{self, IsTerminal, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use anyhow::{Context, Result, anyhow, bail};
use clap::{Args, Parser, Subcommand, ValueEnum};
use inquire::{Confirm, Select, Text};
use serde::{Deserialize, Serialize};

use crate::guard::{GuardDecision, GuardDenied};
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
    /// Run repository checks with human or machine-readable output.
    Check {
        /// Run the editing-time quick checks instead of every required gate.
        #[arg(long)]
        quick: bool,
        /// Return the result and captured diagnostics as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Build and optionally create a commit.
    Commit(CommitArgs),
    /// Build and optionally create a policy-compliant branch.
    Branch(BranchArgs),
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
    /// Evaluate commands against the shared toolchain policy.
    Guard(GuardArgs),
    /// Share changed file metadata and detect work overlaps.
    Presence(PresenceArgs),
    /// Show your GitHub tasks in a small human/AI-friendly view.
    Tasks {
        /// Return machine-readable output.
        #[arg(long)]
        json: bool,
        /// Select an Issue and open it in the browser.
        #[arg(long)]
        open: bool,
        /// Open gh-dash when installed, with the compact view as a fallback.
        #[arg(long)]
        dashboard: bool,
    },
    /// Summarize privacy-safe local policy telemetry.
    Telemetry {
        /// Return machine-readable output.
        #[arg(long)]
        json: bool,
    },
    /// Install local, untracked integrations.
    Setup,
    /// Validate the commit message stored at PATH. Intended for commit-msg hooks.
    #[command(hide = true)]
    ValidateCommitFile { path: PathBuf },
    /// Validate a branch name. Intended for pre-push hooks.
    #[command(hide = true)]
    ValidateBranch {
        #[arg(long)]
        branch: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Validate refs received on stdin. Intended for pre-push hooks.
    #[command(hide = true)]
    ValidatePush,
}

#[derive(Debug, Args)]
struct GuardArgs {
    #[command(subcommand)]
    command: GuardCommands,
}

#[derive(Debug, Subcommand)]
enum GuardCommands {
    /// Evaluate one command supplied as an argument.
    Command {
        #[arg(long)]
        command: String,
        #[arg(long, value_enum, default_value_t = GuardAgent::Human)]
        agent: GuardAgent,
        #[arg(long)]
        json: bool,
    },
    /// Read a Claude or Codex PreToolUse payload from stdin.
    Hook {
        #[arg(long, value_enum)]
        agent: GuardAgent,
    },
}

#[derive(Debug, Args)]
struct PresenceArgs {
    #[command(subcommand)]
    command: PresenceCommands,
}

#[derive(Debug, Subcommand)]
enum PresenceCommands {
    /// Show the local metadata that would be shared.
    Snapshot {
        #[arg(long)]
        json: bool,
    },
    /// Publish the current metadata to the configured Git remote.
    Publish {
        #[arg(long)]
        actor: Option<String>,
        #[arg(long)]
        device: Option<String>,
        /// Preview without creating Git objects or pushing.
        #[arg(long)]
        dry_run: bool,
        /// Confirm the GitHub write.
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        json: bool,
    },
    /// Fetch active snapshots and report overlapping files.
    Check {
        #[arg(long)]
        json: bool,
    },
    /// Publish repeatedly. Intended for a terminal or OS scheduler.
    Watch {
        #[arg(long)]
        actor: Option<String>,
        #[arg(long)]
        device: Option<String>,
        /// Publish once and exit; useful for schedulers.
        #[arg(long)]
        once: bool,
        /// Confirm repeated GitHub writes.
        #[arg(long)]
        yes: bool,
    },
    /// Install periodic background publishing for this repository.
    Install {
        /// Confirm writing an OS background-task definition.
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        json: bool,
    },
    /// Show the periodic background publisher state.
    Status {
        #[arg(long)]
        json: bool,
    },
    /// Remove the periodic background publisher.
    Uninstall {
        /// Confirm removing the OS background-task definition.
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum GuardAgent {
    Human,
    Claude,
    Codex,
}

impl GuardAgent {
    fn as_str(self) -> &'static str {
        match self {
            Self::Human => "human",
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
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
    /// Replace the current HEAD commit while preserving the same guided input.
    #[arg(long)]
    amend: bool,
}

#[derive(Debug, Args, Default)]
struct BranchArgs {
    /// Branch type such as feature, fix, or hotfix.
    #[arg(long = "type", value_name = "TYPE")]
    kind: Option<String>,
    /// Related GitHub Issue number.
    #[arg(long)]
    issue: Option<u64>,
    /// Short ASCII/kebab description.
    #[arg(long)]
    slug: Option<String>,
    /// Work owner, normally a GitHub login.
    #[arg(long)]
    owner: Option<String>,
    /// Base branch. Defaults to the repository default branch.
    #[arg(long)]
    from: Option<String>,
    /// Create and switch to the branch. Otherwise only preview it.
    #[arg(long)]
    create: bool,
    /// Return the draft as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args, Default)]
struct IssueArgs {
    /// Issue class: intake, work, task, or business.
    #[arg(long, value_enum)]
    kind: Option<IssueKind>,
    /// Merge policy for work and business Issues.
    #[arg(long, value_enum)]
    merge: Option<MergeMode>,
    #[arg(long)]
    title: Option<String>,
    #[arg(long)]
    background: Option<String>,
    #[arg(long)]
    goal: Option<String>,
    #[arg(long)]
    done: Option<String>,
    /// Parent Issue number.
    #[arg(long)]
    parent: Option<u64>,
    /// Blocking Issue number. May be repeated.
    #[arg(long)]
    blocked_by: Vec<u64>,
    /// Issue number that the new Issue blocks. May be repeated.
    #[arg(long)]
    blocking: Vec<u64>,
    /// Target date written to the Issue for Projects ingestion.
    #[arg(long)]
    target_date: Option<String>,
    /// Create the Issue with GitHub CLI. Otherwise only preview it.
    #[arg(long)]
    create: bool,
    /// Return the draft as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Clone, Copy, ValueEnum, Serialize)]
#[serde(rename_all = "lowercase")]
enum IssueKind {
    Intake,
    Work,
    Task,
    Business,
}

impl IssueKind {
    fn label(self) -> &'static str {
        match self {
            Self::Intake => "type/intake",
            Self::Work => "type/work",
            Self::Task => "type/task",
            Self::Business => "type/business",
        }
    }

    fn needs_merge_policy(self) -> bool {
        matches!(self, Self::Work | Self::Business)
    }
}

impl std::fmt::Display for IssueKind {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Intake => "相談・受付",
            Self::Work => "作業チケット",
            Self::Task => "小タスク",
            Self::Business => "営業・業務変更",
        })
    }
}

#[derive(Debug, Clone, Copy, ValueEnum, Serialize)]
#[serde(rename_all = "lowercase")]
enum MergeMode {
    Review,
    #[value(name = "self")]
    SelfMerge,
    Emergency,
}

impl MergeMode {
    fn label(self) -> &'static str {
        match self {
            Self::Review => "merge/review",
            Self::SelfMerge => "merge/self",
            Self::Emergency => "merge/emergency",
        }
    }
}

impl std::fmt::Display for MergeMode {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Review => "通常レビュー",
            Self::SelfMerge => "本人マージ可",
            Self::Emergency => "緊急マージ（事後レビュー）",
        })
    }
}

#[derive(Debug, Serialize)]
struct CommitDraft {
    subject: String,
    body: Option<String>,
}

#[derive(Debug, Serialize)]
struct IssueDraft {
    kind: IssueKind,
    merge: Option<MergeMode>,
    title: String,
    background: String,
    goal: String,
    done: String,
    parent: Option<u64>,
    blocked_by: Vec<u64>,
    blocking: Vec<u64>,
    target_date: Option<String>,
}

impl IssueDraft {
    fn body(&self) -> String {
        let mut body = format!(
            "## 背景\n\n{}\n\n## 目的\n\n{}\n\n## 完了条件\n\n- [ ] {}\n",
            self.background, self.goal, self.done
        );
        if let Some(merge) = self.merge {
            body.push_str(&format!("\n## マージ方針\n\n`{}`\n", merge.label()));
        }
        if let Some(parent) = self.parent {
            body.push_str(&format!("\n## 親Issue\n\n#{parent}\n"));
        }
        if !self.blocked_by.is_empty() {
            let issues = self
                .blocked_by
                .iter()
                .map(|number| format!("#{number}"))
                .collect::<Vec<_>>()
                .join(", ");
            body.push_str(&format!("\n## ブロック元\n\n{issues}\n"));
        }
        if !self.blocking.is_empty() {
            let issues = self
                .blocking
                .iter()
                .map(|number| format!("#{number}"))
                .collect::<Vec<_>>()
                .join(", ");
            body.push_str(&format!("\n## ブロック対象\n\n{issues}\n"));
        }
        if let Some(target_date) = &self.target_date {
            body.push_str(&format!("\n## 目標日\n\n{target_date}\n"));
        }
        body
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
struct VerificationReport {
    schema_version: u32,
    task: &'static str,
    ok: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    fix_command: &'static str,
}

#[derive(Debug, Serialize)]
struct RepositoryContext {
    root: String,
    branch: String,
    remote: Option<String>,
    status: Vec<String>,
    staged_files: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct HookInput {
    tool_input: HookToolInput,
}

#[derive(Debug, Deserialize)]
struct HookToolInput {
    command: Option<String>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("arttra: {error:#}");
        let exit_code = if error.downcast_ref::<GuardDenied>().is_some() {
            3
        } else {
            1
        };
        std::process::exit(exit_code);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Some(Commands::Doctor { json }) => doctor(json),
        Some(Commands::Check { quick, json }) => check(quick, json),
        Some(Commands::Commit(args)) => commit(args),
        Some(Commands::Branch(args)) => branch_command(args),
        Some(Commands::Issue(args)) => issue(args),
        Some(Commands::Context { json }) => context(json),
        Some(Commands::Policy { json }) => show_policy(json),
        Some(Commands::Guard(args)) => guard(args),
        Some(Commands::Presence(args)) => presence(args),
        Some(Commands::Tasks {
            json,
            open,
            dashboard,
        }) => tasks::show(json, open, dashboard),
        Some(Commands::Telemetry { json }) => {
            let root = guard::repository_root()?;
            telemetry::report(&Policy::load()?, &root, json)
        }
        Some(Commands::Setup) => setup::install(&guard::repository_root()?),
        Some(Commands::ValidateCommitFile { path }) => validate_commit_file(&path),
        Some(Commands::ValidateBranch { branch, json }) => {
            let policy = Policy::load()?;
            let branch = branch.map_or_else(branch::current_branch, Ok)?;
            branch::validate_or_report(&branch, &policy.branch, json)
        }
        Some(Commands::ValidatePush) => {
            let policy = Policy::load()?;
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .context("pre-pushの入力を読み込めませんでした")?;
            branch::validate_push_input(&input, &policy.branch)
        }
        None => tui(),
    }
}

fn tui() -> Result<()> {
    ensure_interactive()?;
    let action = Select::new(
        "何をしますか？",
        vec![
            "commitを作る",
            "branchを作る",
            "Issueを作る",
            "作業ファイルの重複を確認する",
            "自分のタスクを見る",
            "一括チェックする",
            "環境を診断する",
            "AI向けコンテキストを見る",
            "終了する",
        ],
    )
    .prompt()?;

    match action {
        "commitを作る" => commit(CommitArgs::default()),
        "branchを作る" => branch_command(BranchArgs::default()),
        "Issueを作る" => issue(IssueArgs::default()),
        "作業ファイルの重複を確認する" => {
            let policy = Policy::load()?;
            presence::check(&policy.presence, false)
        }
        "自分のタスクを見る" => tasks::show(false, false, true),
        "一括チェックする" => check(false, false),
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
        body: Some(match args.issue {
            Some(number) => format!("Refs #{number}\n\nAR-Commit: git-ar/v1"),
            None => "AR-Commit: git-ar/v1".into(),
        }),
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
    command.arg("commit");
    if args.amend {
        command.arg("--amend");
    }
    command.args(["-m", &draft.subject]);
    if let Some(body) = &draft.body {
        command.args(["-m", body]);
    }
    run_status(&mut command, "git commit")
}

fn branch_command(mut args: BranchArgs) -> Result<()> {
    let policy = Policy::load()?;
    let interactive = io::stdin().is_terminal();
    if args.kind.is_none() {
        ensure_interactive()?;
        args.kind =
            Some(Select::new("branchの種類", policy.branch.allowed_types.clone()).prompt()?);
    }
    if args.issue.is_none() {
        ensure_interactive()?;
        let issue = Text::new("関連Issue番号").prompt()?;
        args.issue = Some(issue.parse().context("Issue番号は整数で指定してください")?);
    }
    if args.slug.is_none() {
        ensure_interactive()?;
        args.slug = Some(
            Text::new("内容（英数字。空白はハイフンへ変換）")
                .with_help_message("例: login screen")
                .prompt()?,
        );
    }
    if args.owner.is_none() {
        ensure_interactive()?;
        let default_owner = branch::detect_owner();
        args.owner = Some(Text::new("担当者").with_default(&default_owner).prompt()?);
    }
    if interactive && args.from.is_none() {
        let from = Text::new("作成元branch（任意。空欄はGitHubのdefault branch）").prompt()?;
        if !from.trim().is_empty() {
            args.from = Some(from);
        }
    }

    let draft = branch::draft(
        &policy.branch,
        required(args.kind, "--type")?,
        args.issue.context("--issue is required")?,
        required(args.slug, "--slug")?,
        required(args.owner, "--owner")?,
    )?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&draft)?);
    } else {
        println!("{}", draft.name);
    }
    if !args.create {
        return Ok(());
    }
    if interactive
        && !Confirm::new("このbranchを作成しますか？")
            .with_default(false)
            .prompt()?
    {
        return Ok(());
    }
    branch::create(&draft, args.from.as_deref())
}

fn issue(mut args: IssueArgs) -> Result<()> {
    let interactive = io::stdin().is_terminal();
    if args.kind.is_none() && interactive {
        args.kind = Some(
            Select::new(
                "Issueの種類",
                vec![
                    IssueKind::Intake,
                    IssueKind::Work,
                    IssueKind::Task,
                    IssueKind::Business,
                ],
            )
            .prompt()?,
        );
    }
    let kind = args.kind.unwrap_or(IssueKind::Work);
    if kind.needs_merge_policy() && args.merge.is_none() && interactive {
        args.merge = Some(
            Select::new(
                "マージ方針",
                vec![
                    MergeMode::Review,
                    MergeMode::SelfMerge,
                    MergeMode::Emergency,
                ],
            )
            .prompt()?,
        );
    }
    let merge = kind
        .needs_merge_policy()
        .then_some(args.merge.unwrap_or(MergeMode::Review));
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
    if interactive
        && args.parent.is_none()
        && args.blocked_by.is_empty()
        && args.blocking.is_empty()
        && args.target_date.is_none()
        && Confirm::new("依存関係や目標日も設定しますか？")
            .with_default(false)
            .prompt()?
    {
        let parent = Text::new("親Issue番号（任意）").prompt()?;
        if !parent.trim().is_empty() {
            args.parent = Some(
                parent
                    .trim()
                    .parse()
                    .context("親Issue番号は整数で指定してください")?,
            );
        }
        args.blocked_by =
            parse_issue_numbers(&Text::new("ブロック元Issue番号（任意、カンマ区切り）").prompt()?)?;
        args.blocking = parse_issue_numbers(
            &Text::new("このIssueがブロックするIssue番号（任意、カンマ区切り）").prompt()?,
        )?;
        let target_date = Text::new("目標日 YYYY-MM-DD（任意）").prompt()?;
        if !target_date.trim().is_empty() {
            args.target_date = Some(target_date.trim().to_owned());
        }
    }

    let draft = IssueDraft {
        kind,
        merge,
        title: required(args.title, "--title")?,
        background: required(args.background, "--background")?,
        goal: required(args.goal, "--goal")?,
        done: required(args.done, "--done")?,
        parent: args.parent,
        blocked_by: args.blocked_by,
        blocking: args.blocking,
        target_date: args.target_date,
    };

    if args.json {
        println!("{}", serde_json::to_string_pretty(&draft)?);
    } else {
        println!("# {}\n\n{}", draft.title, draft.body());
    }

    if !args.create {
        return Ok(());
    }

    let mut command = Command::new("gh");
    command.args([
        "issue",
        "create",
        "--title",
        &draft.title,
        "--body",
        &draft.body(),
        "--label",
        draft.kind.label(),
    ]);
    if let Some(merge) = draft.merge {
        command.args(["--label", merge.label()]);
    }
    if let Some(parent) = draft.parent {
        command.args(["--parent", &parent.to_string()]);
    }
    if !draft.blocked_by.is_empty() {
        let blocked_by = draft
            .blocked_by
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(",");
        command.args(["--blocked-by", &blocked_by]);
    }
    if !draft.blocking.is_empty() {
        let blocking = draft
            .blocking
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(",");
        command.args(["--blocking", &blocking]);
    }
    if !matches!(draft.kind, IssueKind::Intake) {
        command.args(["--assignee", "@me"]);
    }
    let output = command
        .output()
        .context("gh issue createを起動できませんでした")?;
    ensure_success(&output, "gh issue create")?;
    print!("{}", String::from_utf8_lossy(&output.stdout));
    Ok(())
}

fn doctor(json: bool) -> Result<()> {
    let root = git_output(["rev-parse", "--show-toplevel"]);
    let report = DoctorReport {
        repository: check_result(root, |value| format!("repository: {value}")),
        hooks: hook_check(),
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

fn check(quick: bool, json: bool) -> Result<()> {
    let task = if quick { "quick" } else { "verify" };
    let fix_command = if quick {
        "mise run quick"
    } else {
        "mise run verify"
    };
    if json {
        let output = Command::new("mise")
            .args(["run", task])
            .env("NO_COLOR", "1")
            .env("CARGO_TERM_COLOR", "never")
            .output()
            .context("miseを起動できませんでした")?;
        let report = VerificationReport {
            schema_version: 1,
            task,
            ok: output.status.success(),
            exit_code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            fix_command,
        };
        println!("{}", serde_json::to_string_pretty(&report)?);
        if !report.ok {
            bail!("検査に失敗しました。JSONのdiagnosticsを確認してください");
        }
        return Ok(());
    }

    let status = Command::new("mise")
        .args(["run", task])
        .status()
        .context("miseを起動できませんでした")?;
    if status.success() {
        println!("✓ 検査に合格しました: {fix_command}");
        Ok(())
    } else {
        bail!("検査に失敗しました。修正後に次を再実行してください: {fix_command}")
    }
}

fn hook_check() -> Check {
    if let Ok(command) = git_output(["config", "--get", "hook.hk-commit-msg.command"])
        && is_hk_commit_msg_command(&command)
    {
        return Check {
            ok: true,
            detail: "hk-managed config hooks are installed".into(),
        };
    }

    if let Ok(value) = git_output(["config", "--local", "--get", "core.hooksPath"])
        && !value.trim().is_empty()
    {
        return Check {
            ok: false,
            detail: format!(
                "custom core.hooksPath={}; confirm it before running `mise run setup`",
                value.trim()
            ),
        };
    }
    let Ok(path) = git_output(["rev-parse", "--git-path", "hooks/commit-msg"]) else {
        return Check {
            ok: false,
            detail: "Git hookの場所を確認できませんでした".into(),
        };
    };
    match std::fs::read_to_string(path.trim()) {
        Ok(contents) if contents.contains("hk run commit-msg") => Check {
            ok: true,
            detail: "hk-managed hooks are installed".into(),
        },
        _ => Check {
            ok: false,
            detail: "hk hook is not installed; run `mise run setup`".into(),
        },
    }
}

fn is_hk_commit_msg_command(command: &str) -> bool {
    command.contains("hk") && command.contains("run commit-msg --from-hook")
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
        println!("command guard mode: {}", policy.command_guard.mode);
        println!("branch mode: {}", policy.branch.mode);
        println!(
            "presence: {} ({}s)",
            if policy.presence.enabled {
                "enabled"
            } else {
                "disabled"
            },
            policy.presence.interval_seconds
        );
        println!("max subject: {}", policy.commit.max_subject_length);
        println!("types: {}", policy.commit.allowed_types.join(", "));
    }
    Ok(())
}

fn guard(args: GuardArgs) -> Result<()> {
    match args.command {
        GuardCommands::Command {
            command,
            agent,
            json,
        } => guard_command(&command, agent, json),
        GuardCommands::Hook { agent } => guard_hook(agent),
    }
}

fn presence(args: PresenceArgs) -> Result<()> {
    let policy = Policy::load()?;
    match args.command {
        PresenceCommands::Snapshot { json } => {
            presence::snapshot(&policy.presence, None, None, json)
        }
        PresenceCommands::Publish {
            actor,
            device,
            dry_run,
            yes,
            json,
        } => presence::publish(&policy.presence, actor, device, dry_run, yes, json),
        PresenceCommands::Check { json } => presence::check(&policy.presence, json),
        PresenceCommands::Watch {
            actor,
            device,
            once,
            yes,
        } => presence::watch(&policy.presence, actor, device, once, yes),
        PresenceCommands::Install { yes, json } => scheduler::install(&policy.presence, yes, json),
        PresenceCommands::Status { json } => scheduler::status(&policy.presence, json),
        PresenceCommands::Uninstall { yes, json } => {
            scheduler::uninstall(&policy.presence, yes, json)
        }
    }
}

fn guard_command(command: &str, agent: GuardAgent, json: bool) -> Result<()> {
    let root = guard::repository_root()?;
    let policy = Policy::load()?;
    let result = guard::evaluate(command, &policy.command_guard);
    guard::record_telemetry(&result, agent.as_str(), &policy, &root);

    if json {
        println!("{}", serde_json::to_string_pretty(&result)?);
    } else {
        match result.decision {
            GuardDecision::Allow => println!("✓ コマンドは許可されています"),
            GuardDecision::Warn => print_guard_message(&result, "警告"),
            GuardDecision::Deny => print_guard_message(&result, "拒否"),
        }
    }

    if matches!(result.decision, GuardDecision::Deny) {
        Err(GuardDenied.into())
    } else {
        Ok(())
    }
}

fn guard_hook(agent: GuardAgent) -> Result<()> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .context("hook入力を読み込めませんでした")?;
    let hook_input: HookInput =
        serde_json::from_str(&input).context("hook入力は正しいJSONではありません")?;
    let Some(command) = hook_input.tool_input.command else {
        return Ok(());
    };

    let root = guard::repository_root()?;
    let policy = Policy::load()?;
    let result = guard::evaluate(&command, &policy.command_guard);
    guard::record_telemetry(&result, agent.as_str(), &policy, &root);
    let message = hook_message(&result);

    match result.decision {
        GuardDecision::Allow => Ok(()),
        GuardDecision::Warn => {
            println!(
                "{}",
                serde_json::to_string(&serde_json::json!({
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "additionalContext": message
                    }
                }))?
            );
            Ok(())
        }
        GuardDecision::Deny => {
            println!(
                "{}",
                serde_json::to_string(&serde_json::json!({
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": message
                    }
                }))?
            );
            Ok(())
        }
    }
}

fn print_guard_message(result: &guard::GuardResult, label: &str) {
    let code = result.error_code.unwrap_or("AR-TOOLCHAIN-000");
    let message = result
        .message_ja
        .as_deref()
        .unwrap_or("ツールチェーン規則を確認してください。");
    eprintln!("{code} [{label}]: {message}");
}

fn hook_message(result: &guard::GuardResult) -> String {
    format!(
        "{}: {}",
        result.error_code.unwrap_or("AR-TOOLCHAIN-000"),
        result
            .message_ja
            .as_deref()
            .unwrap_or("ツールチェーン規則を確認してください。")
    )
}

fn validate_commit_file(path: &Path) -> Result<()> {
    let message = std::fs::read_to_string(path)
        .with_context(|| format!("{}を読み込めませんでした", path.display()))?;
    let subject = message.lines().next().unwrap_or_default();
    let policy = Policy::load()?;
    let mut violations = policy.commit.violations(subject);
    let generated = subject.starts_with("Merge ")
        || subject.starts_with("Revert ")
        || subject.starts_with("fixup! ")
        || subject.starts_with("squash! ");
    if policy.commit.require_ar_trailer
        && !generated
        && !message
            .lines()
            .any(|line| line.trim() == "AR-Commit: git-ar/v1")
    {
        violations.push(
            "このリポジトリでは `git ar commit` を使ってください。\
             既に入力済みなら `git ar commit --type ... --summary ...` で作り直せます。"
                .into(),
        );
    }
    if violations.is_empty() || matches!(policy.commit.mode, ValidationMode::Off) {
        return Ok(());
    }

    for violation in &violations {
        eprintln!("arttra: {violation}");
    }
    match policy.commit.mode {
        ValidationMode::Off => Ok(()),
        ValidationMode::Warn => {
            eprintln!("arttra: 警告のみのためcommitを続行します");
            Ok(())
        }
        ValidationMode::Block => bail!("commit messageはART-TRAの規則により拒否されました"),
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

fn parse_issue_numbers(value: &str) -> Result<Vec<u64>> {
    value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            let number = value
                .trim_start_matches('#')
                .parse::<u64>()
                .with_context(|| format!("Issue番号`{value}`は整数ではありません"))?;
            if number == 0 {
                bail!("Issue番号は1以上で指定してください");
            }
            Ok(number)
        })
        .collect()
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
    use super::{IssueDraft, IssueKind, MergeMode, is_hk_commit_msg_command, parse_issue_numbers};

    #[test]
    fn issue_body_has_stable_sections() {
        let draft = IssueDraft {
            kind: IssueKind::Work,
            merge: Some(MergeMode::Review),
            title: "title".into(),
            background: "background".into(),
            goal: "goal".into(),
            done: "done".into(),
            parent: None,
            blocked_by: Vec::new(),
            blocking: Vec::new(),
            target_date: None,
        };
        assert_eq!(
            draft.body(),
            "## 背景\n\nbackground\n\n## 目的\n\ngoal\n\n## 完了条件\n\n- [ ] done\n\n## マージ方針\n\n`merge/review`\n"
        );
    }

    #[test]
    fn parses_comma_separated_issue_relationships() {
        assert_eq!(
            parse_issue_numbers("#12, 34,56").expect("valid issue numbers"),
            vec![12, 34, 56]
        );
        assert!(parse_issue_numbers("0").is_err());
        assert!(parse_issue_numbers("issue").is_err());
    }

    #[test]
    fn recognizes_hk_legacy_and_git_2_54_config_commands() {
        assert!(is_hk_commit_msg_command(
            r#"test "${HK:-1}" = "0" || mise x -- hk run commit-msg --from-hook"#
        ));
        assert!(is_hk_commit_msg_command(
            "exec mise x -- hk run commit-msg --from-hook \"$@\""
        ));
        assert!(!is_hk_commit_msg_command(
            "mise x -- hk run pre-commit --from-hook"
        ));
        assert!(!is_hk_commit_msg_command("some-unrelated-command"));
    }
}
