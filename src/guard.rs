use std::fmt;
use std::fs::{OpenOptions, create_dir_all};
use std::io::Write;
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use regex::Regex;
use serde::Serialize;

use crate::policy::{CommandGuardPolicy, Policy, TelemetryMode, ValidationMode};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GuardDecision {
    Allow,
    Warn,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GuardResult {
    pub schema_version: u32,
    pub decision: GuardDecision,
    pub error_code: Option<&'static str>,
    pub rule_id: Option<&'static str>,
    pub message_ja: Option<String>,
    pub fix_command: Option<String>,
}

#[derive(Debug)]
pub struct GuardDenied;

impl fmt::Display for GuardDenied {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("コマンドはリポジトリポリシーにより拒否されました")
    }
}

impl std::error::Error for GuardDenied {}

#[derive(Debug, Serialize)]
struct TelemetryEvent<'a> {
    schema_version: u32,
    occurred_at_unix_ms: u128,
    event: &'static str,
    agent: &'a str,
    decision: GuardDecision,
    rule_id: Option<&'static str>,
    policy_version: u32,
}

#[derive(Debug, Clone, Copy)]
struct Violation {
    error_code: &'static str,
    rule_id: &'static str,
    detected_tool: &'static str,
    replacement: Replacement,
}

#[derive(Debug, Clone, Copy)]
enum Replacement {
    Javascript,
    JavascriptInstall,
    JavascriptRun,
    JavascriptExec,
    PythonPip,
    PythonVenv,
    RuntimeUse,
}

pub fn evaluate(command: &str, policy: &CommandGuardPolicy) -> GuardResult {
    if matches!(policy.mode, ValidationMode::Off) {
        return allowed();
    }

    let Some(violation) = find_violation(command) else {
        return allowed();
    };
    let decision = match policy.mode {
        ValidationMode::Off => GuardDecision::Allow,
        ValidationMode::Warn => GuardDecision::Warn,
        ValidationMode::Block => GuardDecision::Deny,
    };
    let fix_command = replacement_command(violation.replacement, policy);
    GuardResult {
        schema_version: 1,
        decision,
        error_code: Some(violation.error_code),
        rule_id: Some(violation.rule_id),
        message_ja: Some(format!(
            "{} はこのリポジトリでは使用しません。代わりに `{}` を実行してください。",
            violation.detected_tool, fix_command
        )),
        fix_command: Some(fix_command),
    }
}

pub fn record_telemetry(
    result: &GuardResult,
    agent: &str,
    policy: &Policy,
    repository_root: &Path,
) {
    if !matches!(policy.telemetry.mode, TelemetryMode::Local)
        || matches!(result.decision, GuardDecision::Allow)
    {
        return;
    }

    let event = TelemetryEvent {
        schema_version: 1,
        occurred_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_millis()),
        event: "command_guard_decision",
        agent,
        decision: result.decision,
        rule_id: result.rule_id,
        policy_version: policy.version,
    };
    let path = repository_root.join(&policy.telemetry.path);
    let Some(parent) = path.parent() else {
        return;
    };
    if create_dir_all(parent).is_err() {
        return;
    }
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    if let Ok(line) = serde_json::to_string(&event) {
        let _ = writeln!(file, "{line}");
    }
}

pub fn repository_root() -> Result<std::path::PathBuf> {
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .context("gitを起動できませんでした")?;
    if !output.status.success() {
        anyhow::bail!("現在のディレクトリはGitリポジトリではありません");
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().into())
}

fn allowed() -> GuardResult {
    GuardResult {
        schema_version: 1,
        decision: GuardDecision::Allow,
        error_code: None,
        rule_id: None,
        message_ja: None,
        fix_command: None,
    }
}

fn find_violation(command: &str) -> Option<Violation> {
    const RULES: &[(&str, Violation)] = &[
        (
            r"npx",
            Violation {
                error_code: "AR-TOOLCHAIN-001",
                rule_id: "toolchain.npx.use-bunx",
                detected_tool: "npx",
                replacement: Replacement::JavascriptExec,
            },
        ),
        (
            r"npm\s+(?:install|i|ci)\b",
            Violation {
                error_code: "AR-TOOLCHAIN-001",
                rule_id: "toolchain.npm.use-bun",
                detected_tool: "npm",
                replacement: Replacement::JavascriptInstall,
            },
        ),
        (
            r"npm\s+run\b",
            Violation {
                error_code: "AR-TOOLCHAIN-001",
                rule_id: "toolchain.npm.use-bun",
                detected_tool: "npm",
                replacement: Replacement::JavascriptRun,
            },
        ),
        (
            r"npm\b",
            Violation {
                error_code: "AR-TOOLCHAIN-001",
                rule_id: "toolchain.npm.use-bun",
                detected_tool: "npm",
                replacement: Replacement::Javascript,
            },
        ),
        (
            r"(?:yarn|pnpm)\b",
            Violation {
                error_code: "AR-TOOLCHAIN-001",
                rule_id: "toolchain.javascript.use-bun",
                detected_tool: "yarn/pnpm",
                replacement: Replacement::Javascript,
            },
        ),
        (
            r"(?:pip|pip3)\b",
            Violation {
                error_code: "AR-TOOLCHAIN-002",
                rule_id: "toolchain.pip.use-uv",
                detected_tool: "pip",
                replacement: Replacement::PythonPip,
            },
        ),
        (
            r"python3?\s+-m\s+pip\b",
            Violation {
                error_code: "AR-TOOLCHAIN-002",
                rule_id: "toolchain.pip.use-uv",
                detected_tool: "python -m pip",
                replacement: Replacement::PythonPip,
            },
        ),
        (
            r"python3?\s+-m\s+venv\b",
            Violation {
                error_code: "AR-TOOLCHAIN-002",
                rule_id: "toolchain.venv.use-uv",
                detected_tool: "python -m venv",
                replacement: Replacement::PythonVenv,
            },
        ),
        (
            r"(?:nvm|fnm|volta|pyenv|nodenv|rbenv)\b",
            Violation {
                error_code: "AR-TOOLCHAIN-003",
                rule_id: "toolchain.runtime.use-mise",
                detected_tool: "個別のバージョン管理ツール",
                replacement: Replacement::RuntimeUse,
            },
        ),
    ];

    RULES
        .iter()
        .find(|(pattern, _)| shell_command_matches(command, pattern))
        .map(|(_, violation)| *violation)
}

fn replacement_command(replacement: Replacement, policy: &CommandGuardPolicy) -> String {
    match replacement {
        Replacement::Javascript => policy.javascript_package_manager.clone(),
        Replacement::JavascriptInstall => {
            format!("{} install", policy.javascript_package_manager)
        }
        Replacement::JavascriptRun => {
            format!("{} run <script>", policy.javascript_package_manager)
        }
        Replacement::JavascriptExec if policy.javascript_package_manager == "bun" => "bunx".into(),
        Replacement::JavascriptExec => {
            format!("{} exec", policy.javascript_package_manager)
        }
        Replacement::PythonPip => format!("{} pip", policy.python_package_manager),
        Replacement::PythonVenv => format!("{} venv", policy.python_package_manager),
        Replacement::RuntimeUse => {
            format!("{} use <tool>@<version>", policy.runtime_manager)
        }
    }
}

fn shell_command_matches(command: &str, executable_pattern: &str) -> bool {
    let pattern = format!(
        r"(?m)(?:^|&&|\|\||;|\|)\s*(?:command\s+)?(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)?(?:{executable_pattern})(?:\s|$)"
    );
    Regex::new(&pattern)
        .expect("command guard pattern is valid")
        .is_match(command)
}

#[cfg(test)]
mod tests {
    use super::{GuardDecision, evaluate};
    use crate::policy::{CommandGuardPolicy, ValidationMode};

    fn policy(mode: ValidationMode) -> CommandGuardPolicy {
        CommandGuardPolicy {
            mode,
            javascript_package_manager: "bun".into(),
            python_package_manager: "uv".into(),
            runtime_manager: "mise".into(),
        }
    }

    #[test]
    fn blocks_package_managers_at_command_boundaries() {
        for command in [
            "npm install",
            "cd web && npm run build",
            "pip3 install requests",
            "python -m venv .venv",
            "env FOO=bar pyenv install 3.13",
        ] {
            assert_eq!(
                evaluate(command, &policy(ValidationMode::Block)).decision,
                GuardDecision::Deny,
                "{command}"
            );
        }
    }

    #[test]
    fn does_not_match_package_manager_names_used_as_data() {
        for command in [
            "rg npm README.md",
            "echo 'pip install'",
            "bun install",
            "uv sync",
        ] {
            assert_eq!(
                evaluate(command, &policy(ValidationMode::Block)).decision,
                GuardDecision::Allow,
                "{command}"
            );
        }
    }

    #[test]
    fn supports_warn_and_off_rollout_modes() {
        assert_eq!(
            evaluate("npm install", &policy(ValidationMode::Warn)).decision,
            GuardDecision::Warn
        );
        assert_eq!(
            evaluate("npm install", &policy(ValidationMode::Off)).decision,
            GuardDecision::Allow
        );
    }
}
