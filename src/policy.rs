use std::fmt;
use std::path::PathBuf;
use std::process::Command;

use anyhow::{Context, Result, bail};
use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Policy {
    pub version: u32,
    pub commit: CommitPolicy,
    pub issue: IssuePolicy,
    #[serde(default)]
    pub command_guard: CommandGuardPolicy,
    #[serde(default)]
    pub telemetry: TelemetryPolicy,
    #[serde(default)]
    pub presence: PresencePolicy,
    #[serde(default)]
    pub branch: BranchPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitPolicy {
    pub mode: ValidationMode,
    pub max_subject_length: usize,
    pub allowed_types: Vec<String>,
    #[serde(default)]
    pub require_ar_trailer: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IssuePolicy {
    pub require_background: bool,
    pub require_goal: bool,
    pub require_done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandGuardPolicy {
    pub mode: ValidationMode,
    pub javascript_package_manager: String,
    pub python_package_manager: String,
    pub runtime_manager: String,
}

impl Default for CommandGuardPolicy {
    fn default() -> Self {
        Self {
            mode: ValidationMode::Warn,
            javascript_package_manager: "bun".into(),
            python_package_manager: "uv".into(),
            runtime_manager: "mise".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryPolicy {
    pub mode: TelemetryMode,
    pub path: String,
}

impl Default for TelemetryPolicy {
    fn default() -> Self {
        Self {
            mode: TelemetryMode::Off,
            path: ".arttra/local/events.jsonl".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresencePolicy {
    pub enabled: bool,
    pub remote: String,
    pub ref_prefix: String,
    pub interval_seconds: u64,
    pub max_age_minutes: u64,
}

impl Default for PresencePolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            remote: "origin".into(),
            ref_prefix: "ar-presence".into(),
            interval_seconds: 300,
            max_age_minutes: 30,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchPolicy {
    pub mode: ValidationMode,
    pub allowed_types: Vec<String>,
    pub protected_branches: Vec<String>,
    pub bypass_prefixes: Vec<String>,
}

impl Default for BranchPolicy {
    fn default() -> Self {
        Self {
            mode: ValidationMode::Warn,
            allowed_types: vec![
                "feature".into(),
                "fix".into(),
                "hotfix".into(),
                "chore".into(),
                "docs".into(),
                "refactor".into(),
                "test".into(),
                "release".into(),
            ],
            protected_branches: vec!["main".into()],
            bypass_prefixes: vec![
                "dependabot/".into(),
                "renovate/".into(),
                "ar-presence/".into(),
            ],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ValidationMode {
    Off,
    Warn,
    Block,
}

impl fmt::Display for ValidationMode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Off => formatter.write_str("off"),
            Self::Warn => formatter.write_str("warn"),
            Self::Block => formatter.write_str("block"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TelemetryMode {
    Off,
    Local,
}

impl Policy {
    pub fn load() -> Result<Self> {
        let root = repository_root()?;
        let path = root.join("arttra.toml");
        let contents = std::fs::read_to_string(&path)
            .with_context(|| format!("{}を読み込めませんでした", path.display()))?;
        toml::from_str(&contents).with_context(|| format!("{}の形式が不正です", path.display()))
    }
}

impl CommitPolicy {
    pub fn violations(&self, subject: &str) -> Vec<String> {
        if subject.starts_with("Merge ")
            || subject.starts_with("Revert ")
            || subject.starts_with("fixup! ")
            || subject.starts_with("squash! ")
        {
            return Vec::new();
        }

        let mut violations = Vec::new();
        if subject.chars().count() > self.max_subject_length {
            violations.push(format!(
                "commitの先頭行は{}文字以内にしてください",
                self.max_subject_length
            ));
        }

        let pattern = Regex::new(r"^(?<kind>[a-z]+)(\([A-Za-z0-9._/-]+\))?!?: (?<summary>\S.*)$")
            .expect("commit pattern is valid");
        match pattern.captures(subject) {
            Some(captures) => {
                let kind = &captures["kind"];
                if !self.allowed_types.iter().any(|allowed| allowed == kind) {
                    violations.push(format!(
                        "type `{kind}` は使用できません。次のいずれかを使ってください: {}",
                        self.allowed_types.join(", ")
                    ));
                }
            }
            None => violations.push(
                "commitの先頭行は `type(scope): summary` または `type: summary` にしてください"
                    .into(),
            ),
        }
        violations
    }

    pub fn validate_or_report(&self, subject: &str) -> Result<()> {
        let violations = self.violations(subject);
        if violations.is_empty() || matches!(self.mode, ValidationMode::Off) {
            return Ok(());
        }

        for violation in &violations {
            eprintln!("arttra: {violation}");
        }
        if matches!(self.mode, ValidationMode::Block) {
            bail!("commit messageはART-TRAの規則により拒否されました");
        }
        eprintln!("arttra: 警告のみのためcommitを続行します");
        Ok(())
    }
}

fn repository_root() -> Result<PathBuf> {
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .context("gitを起動できませんでした")?;
    if !output.status.success() {
        bail!("current directory is not inside a Git repository");
    }
    Ok(PathBuf::from(
        String::from_utf8_lossy(&output.stdout).trim(),
    ))
}

#[cfg(test)]
mod tests {
    use super::{CommitPolicy, ValidationMode};

    fn policy() -> CommitPolicy {
        CommitPolicy {
            mode: ValidationMode::Warn,
            max_subject_length: 72,
            allowed_types: vec!["feat".into(), "fix".into()],
            require_ar_trailer: false,
        }
    }

    #[test]
    fn accepts_conventional_subjects() {
        assert!(policy().violations("feat(cli): add dry run").is_empty());
        assert!(policy().violations("fix: handle empty scope").is_empty());
    }

    #[test]
    fn reports_unknown_type() {
        let violations = policy().violations("docs: explain usage");
        assert_eq!(violations.len(), 1);
        assert!(violations[0].contains("使用できません"));
    }

    #[test]
    fn reports_invalid_shape() {
        let violations = policy().violations("add a feature");
        assert_eq!(
            violations,
            vec!["commitの先頭行は `type(scope): summary` または `type: summary` にしてください"]
        );
    }

    #[test]
    fn permits_git_generated_subjects() {
        assert!(policy().violations("Merge branch 'main'").is_empty());
        assert!(policy().violations("fixup! feat: original").is_empty());
    }
}
