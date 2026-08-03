mod branch;
mod delivery;
mod governance;
mod guard;
mod policy;
mod presence;
mod scheduler;
mod setup;
mod status;
mod tasks;
mod telemetry;
mod tui;

use std::fmt;
use std::io::{self, IsTerminal, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use anyhow::{Context, Result, anyhow, bail};
use clap::{Args, Parser, Subcommand, ValueEnum};
use inquire::error::InquireError;
use inquire::validator::Validation;
use inquire::{Confirm, Select, Text};
use serde::{Deserialize, Serialize};

use crate::guard::{GuardDecision, GuardDenied};
use crate::policy::{Policy, ValidationMode};

const SETUP_MANUAL_URL: &str = "https://app.notion.com/p/3af8c19110bf81af8c5dcc1e0403bd38";
const MISE_MANUAL_URL: &str = "https://app.notion.com/p/3af8c19110bf81b0832bc3a18cfb909f";
const GH_AUTH_MANUAL_URL: &str = "https://app.notion.com/p/3af8c19110bf812a8f71f29486da997f";
const AI_MANUAL_URL: &str = "https://app.notion.com/p/3af8c19110bf818d911dc8cfa19ae0b7";

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
    /// Push the current work branch after showing the exact destination.
    Push(PushArgs),
    /// Build and optionally create a Pull Request.
    Pr(PullRequestArgs),
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
    /// Show the current work and the next recommended action.
    Status {
        /// Read this Issue instead of inferring it from the branch name.
        #[arg(long, value_parser = clap::value_parser!(u64).range(1..))]
        issue: Option<u64>,
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
    /// Show repository Rulesets and recent Rule Insights.
    Rules {
        /// Maximum number of recent rule suites.
        #[arg(long, default_value_t = 10, value_parser = clap::value_parser!(u8).range(1..=100))]
        limit: u8,
        /// Show one rule suite with per-rule evaluations.
        #[arg(long)]
        suite: Option<u64>,
        /// Return machine-readable output.
        #[arg(long)]
        json: bool,
    },
    /// Preview or apply the declared Organization Custom Properties.
    Properties {
        #[arg(long)]
        organization: String,
        #[arg(long, default_value = "governance/custom-properties.schema.json")]
        schema: PathBuf,
        /// Apply create/update operations. Omit to preview only.
        #[arg(long)]
        apply: bool,
        /// Explicitly request a preview without writes.
        #[arg(long)]
        dry_run: bool,
        /// Confirm Organization-level GitHub writes.
        #[arg(long)]
        yes: bool,
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
struct PushArgs {
    /// Git remote. Defaults to origin.
    #[arg(long)]
    remote: Option<String>,
    /// Show the push plan without writing to GitHub.
    #[arg(long)]
    dry_run: bool,
    /// Push without an interactive confirmation.
    #[arg(long)]
    yes: bool,
    /// Return the plan or result as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args, Default)]
struct PullRequestArgs {
    /// Pull Request title. Defaults to the related Issue or latest commit title.
    #[arg(long)]
    title: Option<String>,
    /// Pull Request body. A standard body is generated when omitted.
    #[arg(long)]
    body: Option<String>,
    /// Related GitHub Issue number. Defaults to the number in the branch name.
    #[arg(long)]
    issue: Option<u64>,
    /// Base branch. Defaults to the first protected branch.
    #[arg(long)]
    base: Option<String>,
    /// Create the Pull Request as a Draft.
    #[arg(long)]
    draft: bool,
    /// GitHub reviewer login. May be repeated.
    #[arg(long)]
    reviewer: Vec<String>,
    /// Create the Pull Request. Otherwise only preview it.
    #[arg(long)]
    create: bool,
    /// Create without an interactive confirmation.
    #[arg(long)]
    yes: bool,
    /// Return the draft or result as JSON.
    #[arg(long)]
    json: bool,
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
            Self::Intake => "相談・受付 — まだ整理できていない依頼やアイデア",
            Self::Work => "作業チケット — 単独で目的と完了条件を持つ仕事",
            Self::Task => "小タスク — 親Issueを分けた具体的な作業",
            Self::Business => "営業・業務変更 — 開発以外の提案・契約・運用作業",
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
            Self::Review => "通常レビュー — 他の人の承認後にマージする",
            Self::SelfMerge => "本人マージ可 — 権限がある本人がCI通過後にマージできる",
            Self::Emergency => "緊急マージ — 先に反映し、理由を残して事後確認する",
        })
    }
}

#[derive(Debug)]
struct ExplainedChoice<T> {
    value: T,
    name: String,
    description: &'static str,
}

impl<T> fmt::Display for ExplainedChoice<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} — {}", self.name, self.description)
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
    ai: Check,
    environment: ManagedEnvironmentCheck,
}

#[derive(Debug, Serialize)]
struct Check {
    ok: bool,
    detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    manual_url: Option<String>,
}

#[derive(Debug, Serialize)]
struct ManagedEnvironmentCheck {
    ok: bool,
    detail: String,
    mise_errors: Vec<String>,
    manual_url: String,
    commands: Vec<ManagedCommandCheck>,
}

#[derive(Debug, Serialize)]
struct ManagedCommandCheck {
    command: String,
    ok: bool,
    actual_path: Option<String>,
    mise_path: Option<String>,
    detail: String,
    fix_command: String,
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
        if matches!(
            error.downcast_ref::<InquireError>(),
            Some(InquireError::OperationCanceled | InquireError::OperationInterrupted)
        ) {
            eprintln!("arttra: 操作を終了しました");
            return;
        }
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
        Some(Commands::Push(args)) => push(args),
        Some(Commands::Pr(args)) => pull_request(args),
        Some(Commands::Branch(args)) => branch_command(args),
        Some(Commands::Issue(args)) => issue(args),
        Some(Commands::Context { json }) => context(json),
        Some(Commands::Status { issue, json }) => {
            status::show(issue, json, &Policy::load()?.branch)
        }
        Some(Commands::Policy { json }) => show_policy(json),
        Some(Commands::Guard(args)) => guard(args),
        Some(Commands::Presence(args)) => presence(args),
        Some(Commands::Tasks {
            json,
            open,
            dashboard,
        }) => tasks::show(json, open, dashboard, &Policy::load()?.tasks),
        Some(Commands::Telemetry { json }) => {
            let root = guard::repository_root()?;
            telemetry::report(&Policy::load()?, &root, json)
        }
        Some(Commands::Rules { limit, suite, json }) => governance::rules(limit, suite, json),
        Some(Commands::Properties {
            organization,
            schema,
            apply,
            dry_run,
            yes,
            json,
        }) => governance::properties(&organization, &schema, apply, dry_run, yes, json),
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
    let policy = Policy::load()?;
    let home = status::home(None, &policy.branch)?;
    let Some(action) = tui::run(&home)? else {
        return Ok(());
    };

    match action {
        tui::Action::Status => status::show(None, false, &policy.branch),
        tui::Action::Tasks => tasks::show(false, false, true, &policy.tasks),
        tui::Action::Issue => issue(IssueArgs::default()),
        tui::Action::Branch => branch_command(BranchArgs::default()),
        tui::Action::Commit => commit(CommitArgs::default()),
        tui::Action::Push => push(PushArgs::default()),
        tui::Action::PullRequest => pull_request(PullRequestArgs {
            create: true,
            ..PullRequestArgs::default()
        }),
        tui::Action::Presence => presence::check(&policy.presence, false),
        tui::Action::Check => check(false, false),
        tui::Action::Rules => governance::rules(10, None, false),
        tui::Action::Doctor => doctor(false),
        tui::Action::Context => context(false),
        tui::Action::Exit => Ok(()),
    }
}

fn commit(mut args: CommitArgs) -> Result<()> {
    let policy = Policy::load()?;
    let interactive = io::stdin().is_terminal();

    if args.kind.is_none() {
        ensure_interactive()?;
        args.kind = Some(
            Select::new(
                "変更の種類",
                policy
                    .commit
                    .allowed_types
                    .iter()
                    .cloned()
                    .map(|kind| ExplainedChoice {
                        description: commit_type_description(&kind),
                        name: kind.clone(),
                        value: kind,
                    })
                    .collect(),
            )
            .with_help_message("迷ったら、機能追加はfeat、不具合修正はfixを選びます")
            .prompt()?
            .value,
        );
    }
    if args.summary.is_none() {
        ensure_interactive()?;
        args.summary = Some(prompt_required_text(
            "変更内容（必須）",
            "日本語で構いません。例: 空白のcommit内容を拒否する",
        )?);
    }
    if interactive && args.scope.is_none() {
        let scope = Text::new("変更範囲 scope（任意）")
            .with_help_message("対象を短く指定します。例: cli / slack / docs。迷ったら空欄")
            .prompt()?;
        if !scope.trim().is_empty() {
            args.scope = Some(scope.trim().into());
        }
    }
    if interactive && args.issue.is_none() {
        args.issue = prompt_optional_issue_number(
            "関連Issue番号（任意）",
            "例: 71。Issueがない小さな作業なら空欄にできます",
        )?;
    }

    let kind = required(args.kind, "--type", "変更の種類")?;
    let summary = required(args.summary, "--summary", "変更内容")?;
    let subject = match args
        .scope
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
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

fn push(args: PushArgs) -> Result<()> {
    let policy = Policy::load()?;
    let plan = delivery::build_push_plan(&policy.branch, args.remote.as_deref())?;

    if args.json {
        if args.dry_run || !args.yes {
            println!("{}", serde_json::to_string_pretty(&plan)?);
            return Ok(());
        }
        delivery::execute_push(&plan)?;
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "schema_version": 1,
                "ok": true,
                "action": "push",
                "plan": plan,
            }))?
        );
        return Ok(());
    }

    println!("[PUSH] GitHubへの送信準備");
    println!("  branch: {}", plan.branch);
    println!("  送信先: {}", plan.remote);
    match plan.commits_to_push {
        Some(count) => println!("  送信予定: {count} commit"),
        None => println!("  送信予定: 初回push（GitHub上にbranchを作成）"),
    }
    if plan.uncommitted_files > 0 {
        println!(
            "  WARN  未commit: {}ファイル（このpushには含まれません）",
            plan.uncommitted_files
        );
    }
    println!("  実行内容: {}", plan.command.join(" "));

    if args.dry_run {
        return Ok(());
    }
    if !args.yes {
        ensure_interactive()?;
        if !Confirm::new("このbranchをGitHubへpushしますか？")
            .with_default(false)
            .with_help_message("force pushは行いません")
            .prompt()?
        {
            return Ok(());
        }
    }
    delivery::execute_push(&plan)?;
    println!("✓ GitHubへpushしました: {}", plan.branch);
    Ok(())
}

fn pull_request(mut args: PullRequestArgs) -> Result<()> {
    let policy = Policy::load()?;
    let interactive = io::stdin().is_terminal();
    let branch = branch::current_branch()?;
    args.issue = args
        .issue
        .or_else(|| delivery::issue_number_from_branch(&branch));

    let guided = interactive && args.title.is_none();
    if guided {
        let suggested = delivery::suggested_pull_request_title(args.issue)?;
        args.title = Some(
            Text::new("Pull Requestタイトル（必須）")
                .with_default(&suggested)
                .with_help_message("何を変え、何が良くなるかを一文で書きます")
                .with_validator(non_blank_validator)
                .prompt()?,
        );
        args.draft = Confirm::new("作業途中のDraft Pull Requestにしますか？")
            .with_default(true)
            .with_help_message("Draftなら早めに共有でき、完成までレビュー要求を保留できます")
            .prompt()?;
        let reviewers = Text::new("reviewerのGitHubユーザー名（任意、カンマ区切り）")
            .with_help_message("空欄ならCODEOWNERSやIssueの方針に従って自動選定されます")
            .prompt()?;
        args.reviewer = reviewers
            .split(',')
            .map(str::trim)
            .filter(|reviewer| !reviewer.is_empty())
            .map(ToOwned::to_owned)
            .collect();
    }

    let draft = delivery::build_pull_request_draft(
        &policy.branch,
        args.title,
        args.body,
        args.issue,
        args.base,
        args.draft,
        args.reviewer,
    )?;

    if args.json && (!args.create || !args.yes) {
        println!("{}", serde_json::to_string_pretty(&draft)?);
        return Ok(());
    }
    if !args.json {
        println!("[PULL REQUEST] 作成準備");
        println!("  branch: {} → {}", draft.branch, draft.base);
        match draft.issue {
            Some(issue) => println!("  関連Issue: #{issue}"),
            None => println!("  関連Issue: なし"),
        }
        println!(
            "  状態: {}",
            if draft.draft {
                "Draft"
            } else {
                "レビュー可能"
            }
        );
        println!("  タイトル: {}", draft.title);
        if let Some(count) = draft.commits_ahead_of_base {
            println!("  含まれるcommit: {count}件");
        }
        if draft.uncommitted_files > 0 {
            println!(
                "  WARN  未commit: {}ファイル（PRにはまだ含まれません）",
                draft.uncommitted_files
            );
        }
        if !draft.reviewers.is_empty() {
            println!("  reviewer: {}", draft.reviewers.join(", "));
        }
    }

    if !args.create {
        return Ok(());
    }
    if !args.yes {
        ensure_interactive()?;
        if !Confirm::new("この内容でPull Requestを作成しますか？")
            .with_default(false)
            .prompt()?
        {
            return Ok(());
        }
    }

    let url = delivery::create_pull_request(&draft)?;
    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "schema_version": 1,
                "ok": true,
                "action": "pull-request-created",
                "url": url,
                "draft": draft,
            }))?
        );
    } else {
        println!("✓ Pull Requestを作成しました: {url}");
    }
    Ok(())
}

fn branch_command(mut args: BranchArgs) -> Result<()> {
    let policy = Policy::load()?;
    let interactive = io::stdin().is_terminal();
    if args.kind.is_none() {
        ensure_interactive()?;
        args.kind = Some(
            Select::new(
                "branchの種類",
                policy
                    .branch
                    .allowed_types
                    .iter()
                    .cloned()
                    .map(|kind| ExplainedChoice {
                        description: branch_type_description(&kind),
                        name: kind.clone(),
                        value: kind,
                    })
                    .collect(),
            )
            .with_help_message("通常の機能追加はfeature、不具合修正はfixを選びます")
            .prompt()?
            .value,
        );
    }
    if args.issue.is_none() {
        ensure_interactive()?;
        args.issue = Some(prompt_required_issue_number(
            "関連Issue番号（必須）",
            "このbranchで対応するIssue番号です。例: 71",
        )?);
    }
    if args.slug.is_none() {
        ensure_interactive()?;
        args.slug = Some(prompt_required_text(
            "作業内容（英数字）",
            "短い英単語で入力します。例: tui content help（空白は-になります）",
        )?);
    }
    if args.owner.is_none() {
        ensure_interactive()?;
        let default_owner = branch::detect_owner();
        args.owner = Some(
            Text::new("担当者（GitHubのユーザー名）")
                .with_default(&default_owner)
                .with_help_message("通常は自動入力された値のままで構いません")
                .with_validator(non_blank_validator)
                .prompt()?,
        );
    }
    if interactive && args.from.is_none() {
        let from = Text::new("作成元branch（任意。空欄はGitHubのdefault branch）").prompt()?;
        if !from.trim().is_empty() {
            args.from = Some(from);
        }
    }

    let draft = branch::draft(
        &policy.branch,
        required(args.kind, "--type", "branchの種類")?,
        args.issue.ok_or_else(|| {
            anyhow!("関連Issue番号が必要です。`--issue <番号>`を指定してください")
        })?,
        required(args.slug, "--slug", "作業内容")?,
        required(args.owner, "--owner", "担当者")?,
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
            .with_help_message("迷ったら、完了条件が決まっている仕事は作業チケットを選びます")
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
            .with_help_message("速さだけでなく、変更の影響と権限に合わせて選びます")
            .prompt()?,
        );
    }
    let merge = kind
        .needs_merge_policy()
        .then_some(args.merge.unwrap_or(MergeMode::Review));
    if args.title.is_none() {
        ensure_interactive()?;
        args.title = Some(prompt_required_text(
            "Issueタイトル（必須）",
            "何を実現する仕事かを一文で書きます。例: Slackから営業Issueを登録できるようにする",
        )?);
    }
    if args.background.is_none() {
        ensure_interactive()?;
        args.background = Some(prompt_required_text(
            "背景（必須）",
            "なぜ今この仕事が必要なのかを書きます。例: 営業担当がGitHubを開かず依頼したい",
        )?);
    }
    if args.goal.is_none() {
        ensure_interactive()?;
        args.goal = Some(prompt_required_text(
            "目的（必須）",
            "完了後に誰がどう助かるかを書きます。例: Slack内で依頼登録を完結できる",
        )?);
    }
    if args.done.is_none() {
        ensure_interactive()?;
        args.done = Some(prompt_required_text(
            "完了条件（必須）",
            "確認できる状態を書きます。例: /ar newからIssueが1件作成される",
        )?);
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
        args.parent = prompt_optional_issue_number(
            "親Issue番号（任意）",
            "このIssueをまとめる上位Issueです。例: 60",
        )?;
        args.blocked_by = parse_issue_numbers(
            &Text::new("先に終わる必要があるIssue（任意、カンマ区切り）")
                .with_help_message("このIssueを止めている仕事です。例: 12, 34")
                .prompt()?,
        )?;
        args.blocking = parse_issue_numbers(
            &Text::new("このIssueの完了を待っているIssue（任意、カンマ区切り）")
                .with_help_message("このIssueが止めている後続の仕事です。例: 56")
                .prompt()?,
        )?;
        let target_date = Text::new("目標日 YYYY-MM-DD（任意）")
            .with_help_message("GitHub Projectsと自分のカレンダーへ反映されます。例: 2026-08-05")
            .prompt()?;
        if !target_date.trim().is_empty() {
            args.target_date = Some(target_date.trim().to_owned());
        }
    }

    let draft = IssueDraft {
        kind,
        merge,
        title: required(args.title, "--title", "Issueタイトル")?,
        background: required(args.background, "--background", "背景")?,
        goal: required(args.goal, "--goal", "目的")?,
        done: required(args.done, "--done", "完了条件")?,
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
    let ai = match &root {
        Ok(root) => check_result(
            setup::check_ai_settings(Path::new(root)),
            |detail| detail,
            Some(AI_MANUAL_URL),
        ),
        Err(error) => Check {
            ok: false,
            detail: format!("AI設定を確認するrepositoryを判定できませんでした: {error:#}"),
            manual_url: Some(AI_MANUAL_URL.into()),
        },
    };
    let environment = match Policy::load() {
        Ok(policy) => managed_environment_check(&policy.doctor.managed_commands),
        Err(error) => ManagedEnvironmentCheck {
            ok: false,
            detail: format!("arttra.tomlを読み込めませんでした: {error:#}"),
            mise_errors: Vec::new(),
            manual_url: SETUP_MANUAL_URL.into(),
            commands: Vec::new(),
        },
    };
    let report = DoctorReport {
        repository: check_result(root, |value| format!("repository: {value}"), None),
        hooks: hook_check(),
        git_ar: command_check("git-ar", ["--version"], Some(SETUP_MANUAL_URL)),
        mise: command_check("mise", ["--version"], Some(MISE_MANUAL_URL)),
        gh: command_check("gh", ["auth", "status"], Some(GH_AUTH_MANUAL_URL)),
        ai,
        environment,
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
            ("AI設定", &report.ai),
            (
                "mise環境",
                &Check {
                    ok: report.environment.ok,
                    detail: report.environment.detail.clone(),
                    manual_url: Some(report.environment.manual_url.clone()),
                },
            ),
        ] {
            println!(
                "{} {name}: {}",
                if check.ok { "✓" } else { "✗" },
                check.detail
            );
            if !check.ok
                && let Some(url) = &check.manual_url
            {
                println!("  マニュアル: {url}");
            }
        }
        for error in &report.environment.mise_errors {
            println!("  ✗ mise: {error}");
        }
        for command in report
            .environment
            .commands
            .iter()
            .filter(|command| !command.ok)
        {
            println!("  ✗ {}: {}", command.command, command.detail);
        }
    }

    if [
        &report.repository,
        &report.hooks,
        &report.git_ar,
        &report.mise,
        &report.gh,
        &report.ai,
    ]
    .iter()
    .all(|check| check.ok)
        && report.environment.ok
    {
        Ok(())
    } else {
        bail!("doctor found setup problems")
    }
}

fn managed_environment_check(commands: &[String]) -> ManagedEnvironmentCheck {
    let mise_doctor = mise_doctor_state();
    let checks = commands
        .iter()
        .map(|command| managed_command_check(command, mise_doctor.shims.as_deref()))
        .collect::<Vec<_>>();
    let failures = checks.iter().filter(|check| !check.ok).count();
    let mise_failures = mise_doctor.errors.len();
    ManagedEnvironmentCheck {
        ok: failures == 0 && mise_failures == 0,
        detail: if commands.is_empty() {
            "検査対象は設定されていません".into()
        } else if failures == 0 && mise_failures == 0 {
            format!("{}個のコマンドがmise管理下です", checks.len())
        } else {
            format!(
                "コマンドの不一致が{failures}個、mise本体の環境問題が{mise_failures}個あります。表示された修正方法を実行してください"
            )
        },
        mise_errors: mise_doctor.errors,
        manual_url: MISE_MANUAL_URL.into(),
        commands: checks,
    }
}

fn managed_command_check(command: &str, mise_shims: Option<&Path>) -> ManagedCommandCheck {
    let fix_command = format!("mise install && mise reshim && mise run doctor # {command}");
    let mise_path = Command::new("mise")
        .args(["which", command])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            (!path.is_empty()).then(|| PathBuf::from(path))
        });
    let actual_path = resolve_executable(command);

    let (ok, detail) = match (&actual_path, &mise_path) {
        (Some(actual), Some(expected)) if path_is_mise_managed(actual, expected, mise_shims) => {
            (true, format!("{}はmise管理下です", actual.display()))
        }
        (Some(actual), Some(expected)) => (
            false,
            format!(
                "現在は{}を使用しますが、mise指定版は{}です。`{fix_command}`を実行し、terminalとIDEを開き直してください",
                actual.display(),
                expected.display()
            ),
        ),
        (None, Some(expected)) => (
            false,
            format!(
                "PATHから見つかりません。mise指定版は{}です。`{fix_command}`を実行してください",
                expected.display()
            ),
        ),
        (_, None) => (
            false,
            format!(
                "`mise which {command}`で指定版を確認できません。`{fix_command}`を実行してください"
            ),
        ),
    };

    ManagedCommandCheck {
        command: command.into(),
        ok,
        actual_path: actual_path.map(|path| path.display().to_string()),
        mise_path: mise_path.map(|path| path.display().to_string()),
        detail,
        fix_command,
    }
}

#[derive(Default)]
struct MiseDoctorState {
    shims: Option<PathBuf>,
    errors: Vec<String>,
}

fn mise_doctor_state() -> MiseDoctorState {
    let Ok(output) = Command::new("mise").args(["doctor", "--json"]).output() else {
        return MiseDoctorState {
            shims: None,
            errors: vec![
                "mise doctorを起動できませんでした。mise本体の導入を確認してください".into(),
            ],
        };
    };
    let Ok(report) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else {
        return MiseDoctorState {
            shims: None,
            errors: vec![
                "mise doctorの結果を読み取れませんでした。`mise doctor`を直接実行してください"
                    .into(),
            ],
        };
    };
    let shims = report
        .pointer("/dirs/shims")
        .and_then(serde_json::Value::as_str)
        .map(PathBuf::from);
    let errors = report
        .pointer("/errors")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(translate_mise_error)
        .collect();
    MiseDoctorState { shims, errors }
}

fn translate_mise_error(error: &str) -> String {
    if error.contains("shims are on PATH") && error.contains("mise is also activated") {
        "miseのshimsとshell activationが同時にPATHへ入っています。どちらか一方に統一し、terminalとIDEを開き直してください"
            .into()
    } else {
        format!("mise doctor: {error}")
    }
}

fn resolve_executable(command: &str) -> Option<PathBuf> {
    let command_path = Path::new(command);
    if command_path.components().count() > 1 {
        return command_path.is_file().then(|| command_path.to_path_buf());
    }
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        for candidate in executable_candidates(&directory, command) {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn executable_candidates(directory: &Path, command: &str) -> Vec<PathBuf> {
    let direct = directory.join(command);
    #[cfg(not(windows))]
    {
        vec![direct]
    }
    #[cfg(windows)]
    {
        if Path::new(command).extension().is_some() {
            return vec![direct];
        }
        let extensions = std::env::var_os("PATHEXT")
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into());
        extensions
            .split(';')
            .filter(|extension| !extension.is_empty())
            .map(|extension| directory.join(format!("{command}{extension}")))
            .collect()
    }
}

fn path_is_mise_managed(actual: &Path, expected: &Path, mise_shims: Option<&Path>) -> bool {
    let normalize = |path: &Path| path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if normalize(actual) == normalize(expected) {
        return true;
    }
    if mise_shims
        .is_some_and(|shims| normalize(actual.parent().unwrap_or(actual)) == normalize(shims))
    {
        return true;
    }

    expected.ancestors().any(|ancestor| {
        ancestor.file_name().is_some_and(|name| name == "installs")
            && ancestor.parent().is_some_and(|data_dir| {
                normalize(actual.parent().unwrap_or(actual)) == normalize(&data_dir.join("shims"))
            })
    })
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
            detail: "hk管理のGit hookが有効です".into(),
            manual_url: None,
        };
    }

    if let Ok(value) = git_output(["config", "--local", "--get", "core.hooksPath"])
        && !value.trim().is_empty()
    {
        return Check {
            ok: false,
            detail: format!(
                "独自のcore.hooksPath={}があります。上書きせず、マニュアルを確認してください",
                value.trim()
            ),
            manual_url: Some(SETUP_MANUAL_URL.into()),
        };
    }
    let Ok(path) = git_output(["rev-parse", "--git-path", "hooks/commit-msg"]) else {
        return Check {
            ok: false,
            detail: "Git hookの場所を確認できませんでした".into(),
            manual_url: Some(SETUP_MANUAL_URL.into()),
        };
    };
    match std::fs::read_to_string(path.trim()) {
        Ok(contents) if contents.contains("hk run commit-msg") => Check {
            ok: true,
            detail: "hk管理のGit hookが有効です".into(),
            manual_url: None,
        },
        _ => Check {
            ok: false,
            detail: "Git hookが未導入です。`mise run setup-ar`を実行してください".into(),
            manual_url: Some(SETUP_MANUAL_URL.into()),
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
        bail!(
            "対話入力を使えません。AIや自動処理では必要な引数と書き込み確認の`--yes`を指定してください"
        )
    }
}

fn required(value: Option<String>, flag: &str, label: &str) -> Result<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("{label}は空にできません。`{flag} <内容>`を指定してください"))
}

fn prompt_required_text(prompt: &str, help: &str) -> Result<String> {
    Ok(Text::new(prompt)
        .with_help_message(help)
        .with_validator(non_blank_validator)
        .prompt()?
        .trim()
        .to_owned())
}

fn prompt_required_issue_number(prompt: &str, help: &str) -> Result<u64> {
    let value = Text::new(prompt)
        .with_help_message(help)
        .with_validator(required_issue_number_validator)
        .prompt()?;
    value
        .trim()
        .parse()
        .context("Issue番号は1以上の整数で指定してください")
}

fn prompt_optional_issue_number(prompt: &str, help: &str) -> Result<Option<u64>> {
    let value = Text::new(prompt)
        .with_help_message(help)
        .with_validator(optional_issue_number_validator)
        .prompt()?;
    let value = value.trim();
    if value.is_empty() {
        Ok(None)
    } else {
        Ok(Some(
            value
                .parse()
                .context("Issue番号は1以上の整数で指定してください")?,
        ))
    }
}

fn non_blank_validator(
    input: &str,
) -> std::result::Result<Validation, inquire::error::CustomUserError> {
    Ok(if input.trim().is_empty() {
        Validation::Invalid("入力が空です。具体的な内容を1文字以上入力してください".into())
    } else {
        Validation::Valid
    })
}

fn required_issue_number_validator(
    input: &str,
) -> std::result::Result<Validation, inquire::error::CustomUserError> {
    Ok(match input.trim().parse::<u64>() {
        Ok(number) if number > 0 => Validation::Valid,
        _ => Validation::Invalid("Issue番号を1以上の整数で入力してください。例: 71".into()),
    })
}

fn optional_issue_number_validator(
    input: &str,
) -> std::result::Result<Validation, inquire::error::CustomUserError> {
    let input = input.trim();
    Ok(
        if input.is_empty() || input.parse::<u64>().is_ok_and(|number| number > 0) {
            Validation::Valid
        } else {
            Validation::Invalid("空欄または1以上の整数を入力してください。例: 71".into())
        },
    )
}

fn commit_type_description(kind: &str) -> &'static str {
    match kind {
        "feat" => "新しい機能を追加する",
        "fix" => "不具合を修正する",
        "docs" => "文書だけを変更する",
        "refactor" => "動作を変えず内部構造を改善する",
        "test" => "テストを追加・修正する",
        "build" => "依存関係やビルド方法を変更する",
        "ci" => "CI/CDや自動化を変更する",
        "chore" => "保守作業や雑務を行う",
        "revert" => "過去の変更を取り消す",
        _ => "このリポジトリで定義された変更種別",
    }
}

fn branch_type_description(kind: &str) -> &'static str {
    match kind {
        "feature" => "新しい機能を作る通常の作業",
        "fix" => "不具合を修正する通常の作業",
        "hotfix" => "本番障害などを緊急修正する",
        "chore" => "依存更新や保守作業を行う",
        "docs" => "文書だけを変更する",
        "refactor" => "動作を変えず内部構造を改善する",
        "test" => "テストだけを追加・修正する",
        "release" => "リリース準備をまとめる",
        _ => "このリポジトリで定義されたbranch種別",
    }
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

fn command_check<const N: usize>(
    program: &str,
    args: [&str; N],
    manual_url: Option<&str>,
) -> Check {
    match Command::new(program).args(args).output() {
        Ok(output) if output.status.success() => Check {
            ok: true,
            detail: first_output_line(&output),
            manual_url: None,
        },
        Ok(output) => Check {
            ok: false,
            detail: first_output_line(&output),
            manual_url: manual_url.map(str::to_owned),
        },
        Err(error) => Check {
            ok: false,
            detail: error.to_string(),
            manual_url: manual_url.map(str::to_owned),
        },
    }
}

fn check_result<F>(result: Result<String>, format: F, manual_url: Option<&str>) -> Check
where
    F: FnOnce(String) -> String,
{
    match result {
        Ok(value) => Check {
            ok: true,
            detail: format(value),
            manual_url: None,
        },
        Err(error) => Check {
            ok: false,
            detail: error.to_string(),
            manual_url: manual_url.map(str::to_owned),
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
    use std::path::Path;

    use super::{
        IssueDraft, IssueKind, MergeMode, branch_type_description, commit_type_description,
        is_hk_commit_msg_command, parse_issue_numbers, path_is_mise_managed, required,
    };

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
    fn required_text_rejects_empty_and_whitespace_values() {
        assert!(required(None, "--summary", "変更内容").is_err());
        assert!(required(Some("   ".into()), "--summary", "変更内容").is_err());
        assert_eq!(
            required(Some("  内容  ".into()), "--summary", "変更内容").expect("non-blank value"),
            "内容"
        );
    }

    #[test]
    fn common_git_types_have_japanese_explanations() {
        assert_eq!(commit_type_description("feat"), "新しい機能を追加する");
        assert_eq!(commit_type_description("fix"), "不具合を修正する");
        assert_eq!(
            branch_type_description("feature"),
            "新しい機能を作る通常の作業"
        );
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

    #[test]
    fn recognizes_mise_install_and_its_shim_but_rejects_foreign_paths() {
        let expected = Path::new("/example/mise/installs/gh/2.97.0/bin/gh");
        let shims = Path::new("/example/mise/shims");
        assert!(path_is_mise_managed(expected, expected, Some(shims)));
        assert!(path_is_mise_managed(
            Path::new("/example/mise/shims/gh"),
            expected,
            Some(shims)
        ));
        assert!(!path_is_mise_managed(
            Path::new("/usr/local/bin/gh"),
            expected,
            Some(shims)
        ));
    }
}
