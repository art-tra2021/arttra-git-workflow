use std::process::Command;

use anyhow::{Context, Result, bail};
use inquire::Select;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct Label {
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitHubTask {
    number: u64,
    title: String,
    url: String,
    updated_at: String,
    labels: Vec<Label>,
}

#[derive(Debug, Serialize)]
pub struct TaskItem {
    number: u64,
    title: String,
    url: String,
    updated_at: String,
    group: &'static str,
    labels: Vec<String>,
}

pub fn show(json: bool, open: bool) -> Result<()> {
    let output = Command::new("gh")
        .args([
            "issue",
            "list",
            "--assignee",
            "@me",
            "--state",
            "open",
            "--limit",
            "100",
            "--json",
            "number,title,url,updatedAt,labels",
        ])
        .output()
        .context("gh issue listを起動できませんでした")?;
    if !output.status.success() {
        bail!(
            "GitHubのタスクを取得できませんでした: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let tasks: Vec<GitHubTask> =
        serde_json::from_slice(&output.stdout).context("GitHubの応答を解析できませんでした")?;
    let mut tasks: Vec<TaskItem> = tasks.into_iter().map(normalize).collect();
    tasks.sort_by_key(|task| (group_order(task.group), task.number));

    if json {
        println!("{}", serde_json::to_string_pretty(&tasks)?);
        return Ok(());
    }
    if tasks.is_empty() {
        println!("担当中のopen Issueはありません。");
        return Ok(());
    }

    if open {
        let choices: Vec<String> = tasks
            .iter()
            .map(|task| format!("[{}] #{} {}", task.group, task.number, task.title))
            .collect();
        let selected = Select::new("開くタスクを選んでください", choices.clone()).prompt()?;
        if let Some(index) = choices.iter().position(|choice| choice == &selected) {
            let status = Command::new("gh")
                .args(["issue", "view", &tasks[index].number.to_string(), "--web"])
                .status()
                .context("ブラウザを開けませんでした")?;
            if !status.success() {
                bail!("Issueを開けませんでした");
            }
        }
        return Ok(());
    }

    let mut current = "";
    for task in &tasks {
        if task.group != current {
            current = task.group;
            println!("\n{current}");
        }
        println!("  #{:<4} {}  {}", task.number, task.title, task.url);
    }
    Ok(())
}

fn normalize(task: GitHubTask) -> TaskItem {
    let labels: Vec<String> = task.labels.into_iter().map(|label| label.name).collect();
    let group = if has(&labels, "status/blocked") {
        "BLOCKED"
    } else if has(&labels, "status/urgent-unstarted") {
        "URGENT"
    } else if has(&labels, "status/in-review") {
        "REVIEW"
    } else if has(&labels, "status/in-progress") {
        "DOING"
    } else {
        "TODO"
    };
    TaskItem {
        number: task.number,
        title: task.title,
        url: task.url,
        updated_at: task.updated_at,
        group,
        labels,
    }
}

fn has(labels: &[String], expected: &str) -> bool {
    labels.iter().any(|label| label == expected)
}

fn group_order(group: &str) -> u8 {
    match group {
        "BLOCKED" => 0,
        "URGENT" => 1,
        "REVIEW" => 2,
        "DOING" => 3,
        _ => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::{GitHubTask, Label, normalize};

    #[test]
    fn blocked_wins_over_other_states() {
        let task = normalize(GitHubTask {
            number: 1,
            title: "test".into(),
            url: "https://example.test/1".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            labels: vec![
                Label {
                    name: "status/in-progress".into(),
                },
                Label {
                    name: "status/blocked".into(),
                },
            ],
        });
        assert_eq!(task.group, "BLOCKED");
    }
}
