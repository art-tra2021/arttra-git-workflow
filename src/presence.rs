use std::collections::BTreeMap;
use std::env;
use std::fs::{create_dir_all, read_to_string, write};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::policy::PresencePolicy;

const SNAPSHOT_PATH: &str = "presence.json";
const DEVICE_ID_PATH: &str = ".arttra/local/presence-device";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresenceSnapshot {
    schema_version: u32,
    repository: String,
    actor: String,
    device: String,
    branch: String,
    head: Option<String>,
    observed_at_unix_ms: u128,
    files: Vec<FileActivity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FileActivity {
    path: String,
    committed: bool,
    staged: bool,
    unstaged: bool,
    untracked: bool,
}

#[derive(Debug, Serialize)]
struct PublishPreview {
    target_ref: String,
    snapshot: PresenceSnapshot,
}

#[derive(Debug, Serialize)]
struct PresenceReport {
    schema_version: u32,
    generated_at_unix_ms: u128,
    local: PresenceSnapshot,
    peers: Vec<PresenceSnapshot>,
    overlaps: Vec<FileOverlap>,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
struct FileOverlap {
    path: String,
    risk: OverlapRisk,
    participants: Vec<Participant>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum OverlapRisk {
    Uncommitted,
    Branch,
}

#[derive(Debug, Clone, Serialize)]
struct Participant {
    actor: String,
    device: String,
    branch: String,
    local: bool,
}

pub fn snapshot(
    policy: &PresencePolicy,
    actor: Option<String>,
    device: Option<String>,
    json: bool,
) -> Result<()> {
    let snapshot = collect_snapshot(policy, actor, device)?;
    print_snapshot(&snapshot, json)
}

pub fn publish(
    policy: &PresencePolicy,
    actor: Option<String>,
    device: Option<String>,
    dry_run: bool,
    yes: bool,
    json: bool,
) -> Result<()> {
    if !policy.enabled && !dry_run {
        bail!(
            "presence共有は無効です。試す場合は`git ar presence publish --dry-run`、有効化する場合はarttra.tomlのpresence.enabledをtrueにしてください"
        );
    }
    if !dry_run && !yes {
        bail!(
            "GitHubへpresence情報を書き込むには`--yes`を指定してください。送信内容の確認だけなら`--dry-run`を使えます"
        );
    }

    let snapshot = collect_snapshot(policy, actor, device)?;
    let target_ref = target_ref(policy, &snapshot.actor, &snapshot.device)?;
    if dry_run {
        if json {
            println!(
                "{}",
                serde_json::to_string_pretty(&PublishPreview {
                    target_ref,
                    snapshot
                })?
            );
        } else {
            println!("送信先: {target_ref}");
            print_snapshot(&snapshot, false)?;
            println!("dry-run: GitHubへは送信していません");
        }
        return Ok(());
    }

    let payload = serde_json::to_vec_pretty(&snapshot)?;
    let blob = git_with_input(&["hash-object", "-w", "--stdin"], &payload)?;
    let tree_line = format!("100644 blob {blob}\t{SNAPSHOT_PATH}\n");
    let tree = git_with_input(&["mktree"], tree_line.as_bytes())?;

    let mut commit_command = Command::new("git");
    commit_command
        .args(["commit-tree", &tree])
        .env("GIT_AUTHOR_NAME", "git-ar presence")
        .env("GIT_AUTHOR_EMAIL", "presence@art-tra.local")
        .env("GIT_COMMITTER_NAME", "git-ar presence")
        .env("GIT_COMMITTER_EMAIL", "presence@art-tra.local")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let commit = command_with_input(commit_command, b"update presence\n", "git commit-tree")?;

    let source_and_target = format!("{commit}:{target_ref}");
    let output = network_git()
        .args([
            "push",
            "--force",
            "--quiet",
            &policy.remote,
            &source_and_target,
        ])
        .output()
        .context("presence情報をGit remoteへ送信できませんでした")?;
    ensure_success(&output, "git push")?;

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&PublishPreview {
                target_ref,
                snapshot
            })?
        );
    } else {
        println!(
            "✓ {}件の変更ファイル情報を{}へ共有しました",
            snapshot.files.len(),
            target_ref
        );
    }
    Ok(())
}

pub fn check(policy: &PresencePolicy, json: bool) -> Result<()> {
    if !policy.enabled {
        bail!(
            "presence共有は無効です。arttra.tomlのpresence.enabledをtrueにしてから実行してください"
        );
    }

    let local = collect_snapshot(policy, None, None)?;
    let refspec = format!(
        "+refs/heads/{}/*:refs/ar/presence/*",
        policy.ref_prefix.trim_end_matches('/')
    );
    let output = network_git()
        .args(["fetch", "--prune", "--no-tags", &policy.remote, &refspec])
        .output()
        .context("presence情報をGit remoteから取得できませんでした")?;
    ensure_success(&output, "git fetch")?;

    let refs = git(&[
        "for-each-ref",
        "--format=%(objectname)",
        "refs/ar/presence/",
    ])?;
    let now = now_ms();
    let max_age_ms = u128::from(policy.max_age_minutes) * 60_000;
    let mut peers = Vec::new();
    let mut warnings = Vec::new();

    for object_id in refs.lines().filter(|line| !line.trim().is_empty()) {
        let object_path = format!("{}:{SNAPSHOT_PATH}", object_id.trim());
        let output = Command::new("git").args(["show", &object_path]).output();
        let contents = match output {
            Ok(output) if output.status.success() => output.stdout,
            Ok(_) => {
                warnings.push(format!("{object_id}のpresence情報を読めませんでした"));
                continue;
            }
            Err(error) => {
                warnings.push(format!(
                    "{object_id}のpresence情報を読めませんでした: {error}"
                ));
                continue;
            }
        };
        let peer: PresenceSnapshot = match serde_json::from_slice(&contents) {
            Ok(peer) => peer,
            Err(error) => {
                warnings.push(format!("{object_id}のpresence JSONが不正です: {error}"));
                continue;
            }
        };
        if peer.repository != local.repository
            || (peer.actor == local.actor && peer.device == local.device)
            || now.saturating_sub(peer.observed_at_unix_ms) > max_age_ms
        {
            continue;
        }
        peers.push(peer);
    }

    peers.sort_by(|left, right| {
        (&left.actor, &left.device, &left.branch).cmp(&(&right.actor, &right.device, &right.branch))
    });
    let overlaps = find_overlaps(&local, &peers);
    let report = PresenceReport {
        schema_version: 1,
        generated_at_unix_ms: now,
        local,
        peers,
        overlaps,
        warnings,
    };
    print_report(&report, json)
}

pub fn watch(
    policy: &PresencePolicy,
    actor: Option<String>,
    device: Option<String>,
    once: bool,
    yes: bool,
) -> Result<()> {
    if !policy.enabled {
        bail!(
            "presence共有は無効です。arttra.tomlのpresence.enabledをtrueにしてから実行してください"
        );
    }
    if !yes {
        bail!("定期的なGitHub書き込みを開始するには`--yes`を指定してください");
    }
    loop {
        if let Err(error) = publish(policy, actor.clone(), device.clone(), false, true, false) {
            if once {
                return Err(error);
            }
            eprintln!("arttra: presence共有に失敗しました: {error:#}");
        }
        if once {
            return Ok(());
        }
        thread::sleep(Duration::from_secs(policy.interval_seconds.max(30)));
    }
}

fn collect_snapshot(
    policy: &PresencePolicy,
    actor: Option<String>,
    device: Option<String>,
) -> Result<PresenceSnapshot> {
    let root = git(&["rev-parse", "--show-toplevel"])?;
    let remote = git(&["remote", "get-url", &policy.remote]).unwrap_or_default();
    let branch = git(&["branch", "--show-current"]).unwrap_or_default();
    let head = git(&["rev-parse", "HEAD"]).ok();
    let actor = actor
        .map(|value| safe_segment(&value))
        .transpose()?
        .unwrap_or(detect_actor()?);
    let device = device
        .map(|value| safe_segment(&value))
        .transpose()?
        .unwrap_or(load_or_create_device_id(Path::new(&root))?);

    let mut files = BTreeMap::<String, FileActivity>::new();
    mark_files(
        &mut files,
        git_bytes(&["diff", "--name-only", "-z"])?,
        FileState::Unstaged,
    );
    mark_files(
        &mut files,
        git_bytes(&["diff", "--cached", "--name-only", "-z"])?,
        FileState::Staged,
    );
    mark_files(
        &mut files,
        git_bytes(&["ls-files", "--others", "--exclude-standard", "-z"])?,
        FileState::Untracked,
    );
    if head.is_some()
        && let Some(base) = default_branch_ref(&policy.remote)
        && let Ok(merge_base) = git(&["merge-base", "HEAD", &base])
    {
        let range = format!("{merge_base}..HEAD");
        if let Ok(output) = git_bytes(&["diff", "--name-only", "-z", &range]) {
            mark_files(&mut files, output, FileState::Committed);
        }
    }

    Ok(PresenceSnapshot {
        schema_version: 1,
        repository: repository_key(&remote, &root),
        actor,
        device,
        branch: if branch.is_empty() {
            "(detached)".into()
        } else {
            branch
        },
        head,
        observed_at_unix_ms: now_ms(),
        files: files.into_values().collect(),
    })
}

fn default_branch_ref(remote: &str) -> Option<String> {
    let symbolic = format!("refs/remotes/{remote}/HEAD");
    if let Ok(reference) = git(&["symbolic-ref", "--quiet", "--short", &symbolic]) {
        return Some(reference);
    }
    for name in ["main", "master"] {
        let reference = format!("refs/remotes/{remote}/{name}");
        if Command::new("git")
            .args(["rev-parse", "--verify", "--quiet", &reference])
            .status()
            .is_ok_and(|status| status.success())
        {
            return Some(reference);
        }
    }
    None
}

#[derive(Clone, Copy)]
enum FileState {
    Committed,
    Staged,
    Unstaged,
    Untracked,
}

fn mark_files(files: &mut BTreeMap<String, FileActivity>, output: Vec<u8>, state: FileState) {
    for raw_path in output
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
    {
        let path = String::from_utf8_lossy(raw_path).into_owned();
        let activity = files.entry(path.clone()).or_insert(FileActivity {
            path,
            committed: false,
            staged: false,
            unstaged: false,
            untracked: false,
        });
        match state {
            FileState::Committed => activity.committed = true,
            FileState::Staged => activity.staged = true,
            FileState::Unstaged => activity.unstaged = true,
            FileState::Untracked => activity.untracked = true,
        }
    }
}

fn find_overlaps(local: &PresenceSnapshot, peers: &[PresenceSnapshot]) -> Vec<FileOverlap> {
    let mut paths = BTreeMap::<String, (bool, Vec<Participant>)>::new();
    add_participant_files(&mut paths, local, true);
    for peer in peers {
        add_participant_files(&mut paths, peer, false);
    }
    let mut overlaps = paths
        .into_iter()
        .filter_map(|(path, (has_uncommitted, participants))| {
            (participants.len() > 1).then_some(FileOverlap {
                path,
                risk: if has_uncommitted {
                    OverlapRisk::Uncommitted
                } else {
                    OverlapRisk::Branch
                },
                participants,
            })
        })
        .collect::<Vec<_>>();
    overlaps.sort_by_key(|overlap| {
        (
            !matches!(overlap.risk, OverlapRisk::Uncommitted),
            overlap.path.clone(),
        )
    });
    overlaps
}

fn add_participant_files(
    paths: &mut BTreeMap<String, (bool, Vec<Participant>)>,
    snapshot: &PresenceSnapshot,
    local: bool,
) {
    let participant = Participant {
        actor: snapshot.actor.clone(),
        device: snapshot.device.clone(),
        branch: snapshot.branch.clone(),
        local,
    };
    for file in &snapshot.files {
        let entry = paths
            .entry(file.path.clone())
            .or_insert_with(|| (false, Vec::new()));
        entry.0 |= file.staged || file.unstaged || file.untracked;
        entry.1.push(participant.clone());
    }
}

fn print_snapshot(snapshot: &PresenceSnapshot, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(snapshot)?);
        return Ok(());
    }
    println!("担当: {} / {}", snapshot.actor, snapshot.device);
    println!("branch: {}", snapshot.branch);
    println!("変更ファイル: {}", snapshot.files.len());
    for file in &snapshot.files {
        let mut states = Vec::new();
        if file.committed {
            states.push("branch");
        }
        if file.staged {
            states.push("staged");
        }
        if file.unstaged {
            states.push("unstaged");
        }
        if file.untracked {
            states.push("untracked");
        }
        println!("- {} [{}]", file.path, states.join(", "));
    }
    Ok(())
}

fn print_report(report: &PresenceReport, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(report)?);
        return Ok(());
    }
    println!("稼働中の他作業: {}", report.peers.len());
    for peer in &report.peers {
        println!(
            "- {} / {}: {}（{} files）",
            peer.actor,
            peer.device,
            peer.branch,
            peer.files.len()
        );
    }
    if report.overlaps.is_empty() {
        println!("✓ 現在の変更ファイルに重複はありません");
    } else {
        println!("⚠ 重複しているファイル: {}", report.overlaps.len());
        for overlap in &report.overlaps {
            let risk = match overlap.risk {
                OverlapRisk::Uncommitted => "未commit",
                OverlapRisk::Branch => "branch",
            };
            let people = overlap
                .participants
                .iter()
                .map(|participant| {
                    if participant.local {
                        format!("自分({})", participant.branch)
                    } else {
                        format!("{}({})", participant.actor, participant.branch)
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            println!("- [{}] {}: {}", risk, overlap.path, people);
        }
    }
    for warning in &report.warnings {
        eprintln!("arttra: 警告: {warning}");
    }
    Ok(())
}

fn target_ref(policy: &PresencePolicy, actor: &str, device: &str) -> Result<String> {
    let prefix = policy.ref_prefix.trim_matches('/');
    let reference = format!("refs/heads/{prefix}/{actor}/{device}");
    let status = Command::new("git")
        .args(["check-ref-format", &reference])
        .status()
        .context("presence用ref名を検証できませんでした")?;
    if !status.success() {
        bail!("presence用ref名が不正です: {reference}");
    }
    Ok(reference)
}

fn detect_actor() -> Result<String> {
    for key in ["GITHUB_ACTOR", "USER", "USERNAME"] {
        if let Ok(value) = env::var(key)
            && !value.trim().is_empty()
        {
            return safe_segment(&value);
        }
    }
    if let Ok(email) = git(&["config", "user.email"])
        && let Some(name) = email.split('@').next()
    {
        return safe_segment(name);
    }
    if let Ok(name) = git(&["config", "user.name"]) {
        return safe_segment(&name);
    }
    Ok("unknown".into())
}

fn load_or_create_device_id(root: &Path) -> Result<String> {
    let path = root.join(DEVICE_ID_PATH);
    if path.exists() {
        let value = read_to_string(&path)
            .with_context(|| format!("{}を読み込めませんでした", path.display()))?;
        return safe_segment(value.trim());
    }
    let value = format!("device-{}-{}", now_ms(), std::process::id());
    let parent = path
        .parent()
        .context("presence device IDの保存先を判定できませんでした")?;
    create_dir_all(parent)
        .with_context(|| format!("{}を作成できませんでした", parent.display()))?;
    write(&path, format!("{value}\n"))
        .with_context(|| format!("{}を書き込めませんでした", path.display()))?;
    Ok(value)
}

fn safe_segment(value: &str) -> Result<String> {
    let mut result = String::new();
    let mut previous_dash = false;
    for character in value.trim().chars() {
        let safe = character.is_ascii_alphanumeric() || matches!(character, '_' | '-');
        if safe {
            result.push(character.to_ascii_lowercase());
            previous_dash = false;
        } else if !previous_dash {
            result.push('-');
            previous_dash = true;
        }
    }
    let result = result.trim_matches('-');
    if result.is_empty() {
        bail!("actor/device名には英数字を1文字以上含めてください");
    }
    Ok(result.to_owned())
}

fn repository_key(remote: &str, root: &str) -> String {
    if remote.trim().is_empty() {
        return Path::new(root)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("repository")
            .to_owned();
    }
    let path = if let Some((_, path)) = remote.rsplit_once(':') {
        if remote.contains('@') && !remote.contains("://") {
            path
        } else {
            remote
        }
    } else {
        remote
    };
    let path = path
        .split("://")
        .nth(1)
        .and_then(|value| value.split_once('/').map(|(_, path)| path))
        .unwrap_or(path)
        .trim_end_matches('/')
        .trim_end_matches(".git");
    let components = path
        .split('/')
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    match components.as_slice() {
        [.., owner, repository] => format!("{owner}/{repository}"),
        [repository] => (*repository).to_owned(),
        _ => "repository".into(),
    }
}

fn git(args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .args(args)
        .output()
        .context("gitを起動できませんでした")?;
    ensure_success(&output, "git")?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn network_git() -> Command {
    let mut command = Command::new("git");
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env(
            "GIT_SSH_COMMAND",
            "ssh -o BatchMode=yes -o ConnectTimeout=10",
        );
    command
}

fn git_bytes(args: &[&str]) -> Result<Vec<u8>> {
    let output = Command::new("git")
        .args(args)
        .output()
        .context("gitを起動できませんでした")?;
    ensure_success(&output, "git")?;
    Ok(output.stdout)
}

fn git_with_input(args: &[&str], input: &[u8]) -> Result<String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command_with_input(command, input, "git")
}

fn command_with_input(mut command: Command, input: &[u8], action: &str) -> Result<String> {
    let mut child = command
        .spawn()
        .with_context(|| format!("{action}を起動できませんでした"))?;
    child
        .stdin
        .take()
        .context("標準入力を開けませんでした")?
        .write_all(input)
        .context("標準入力へ書き込めませんでした")?;
    let output = child
        .wait_with_output()
        .with_context(|| format!("{action}の完了を待機できませんでした"))?;
    ensure_success(&output, action)?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn ensure_success(output: &Output, action: &str) -> Result<()> {
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr);
        bail!("{action} failed: {}", detail.trim())
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis())
}

#[cfg(test)]
mod tests {
    use super::{FileActivity, PresenceSnapshot, find_overlaps, repository_key, safe_segment};

    fn snapshot(actor: &str, path: &str) -> PresenceSnapshot {
        PresenceSnapshot {
            schema_version: 1,
            repository: "art-tra/repo".into(),
            actor: actor.into(),
            device: format!("{actor}-device"),
            branch: format!("feature/{actor}"),
            head: None,
            observed_at_unix_ms: 0,
            files: vec![FileActivity {
                path: path.into(),
                committed: false,
                staged: false,
                unstaged: true,
                untracked: false,
            }],
        }
    }

    #[test]
    fn normalizes_actor_and_repository_names() {
        assert_eq!(safe_segment("Roz Worker").expect("segment"), "roz-worker");
        assert_eq!(
            repository_key("git@github.com:art-tra/example.git", "/tmp/example"),
            "art-tra/example"
        );
        assert_eq!(
            repository_key("https://github.com/art-tra/example.git", "/tmp/example"),
            "art-tra/example"
        );
    }

    #[test]
    fn reports_only_files_touched_by_multiple_participants() {
        let local = snapshot("roz", "src/main.rs");
        let peers = vec![
            snapshot("alice", "src/main.rs"),
            snapshot("bob", "README.md"),
        ];
        let overlaps = find_overlaps(&local, &peers);
        assert_eq!(overlaps.len(), 1);
        assert_eq!(overlaps[0].path, "src/main.rs");
        assert_eq!(overlaps[0].participants.len(), 2);
    }
}
