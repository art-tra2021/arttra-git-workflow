use std::fs::{create_dir_all, read_to_string, write};
use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

const CLAUDE_SETTINGS: &str = ".claude/settings.local.json";
const CODEX_HOOKS: &str = ".codex/hooks.json";
const CLAUDE_INSTRUCTIONS: &str = "CLAUDE.md";
const CLAUDE_INSTRUCTIONS_TEMPLATE: &str = include_str!("../templates/ai/claude-instructions.md");

pub fn install(repository_root: &Path) -> Result<()> {
    install_git_hooks(repository_root)?;
    install_ai_hooks(repository_root)
}

fn install_git_hooks(repository_root: &Path) -> Result<()> {
    let hk = Command::new("hk")
        .current_dir(repository_root)
        .arg("validate")
        .output()
        .context("hkを起動できませんでした。先に`mise install`を実行してください")?;
    if !hk.status.success() {
        bail!(
            "hk設定を検証できないため、既存hookを変更せず停止しました: {}",
            String::from_utf8_lossy(&hk.stderr).trim()
        );
    }

    for scope in ["--global", "--system"] {
        let inherited = Command::new("git")
            .current_dir(repository_root)
            .args(["config", scope, "--get", "core.hooksPath"])
            .output()
            .with_context(|| format!("{scope}のcore.hooksPathを確認できませんでした"))?;
        if inherited.status.success() && !inherited.stdout.is_empty() {
            let value = String::from_utf8_lossy(&inherited.stdout);
            bail!(
                "{scope}に独自のcore.hooksPath=`{}`があります。上書きせず停止しました。",
                value.trim()
            );
        }
        if !inherited.status.success() && inherited.status.code() != Some(1) {
            bail!(
                "{scope}のcore.hooksPath確認に失敗しました: {}",
                String::from_utf8_lossy(&inherited.stderr).trim()
            );
        }
    }

    let configured = Command::new("git")
        .current_dir(repository_root)
        .args(["config", "--local", "--get", "core.hooksPath"])
        .output()
        .context("core.hooksPathを確認できませんでした")?;
    if configured.status.success() {
        let value = String::from_utf8_lossy(&configured.stdout)
            .trim()
            .to_owned();
        if value == ".githooks" {
            let status = Command::new("git")
                .current_dir(repository_root)
                .args(["config", "--local", "--unset", "core.hooksPath"])
                .status()
                .context("旧hook設定を解除できませんでした")?;
            if !status.success() {
                bail!("旧core.hooksPath=.githooksを解除できませんでした");
            }
            println!("✓ 旧.githooks設定をhkへ移行します");
        } else if !value.is_empty() {
            bail!(
                "独自のcore.hooksPath=`{value}`が設定されています。上書きせず停止しました。\n\
                 内容を確認してから手動で解除し、`mise run setup`を再実行してください。"
            );
        }
    } else if configured.status.code() != Some(1) {
        bail!(
            "core.hooksPathの確認に失敗しました: {}",
            String::from_utf8_lossy(&configured.stderr).trim()
        );
    }

    let output = Command::new("hk")
        .current_dir(repository_root)
        .args(["install", "--mise"])
        .output()
        .context("hk installを起動できませんでした。先に`mise install`を実行してください")?;
    if !output.status.success() {
        bail!(
            "hk hookを導入できませんでした: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    println!("✓ Git hooks: hk（mise管理）");
    Ok(())
}

pub fn install_ai_hooks(repository_root: &Path) -> Result<()> {
    install_if_missing(
        &repository_root.join(CLAUDE_INSTRUCTIONS),
        CLAUDE_INSTRUCTIONS_TEMPLATE,
    )?;
    merge_hook(
        &repository_root.join(CLAUDE_SETTINGS),
        json!({
            "matcher": "Bash",
            "hooks": [{
                "type": "command",
                "command": "git ar guard hook --agent claude"
            }],
            "description": "ART-TRA toolchain policy"
        }),
    )?;
    merge_hook(
        &repository_root.join(CODEX_HOOKS),
        json!({
            "matcher": "^Bash$",
            "hooks": [{
                "type": "command",
                "command": "git ar guard hook --agent codex",
                "commandWindows": "git ar guard hook --agent codex",
                "timeout": 5,
                "statusMessage": "ART-TRAのツールチェーン規則を確認中"
            }]
        }),
    )?;
    println!("✓ Claude instructions: {CLAUDE_INSTRUCTIONS}");
    println!("✓ Claude hook: {CLAUDE_SETTINGS}");
    println!("✓ Codex hook: {CODEX_HOOKS}");
    println!("Codexでは初回だけ `/hooks` を開き、リポジトリhookを信頼してください。");
    println!("変更ファイルを自動共有する場合は`mise run presence:install`を実行してください。");
    Ok(())
}

fn install_if_missing(path: &Path, contents: &str) -> Result<()> {
    if path.exists() {
        return Ok(());
    }
    write(path, contents).with_context(|| format!("{}を書き込めませんでした", path.display()))
}

fn merge_hook(path: &Path, hook: Value) -> Result<()> {
    let mut root = if path.exists() {
        let contents = read_to_string(path)
            .with_context(|| format!("{}を読み込めませんでした", path.display()))?;
        serde_json::from_str(&contents)
            .with_context(|| format!("{}は正しいJSONではありません", path.display()))?
    } else {
        json!({})
    };

    let Some(root_object) = root.as_object_mut() else {
        bail!(
            "{}のルートはJSON objectである必要があります",
            path.display()
        );
    };
    let hooks = root_object.entry("hooks").or_insert_with(|| json!({}));
    let Some(hooks_object) = hooks.as_object_mut() else {
        bail!("{}のhooksはJSON objectである必要があります", path.display());
    };
    let pre_tool_use = hooks_object
        .entry("PreToolUse")
        .or_insert_with(|| json!([]));
    let Some(pre_tool_use_array) = pre_tool_use.as_array_mut() else {
        bail!(
            "{}のhooks.PreToolUseはJSON arrayである必要があります",
            path.display()
        );
    };
    if !pre_tool_use_array.iter().any(contains_arttra_guard) {
        pre_tool_use_array.push(hook);
    }

    let parent = path
        .parent()
        .with_context(|| format!("{}の親ディレクトリを判定できません", path.display()))?;
    create_dir_all(parent)
        .with_context(|| format!("{}を作成できませんでした", parent.display()))?;
    let mut contents = serde_json::to_string_pretty(&root)?;
    contents.push('\n');
    write(path, contents).with_context(|| format!("{}を書き込めませんでした", path.display()))
}

fn contains_arttra_guard(value: &Value) -> bool {
    value
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| {
            hooks.iter().any(|hook| {
                hook.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|command| command.contains("git ar guard hook"))
            })
        })
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use tempfile::tempdir;

    use super::install_ai_hooks;

    #[test]
    fn setup_is_idempotent_and_preserves_existing_settings() {
        let root = tempdir().expect("tempdir");
        std::fs::create_dir_all(root.path().join(".claude")).expect("claude directory");
        std::fs::write(
            root.path().join(".claude/settings.local.json"),
            r#"{"permissions":{"allow":["Read"]}}"#,
        )
        .expect("initial settings");

        install_ai_hooks(root.path()).expect("first setup");
        install_ai_hooks(root.path()).expect("second setup");

        let contents = std::fs::read_to_string(root.path().join(".claude/settings.local.json"))
            .expect("generated settings");
        let settings: Value = serde_json::from_str(&contents).expect("valid json");
        assert_eq!(settings["permissions"]["allow"][0], "Read");
        assert_eq!(
            settings["hooks"]["PreToolUse"].as_array().map(Vec::len),
            Some(1)
        );
        assert!(root.path().join("CLAUDE.md").is_file());
        assert!(root.path().join(".codex/hooks.json").is_file());
    }
}
