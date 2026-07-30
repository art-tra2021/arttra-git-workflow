use std::env;
use std::fs::{create_dir_all, remove_file, write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use anyhow::{Context, Result, bail};
use serde::Serialize;

use crate::policy::PresencePolicy;

#[derive(Debug)]
struct SchedulerContext {
    root: PathBuf,
    executable: PathBuf,
    identifier: String,
}

#[derive(Debug, Serialize)]
struct SchedulerReport {
    platform: &'static str,
    installed: bool,
    detail: String,
    definition_path: String,
    interval_seconds: u64,
}

pub fn install(policy: &PresencePolicy, yes: bool, json: bool) -> Result<()> {
    ensure_enabled_and_confirmed(policy, yes, "install")?;
    let context = scheduler_context()?;
    let report = platform::install(&context, policy)?;
    print_report(&report, json)
}

pub fn status(policy: &PresencePolicy, json: bool) -> Result<()> {
    let context = scheduler_context()?;
    let report = platform::status(&context, policy)?;
    print_report(&report, json)
}

pub fn uninstall(policy: &PresencePolicy, yes: bool, json: bool) -> Result<()> {
    if !yes {
        bail!("定期共有設定を削除するには`--yes`を指定してください");
    }
    let context = scheduler_context()?;
    let report = platform::uninstall(&context, policy)?;
    print_report(&report, json)
}

fn ensure_enabled_and_confirmed(policy: &PresencePolicy, yes: bool, action: &str) -> Result<()> {
    if !policy.enabled {
        bail!("presence共有が無効なため{action}できません");
    }
    if !yes {
        bail!("OSの定期共有設定を書き込むには`--yes`を指定してください");
    }
    Ok(())
}

fn scheduler_context() -> Result<SchedulerContext> {
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .context("Gitリポジトリを確認できませんでした")?;
    ensure_success(&output, "git rev-parse")?;
    let root = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    let executable = env::current_exe().context("git-arの実行ファイルを判定できませんでした")?;
    let repository = root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("repository");
    let repository = safe_identifier(repository);
    let hash = stable_hash(&root.to_string_lossy());
    Ok(SchedulerContext {
        root,
        executable,
        identifier: format!("{repository}-{hash:08x}"),
    })
}

fn print_report(report: &SchedulerReport, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(report)?);
    } else {
        println!(
            "{} presence定期共有: {}",
            if report.installed { "✓" } else { "○" },
            report.detail
        );
        println!("platform: {}", report.platform);
        println!("definition: {}", report.definition_path);
    }
    Ok(())
}

fn safe_identifier(value: &str) -> String {
    let mut output = String::new();
    let mut previous_dash = false;
    for character in value.chars() {
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
        "repository".into()
    } else {
        output.into()
    }
}

fn stable_hash(value: &str) -> u32 {
    value
        .as_bytes()
        .iter()
        .fold(2_166_136_261_u32, |hash, byte| {
            (hash ^ u32::from(*byte)).wrapping_mul(16_777_619)
        })
}

fn ensure_success(output: &Output, action: &str) -> Result<()> {
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = stderr
            .lines()
            .chain(stdout.lines())
            .find(|line| !line.trim().is_empty())
            .unwrap_or("詳細なし");
        bail!("{action}に失敗しました: {detail}")
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    const PLATFORM: &str = "macos-launchd";

    pub(super) fn install(
        context: &SchedulerContext,
        policy: &PresencePolicy,
    ) -> Result<SchedulerReport> {
        ensure_repository_is_background_accessible(&context.root)?;
        let path = definition_path(context)?;
        let parent = path
            .parent()
            .context("LaunchAgentsの場所を判定できません")?;
        create_dir_all(parent)
            .with_context(|| format!("{}を作成できませんでした", parent.display()))?;
        let log_directory = context.root.join(".arttra/local");
        create_dir_all(&log_directory)
            .with_context(|| format!("{}を作成できませんでした", log_directory.display()))?;

        let label = label(context);
        let plist = launchd_plist(
            &label,
            &context.executable,
            &context.root,
            &log_directory.join("presence-scheduler.log"),
            policy.interval_seconds.max(30),
            &env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into()),
            env::var("SSH_AUTH_SOCK").ok().as_deref(),
        );
        let domain = launchd_domain()?;
        let _ = Command::new("launchctl")
            .args(["bootout", &domain])
            .arg(&path)
            .output();
        write(&path, plist).with_context(|| format!("{}を書き込めませんでした", path.display()))?;
        let output = Command::new("launchctl")
            .args(["bootstrap", &domain])
            .arg(&path)
            .output()
            .context("launchctlを起動できませんでした")?;
        ensure_success(&output, "launchctl bootstrap")?;

        Ok(report(
            true,
            format!("{}秒ごとに実行します", policy.interval_seconds.max(30)),
            &path,
            policy,
        ))
    }

    pub(super) fn status(
        context: &SchedulerContext,
        policy: &PresencePolicy,
    ) -> Result<SchedulerReport> {
        let path = definition_path(context)?;
        let domain = launchd_domain()?;
        let service = format!("{domain}/{}", label(context));
        let installed = path.is_file()
            && Command::new("launchctl")
                .args(["print", &service])
                .output()
                .is_ok_and(|output| output.status.success());
        Ok(report(
            installed,
            if installed {
                "launchdで稼働中".into()
            } else {
                "未導入".into()
            },
            &path,
            policy,
        ))
    }

    pub(super) fn uninstall(
        context: &SchedulerContext,
        policy: &PresencePolicy,
    ) -> Result<SchedulerReport> {
        let path = definition_path(context)?;
        let domain = launchd_domain()?;
        if path.exists() {
            let _ = Command::new("launchctl")
                .args(["bootout", &domain])
                .arg(&path)
                .output();
            remove_file(&path)
                .with_context(|| format!("{}を削除できませんでした", path.display()))?;
        }
        Ok(report(false, "削除済み".into(), &path, policy))
    }

    fn definition_path(context: &SchedulerContext) -> Result<PathBuf> {
        let home = env::var_os("HOME").context("HOMEを判定できませんでした")?;
        Ok(PathBuf::from(home)
            .join("Library/LaunchAgents")
            .join(format!("{}.plist", label(context))))
    }

    fn ensure_repository_is_background_accessible(root: &Path) -> Result<()> {
        let home = PathBuf::from(env::var_os("HOME").context("HOMEを判定できませんでした")?);
        for protected in ["Desktop", "Documents", "Downloads"] {
            if root.starts_with(home.join(protected)) {
                bail!(
                    "macOSのバックグラウンド処理は{}配下へ安定してアクセスできません。`~/Developer`等へcloneするか、現在位置では`mise run presence:watch`を使用してください",
                    protected
                );
            }
        }
        Ok(())
    }

    fn launchd_domain() -> Result<String> {
        let output = Command::new("id")
            .arg("-u")
            .output()
            .context("ユーザーIDを確認できませんでした")?;
        ensure_success(&output, "id -u")?;
        Ok(format!(
            "gui/{}",
            String::from_utf8_lossy(&output.stdout).trim()
        ))
    }

    fn label(context: &SchedulerContext) -> String {
        format!("com.arttra.git-ar-presence.{}", context.identifier)
    }

    fn report(
        installed: bool,
        detail: String,
        path: &Path,
        policy: &PresencePolicy,
    ) -> SchedulerReport {
        SchedulerReport {
            platform: PLATFORM,
            installed,
            detail,
            definition_path: path.display().to_string(),
            interval_seconds: policy.interval_seconds.max(30),
        }
    }
}

#[cfg(target_os = "macos")]
fn launchd_plist(
    label: &str,
    executable: &Path,
    root: &Path,
    log_path: &Path,
    interval_seconds: u64,
    path: &str,
    ssh_auth_sock: Option<&str>,
) -> String {
    let ssh_auth_sock = ssh_auth_sock.map_or_else(String::new, |value| {
        format!(
            "    <key>SSH_AUTH_SOCK</key>\n    <string>{}</string>\n",
            xml_escape(value)
        )
    });
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
    <string>presence</string>
    <string>watch</string>
    <string>--once</string>
    <string>--yes</string>
  </array>
  <key>WorkingDirectory</key>
  <string>{}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>{}</string>
{ssh_auth_sock}  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>{interval_seconds}</integer>
  <key>StandardOutPath</key>
  <string>{}</string>
  <key>StandardErrorPath</key>
  <string>{}</string>
</dict>
</plist>
"#,
        xml_escape(label),
        xml_escape(&executable.to_string_lossy()),
        xml_escape(&root.to_string_lossy()),
        xml_escape(path),
        xml_escape(&log_path.to_string_lossy()),
        xml_escape(&log_path.to_string_lossy()),
    )
}

#[cfg(target_os = "macos")]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;

    const PLATFORM: &str = "windows-task-scheduler";

    pub(super) fn install(
        context: &SchedulerContext,
        policy: &PresencePolicy,
    ) -> Result<SchedulerReport> {
        let path = definition_path(context);
        let parent = path.parent().context("task scriptの場所を判定できません")?;
        create_dir_all(parent)
            .with_context(|| format!("{}を作成できませんでした", parent.display()))?;
        let log_path = parent.join("presence-scheduler.log");
        let script = format!(
            "@echo off\r\ncd /d \"{}\"\r\n\"{}\" presence watch --once --yes >> \"{}\" 2>&1\r\n",
            cmd_escape(&context.root.to_string_lossy()),
            cmd_escape(&context.executable.to_string_lossy()),
            cmd_escape(&log_path.to_string_lossy())
        );
        write(&path, script)
            .with_context(|| format!("{}を書き込めませんでした", path.display()))?;

        let interval_minutes = policy.interval_seconds.max(60).div_ceil(60);
        let task_run = format!("cmd.exe /d /c \"{}\"", path.display());
        let output = Command::new("schtasks.exe")
            .args([
                "/Create",
                "/F",
                "/SC",
                "MINUTE",
                "/MO",
                &interval_minutes.to_string(),
                "/RL",
                "LIMITED",
                "/TN",
                &task_name(context),
                "/TR",
                &task_run,
            ])
            .output()
            .context("schtasks.exeを起動できませんでした")?;
        ensure_success(&output, "schtasks /Create")?;
        Ok(report(
            true,
            format!("{interval_minutes}分ごとに実行します"),
            &path,
            policy,
        ))
    }

    pub(super) fn status(
        context: &SchedulerContext,
        policy: &PresencePolicy,
    ) -> Result<SchedulerReport> {
        let path = definition_path(context);
        let installed = Command::new("schtasks.exe")
            .args(["/Query", "/TN", &task_name(context)])
            .output()
            .is_ok_and(|output| output.status.success());
        Ok(report(
            installed,
            if installed {
                "Task Schedulerで登録済み".into()
            } else {
                "未導入".into()
            },
            &path,
            policy,
        ))
    }

    pub(super) fn uninstall(
        context: &SchedulerContext,
        policy: &PresencePolicy,
    ) -> Result<SchedulerReport> {
        let path = definition_path(context);
        let query = Command::new("schtasks.exe")
            .args(["/Query", "/TN", &task_name(context)])
            .output();
        if query.is_ok_and(|output| output.status.success()) {
            let output = Command::new("schtasks.exe")
                .args(["/Delete", "/F", "/TN", &task_name(context)])
                .output()
                .context("schtasks.exeを起動できませんでした")?;
            ensure_success(&output, "schtasks /Delete")?;
        }
        if path.exists() {
            remove_file(&path)
                .with_context(|| format!("{}を削除できませんでした", path.display()))?;
        }
        Ok(report(false, "削除済み".into(), &path, policy))
    }

    fn definition_path(context: &SchedulerContext) -> PathBuf {
        context.root.join(".arttra/local").join("presence-task.cmd")
    }

    fn task_name(context: &SchedulerContext) -> String {
        format!("ART-TRA Presence {}", context.identifier)
    }

    fn cmd_escape(value: &str) -> String {
        value.replace('%', "%%").replace('"', "\"\"")
    }

    fn report(
        installed: bool,
        detail: String,
        path: &Path,
        policy: &PresencePolicy,
    ) -> SchedulerReport {
        SchedulerReport {
            platform: PLATFORM,
            installed,
            detail,
            definition_path: path.display().to_string(),
            interval_seconds: policy.interval_seconds.max(60),
        }
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod platform {
    use super::*;

    const PLATFORM: &str = "linux-systemd-user";

    pub(super) fn install(
        context: &SchedulerContext,
        policy: &PresencePolicy,
    ) -> Result<SchedulerReport> {
        ensure_systemd_user()?;
        let (service_path, timer_path) = definition_paths(context)?;
        let parent = service_path
            .parent()
            .context("systemd user directoryを判定できません")?;
        create_dir_all(parent)
            .with_context(|| format!("{}を作成できませんでした", parent.display()))?;
        write(
            &service_path,
            systemd_service(&context.executable, &context.root),
        )
        .with_context(|| format!("{}を書き込めませんでした", service_path.display()))?;
        write(&timer_path, systemd_timer(policy.interval_seconds.max(30)))
            .with_context(|| format!("{}を書き込めませんでした", timer_path.display()))?;
        systemctl(&["daemon-reload"])?;
        systemctl(&[
            "enable",
            "--now",
            timer_path
                .file_name()
                .and_then(|value| value.to_str())
                .context("timer名を判定できませんでした")?,
        ])?;
        Ok(report(
            true,
            format!("{}秒ごとに実行します", policy.interval_seconds.max(30)),
            &timer_path,
            policy,
        ))
    }

    pub(super) fn status(
        context: &SchedulerContext,
        policy: &PresencePolicy,
    ) -> Result<SchedulerReport> {
        let (_, timer_path) = definition_paths(context)?;
        let timer_name = timer_path
            .file_name()
            .and_then(|value| value.to_str())
            .context("timer名を判定できませんでした")?;
        let installed = timer_path.is_file()
            && Command::new("systemctl")
                .args(["--user", "is-active", "--quiet", timer_name])
                .output()
                .is_ok_and(|output| output.status.success());
        Ok(report(
            installed,
            if installed {
                "systemd user timerで稼働中".into()
            } else {
                "未導入または停止中".into()
            },
            &timer_path,
            policy,
        ))
    }

    pub(super) fn uninstall(
        context: &SchedulerContext,
        policy: &PresencePolicy,
    ) -> Result<SchedulerReport> {
        let (service_path, timer_path) = definition_paths(context)?;
        if let Some(timer_name) = timer_path.file_name().and_then(|value| value.to_str()) {
            let _ = systemctl(&["disable", "--now", timer_name]);
        }
        for path in [&service_path, &timer_path] {
            if path.exists() {
                remove_file(path)
                    .with_context(|| format!("{}を削除できませんでした", path.display()))?;
            }
        }
        let _ = systemctl(&["daemon-reload"]);
        Ok(report(false, "削除済み".into(), &timer_path, policy))
    }

    fn definition_paths(context: &SchedulerContext) -> Result<(PathBuf, PathBuf)> {
        let home = env::var_os("HOME").context("HOMEを判定できませんでした")?;
        let directory = PathBuf::from(home).join(".config/systemd/user");
        let base = format!("arttra-presence-{}", context.identifier);
        Ok((
            directory.join(format!("{base}.service")),
            directory.join(format!("{base}.timer")),
        ))
    }

    fn ensure_systemd_user() -> Result<()> {
        let output = Command::new("systemctl")
            .args(["--user", "show-environment"])
            .output()
            .context("systemctlを起動できませんでした。WSLではsystemdを有効化する必要があります")?;
        ensure_success(
            &output,
            "systemd user sessionの確認（WSLではsystemdを有効化してください）",
        )
    }

    fn systemctl(args: &[&str]) -> Result<()> {
        let output = Command::new("systemctl")
            .arg("--user")
            .args(args)
            .output()
            .context("systemctlを起動できませんでした")?;
        ensure_success(&output, "systemctl --user")
    }

    fn report(
        installed: bool,
        detail: String,
        path: &Path,
        policy: &PresencePolicy,
    ) -> SchedulerReport {
        SchedulerReport {
            platform: PLATFORM,
            installed,
            detail,
            definition_path: path.display().to_string(),
            interval_seconds: policy.interval_seconds.max(30),
        }
    }

    fn systemd_service(executable: &Path, root: &Path) -> String {
        format!(
            "[Unit]\nDescription=ART-TRA changed-file presence publisher\n\n[Service]\nType=oneshot\nWorkingDirectory={}\nExecStart={} presence watch --once --yes\n",
            systemd_quote(&root.to_string_lossy()),
            systemd_quote(&executable.to_string_lossy())
        )
    }

    fn systemd_timer(interval_seconds: u64) -> String {
        format!(
            "[Unit]\nDescription=Publish ART-TRA changed-file presence periodically\n\n[Timer]\nOnBootSec=30s\nOnUnitActiveSec={interval_seconds}s\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n"
        )
    }

    fn systemd_quote(value: &str) -> String {
        format!(
            "\"{}\"",
            value
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('%', "%%")
        )
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
mod platform {
    use super::*;

    pub(super) fn install(
        _context: &SchedulerContext,
        _policy: &PresencePolicy,
    ) -> Result<SchedulerReport> {
        bail!("このOSの自動起動にはまだ対応していません")
    }

    pub(super) fn status(
        _context: &SchedulerContext,
        _policy: &PresencePolicy,
    ) -> Result<SchedulerReport> {
        bail!("このOSの自動起動にはまだ対応していません")
    }

    pub(super) fn uninstall(
        _context: &SchedulerContext,
        _policy: &PresencePolicy,
    ) -> Result<SchedulerReport> {
        bail!("このOSの自動起動にはまだ対応していません")
    }
}

#[cfg(test)]
mod tests {
    use super::{safe_identifier, stable_hash};

    #[test]
    fn scheduler_identity_is_safe_and_stable() {
        assert_eq!(safe_identifier("ART TRA / Repo"), "art-tra-repo");
        assert_eq!(stable_hash("/example/repo"), stable_hash("/example/repo"));
        assert_ne!(stable_hash("/example/repo"), stable_hash("/other/repo"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn launchd_definition_escapes_paths() {
        let definition = super::launchd_plist(
            "com.example.a&b",
            std::path::Path::new("/tmp/a&b/git-ar"),
            std::path::Path::new("/tmp/a&b"),
            std::path::Path::new("/tmp/a&b/log"),
            300,
            "/usr/bin:/bin",
            Some("/tmp/a&b/agent"),
        );
        assert!(definition.contains("com.example.a&amp;b"));
        assert!(definition.contains("<integer>300</integer>"));
        assert!(definition.contains("/tmp/a&amp;b/agent"));
    }
}
