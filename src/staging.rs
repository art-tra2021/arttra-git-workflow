use std::collections::HashSet;
use std::fmt;
use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result, bail};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AddCandidate {
    pub path: String,
    pub status: String,
    pub description: String,
}

impl fmt::Display for AddCandidate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} — {}",
            terminal_safe_path(&self.path),
            self.description
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AddPlan {
    pub schema_version: u32,
    pub action: &'static str,
    pub candidates: Vec<AddCandidate>,
    pub selected: Vec<AddCandidate>,
    pub command: Vec<String>,
}

impl AddPlan {
    pub fn selected_paths(&self) -> impl Iterator<Item = &str> {
        self.selected
            .iter()
            .map(|candidate| candidate.path.as_str())
    }
}

pub fn candidates() -> Result<Vec<AddCandidate>> {
    candidates_in(Path::new("."))
}

fn candidates_in(root: &Path) -> Result<Vec<AddCandidate>> {
    let output = Command::new("git")
        .args(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .current_dir(root)
        .output()
        .context("stage候補を確認するためのgit statusを起動できませんでした")?;
    if !output.status.success() {
        bail!(
            "stage候補を確認できませんでした: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    parse_porcelain(&output.stdout)
}

pub fn build_plan(requested: &[String], all: bool) -> Result<AddPlan> {
    plan_from_candidates(candidates()?, requested, all)
}

pub fn execute(plan: &AddPlan) -> Result<()> {
    execute_in(Path::new("."), plan)
}

fn execute_in(root: &Path, plan: &AddPlan) -> Result<()> {
    if plan.selected.is_empty() {
        bail!("stageするファイルが選択されていません");
    }
    let status = Command::new("git")
        .arg("add")
        .arg("--")
        .args(plan.selected_paths())
        .current_dir(root)
        .status()
        .context("git addを起動できませんでした")?;
    if !status.success() {
        bail!("git addが失敗しました（終了コード: {:?}）", status.code());
    }
    Ok(())
}

fn plan_from_candidates(
    candidates: Vec<AddCandidate>,
    requested: &[String],
    all: bool,
) -> Result<AddPlan> {
    let selected = if all {
        candidates.clone()
    } else {
        resolve_requested(&candidates, requested)?
    };
    let mut command = vec!["git".into(), "add".into(), "--".into()];
    command.extend(selected.iter().map(|candidate| candidate.path.clone()));
    Ok(AddPlan {
        schema_version: 1,
        action: "add",
        candidates,
        selected,
        command,
    })
}

fn resolve_requested(
    candidates: &[AddCandidate],
    requested: &[String],
) -> Result<Vec<AddCandidate>> {
    let mut selected = Vec::new();
    let mut seen = HashSet::new();
    for requested_path in requested {
        let normalized = requested_path
            .strip_prefix("./")
            .unwrap_or(requested_path.as_str());
        let Some(candidate) = candidates
            .iter()
            .find(|candidate| candidate.path == normalized)
        else {
            bail!(
                "`{}`はstage候補ではありません。`git ar add --json`で候補を確認してください",
                terminal_safe_path(requested_path)
            );
        };
        if seen.insert(candidate.path.clone()) {
            selected.push(candidate.clone());
        }
    }
    Ok(selected)
}

fn parse_porcelain(output: &[u8]) -> Result<Vec<AddCandidate>> {
    let records = output.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut candidates = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        if record.is_empty() {
            index += 1;
            continue;
        }
        if record.len() < 4 || record[2] != b' ' {
            bail!("git statusから未知の形式を受け取りました");
        }
        let index_status = record[0];
        let worktree_status = record[1];
        let status = String::from_utf8(vec![index_status, worktree_status])
            .context("git statusの状態をUTF-8として読めませんでした")?;
        let path = String::from_utf8(record[3..].to_vec())
            .context("UTF-8ではないファイル名はgit ar addから扱えません")?;
        let has_rename_source =
            matches!(index_status, b'R' | b'C') || matches!(worktree_status, b'R' | b'C');
        let unmerged = is_unmerged(index_status, worktree_status);
        let needs_stage = status == "??"
            || unmerged
            || (!matches!(worktree_status, b' ' | b'!') && status != "!!");
        if needs_stage {
            candidates.push(AddCandidate {
                description: describe(index_status, worktree_status, unmerged).into(),
                path,
                status,
            });
        }
        index += 1;
        if has_rename_source {
            if index >= records.len() || records[index].is_empty() {
                bail!("git statusのrename情報が途中で終了しました");
            }
            index += 1;
        }
    }
    Ok(candidates)
}

fn is_unmerged(index_status: u8, worktree_status: u8) -> bool {
    matches!(
        (index_status, worktree_status),
        (b'D', b'D')
            | (b'A', b'U')
            | (b'U', b'D')
            | (b'U', b'A')
            | (b'D', b'U')
            | (b'A', b'A')
            | (b'U', b'U')
    )
}

fn describe(index_status: u8, worktree_status: u8, unmerged: bool) -> &'static str {
    if unmerged {
        return "競合を解消した内容としてstage";
    }
    if (index_status, worktree_status) == (b'?', b'?') {
        return "新しいファイル（未stage）";
    }
    if index_status != b' ' && worktree_status != b' ' {
        return "stage後にも変更あり（最新内容へ更新）";
    }
    match worktree_status {
        b'M' => "変更済み（未stage）",
        b'D' => "削除をstage",
        b'R' => "名前変更をstage",
        b'C' => "コピーをstage",
        b'T' => "ファイル種別の変更をstage",
        b'A' => "追加をstage",
        _ => "未stageの変更",
    }
}

fn terminal_safe_path(path: &str) -> String {
    let mut output = String::with_capacity(path.len());
    for character in path.chars() {
        if character.is_control() {
            output.extend(character.escape_default());
        } else {
            output.push(character);
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    use anyhow::{Result, bail};

    use super::{AddCandidate, candidates_in, execute_in, parse_porcelain, plan_from_candidates};

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

    fn candidate(path: &str) -> AddCandidate {
        AddCandidate {
            path: path.into(),
            status: " M".into(),
            description: "変更済み（未stage）".into(),
        }
    }

    #[test]
    fn porcelain_parser_returns_only_files_that_need_staging() {
        let parsed = parse_porcelain(
            b" M src/main.rs\0?? src/staging.rs\0A  staged.rs\0AM changed-again.rs\0R  renamed.rs\0old.rs\0",
        )
        .expect("parse status");

        assert_eq!(
            parsed
                .iter()
                .map(|candidate| (candidate.status.as_str(), candidate.path.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (" M", "src/main.rs"),
                ("??", "src/staging.rs"),
                ("AM", "changed-again.rs"),
            ]
        );
        assert_eq!(
            parsed[2].description,
            "stage後にも変更あり（最新内容へ更新）"
        );
    }

    #[test]
    fn porcelain_parser_keeps_conflicts_as_explicit_candidates() {
        let parsed = parse_porcelain(b"UU src/conflicted.rs\0").expect("parse unmerged status");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].description, "競合を解消した内容としてstage");
    }

    #[test]
    fn add_plan_selects_exact_candidates_and_rejects_unknown_paths() {
        let candidates = vec![candidate("src/main.rs"), candidate("src/tui.rs")];
        let plan = plan_from_candidates(
            candidates.clone(),
            &["./src/tui.rs".into(), "src/tui.rs".into()],
            false,
        )
        .expect("select one candidate");
        assert_eq!(plan.selected, vec![candidate("src/tui.rs")]);
        assert_eq!(plan.command, vec!["git", "add", "--", "src/tui.rs"]);

        let all = plan_from_candidates(candidates.clone(), &[], true).expect("select all");
        assert_eq!(all.selected, candidates);

        let error =
            plan_from_candidates(vec![candidate("src/main.rs")], &["README.md".into()], false)
                .expect_err("reject unknown file");
        assert!(error.to_string().contains("stage候補ではありません"));
    }

    #[test]
    fn stages_only_the_files_selected_by_the_plan() -> Result<()> {
        let repository = tempfile::tempdir()?;
        let root = repository.path();
        git(root, &["init", "-b", "main"])?;
        fs::write(root.join("selected.txt"), "selected\n")?;
        fs::write(root.join("remaining.txt"), "remaining\n")?;

        let candidates = candidates_in(root)?;
        let plan = plan_from_candidates(candidates, &["selected.txt".into()], false)?;
        execute_in(root, &plan)?;

        assert_eq!(
            git(root, &["diff", "--cached", "--name-only"])?.trim(),
            "selected.txt"
        );
        assert_eq!(
            git(root, &["ls-files", "--others", "--exclude-standard"])?.trim(),
            "remaining.txt"
        );
        Ok(())
    }
}
