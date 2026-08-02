use std::process::{Command, Output};

use anyhow::{Context, Result, bail};
use inquire::Select;
use serde::{Deserialize, Serialize};

use crate::policy::TasksPolicy;

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

#[derive(Debug, Deserialize)]
struct ProjectItemsResponse {
    items: Vec<ProjectItem>,
}

#[derive(Debug, Deserialize)]
struct ProjectItem {
    #[serde(default)]
    assignees: Vec<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    priority: Option<String>,
    #[serde(default, rename = "target date")]
    target_date: Option<String>,
    #[serde(default)]
    content: Option<ProjectContent>,
}

#[derive(Debug, Deserialize)]
struct ProjectContent {
    number: u64,
    title: String,
    url: String,
    repository: String,
    #[serde(rename = "type")]
    content_type: String,
}

#[derive(Debug, Serialize)]
pub struct TaskReport {
    schema_version: u32,
    viewer: String,
    source: TaskSource,
    items: Vec<TaskItem>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum TaskSource {
    #[serde(rename = "github-project")]
    GitHubProject {
        owner: String,
        number: u64,
    },
    CurrentRepository,
}

#[derive(Debug, Serialize)]
pub struct TaskItem {
    repository: String,
    number: u64,
    title: String,
    url: String,
    updated_at: Option<String>,
    group: String,
    status: String,
    priority: Option<String>,
    target_date: Option<String>,
    labels: Vec<String>,
}

pub fn show(json: bool, open: bool, dashboard: bool, policy: &TasksPolicy) -> Result<()> {
    if dashboard && !json {
        if dashboard_installed() {
            match Command::new("gh").arg("dash").status() {
                Ok(status) if status.success() => return Ok(()),
                Ok(_) => {
                    eprintln!("gh-dashを開けなかったため、組み込みのタスク表示へ切り替えます。")
                }
                Err(_) => {
                    eprintln!("ghを起動できなかったため、組み込みのタスク表示へ切り替えます。")
                }
            }
        } else {
            eprintln!(
                "gh-dashは未導入です。組み込み表示を使います。\n\
                 導入する場合: mise run extensions:install"
            );
        }
    }

    let viewer = github_viewer()?;
    let (source, mut tasks) = match (&policy.project_owner, policy.project_number) {
        (Some(owner), Some(number)) => (
            TaskSource::GitHubProject {
                owner: owner.clone(),
                number,
            },
            project_tasks(owner, number, &viewer)?,
        ),
        (None, None) => (TaskSource::CurrentRepository, repository_tasks()?),
        _ => bail!("arttra.tomlのtasks.project_ownerとtasks.project_numberは両方設定してください"),
    };
    tasks.sort_by_key(|task| {
        (
            group_order(&task.group),
            task.repository.clone(),
            task.number,
        )
    });

    let report = TaskReport {
        schema_version: 1,
        viewer,
        source,
        items: tasks,
    };
    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }
    if report.items.is_empty() {
        println!("担当中の未完了Issueはありません。");
        return Ok(());
    }

    if open {
        let choices: Vec<String> = report
            .items
            .iter()
            .map(|task| {
                format!(
                    "[{}] {}#{} {}",
                    task.group, task.repository, task.number, task.title
                )
            })
            .collect();
        let selected = Select::new("開くタスクを選んでください", choices.clone()).prompt()?;
        if let Some(index) = choices.iter().position(|choice| choice == &selected) {
            let task = &report.items[index];
            let status = Command::new("gh")
                .args([
                    "issue",
                    "view",
                    &task.number.to_string(),
                    "--repo",
                    &task.repository,
                    "--web",
                ])
                .status()
                .context("ブラウザを開けませんでした")?;
            if !status.success() {
                bail!("Issueを開けませんでした");
            }
        }
        return Ok(());
    }

    let mut current = "";
    for task in &report.items {
        if task.group != current {
            current = &task.group;
            println!("\n{current}");
        }
        let target = task.target_date.as_deref().unwrap_or("期限未設定");
        let priority = task.priority.as_deref().unwrap_or("P2");
        println!(
            "  {}/#{}  {}  {} / {}  {}",
            task.repository, task.number, task.title, priority, target, task.url
        );
    }
    Ok(())
}

fn github_viewer() -> Result<String> {
    let output = Command::new("gh")
        .args(["api", "user", "--jq", ".login"])
        .output()
        .context("GitHubの認証ユーザーを取得できませんでした")?;
    ensure_success(&output, "GitHubの認証ユーザー取得")?;
    let viewer = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if viewer.is_empty() {
        bail!("GitHubの認証ユーザーを読み取れませんでした");
    }
    Ok(viewer)
}

fn project_tasks(owner: &str, number: u64, viewer: &str) -> Result<Vec<TaskItem>> {
    let output = Command::new("gh")
        .args([
            "project",
            "item-list",
            &number.to_string(),
            "--owner",
            owner,
            "--limit",
            "1000",
            "--format",
            "json",
        ])
        .output()
        .context("GitHub Projectを取得できませんでした")?;
    ensure_success(&output, "GitHub Projectの取得")?;
    let response: ProjectItemsResponse = serde_json::from_slice(&output.stdout)
        .context("GitHub Projectの応答を解析できませんでした")?;
    Ok(normalize_project_items(response.items, viewer))
}

fn repository_tasks() -> Result<Vec<TaskItem>> {
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
    ensure_success(&output, "GitHubのタスク取得")?;
    let repository = current_repository()?;
    let tasks: Vec<GitHubTask> =
        serde_json::from_slice(&output.stdout).context("GitHubの応答を解析できませんでした")?;
    Ok(tasks
        .into_iter()
        .map(|task| normalize_repository_task(task, &repository))
        .collect())
}

fn current_repository() -> Result<String> {
    let output = Command::new("gh")
        .args([
            "repo",
            "view",
            "--json",
            "nameWithOwner",
            "--jq",
            ".nameWithOwner",
        ])
        .output()
        .context("現在のGitHub repositoryを取得できませんでした")?;
    ensure_success(&output, "現在のGitHub repository取得")?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn normalize_project_items(items: Vec<ProjectItem>, viewer: &str) -> Vec<TaskItem> {
    items
        .into_iter()
        .filter(|item| item.assignees.iter().any(|assignee| assignee == viewer))
        .filter(|item| item.status.as_deref() != Some("Done"))
        .filter_map(|item| {
            let content = item.content?;
            if content.content_type != "Issue" {
                return None;
            }
            let status = item.status.unwrap_or_else(|| "Intake".into());
            Some(TaskItem {
                repository: content.repository,
                number: content.number,
                title: content.title,
                url: content.url,
                updated_at: None,
                group: group_from_status(&status).into(),
                status,
                priority: item.priority,
                target_date: item.target_date,
                labels: Vec::new(),
            })
        })
        .collect()
}

fn normalize_repository_task(task: GitHubTask, repository: &str) -> TaskItem {
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
        repository: repository.into(),
        number: task.number,
        title: task.title,
        url: task.url,
        updated_at: Some(task.updated_at),
        group: group.into(),
        status: group.into(),
        priority: None,
        target_date: None,
        labels,
    }
}

fn group_from_status(status: &str) -> &'static str {
    match status {
        "Blocked" => "BLOCKED",
        "Urgent (unstarted)" => "URGENT",
        "In review" => "REVIEW",
        "In progress" => "DOING",
        _ => "TODO",
    }
}

fn dashboard_installed() -> bool {
    Command::new("gh")
        .args(["extension", "list"])
        .output()
        .is_ok_and(|output| {
            output.status.success()
                && String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .any(|line| line.contains("dlvhdr/gh-dash"))
        })
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

fn ensure_success(output: &Output, action: &str) -> Result<()> {
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    bail!("{action}に失敗しました: {}", detail.trim())
}

#[cfg(test)]
mod tests {
    use super::{ProjectContent, ProjectItem, group_from_status, normalize_project_items};

    #[test]
    fn project_items_are_filtered_by_verified_viewer_and_done_state() {
        let items = vec![
            project_item("rozwer", "In progress", 1),
            project_item("other", "Blocked", 2),
            project_item("rozwer", "Done", 3),
        ];
        let tasks = normalize_project_items(items, "rozwer");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].repository, "art-tra2021/example");
        assert_eq!(tasks[0].group, "DOING");
        assert_eq!(tasks[0].target_date.as_deref(), Some("2026-08-14"));
    }

    #[test]
    fn project_status_has_stable_priority_order() {
        assert_eq!(group_from_status("Blocked"), "BLOCKED");
        assert_eq!(group_from_status("Urgent (unstarted)"), "URGENT");
        assert_eq!(group_from_status("In review"), "REVIEW");
        assert_eq!(group_from_status("In progress"), "DOING");
        assert_eq!(group_from_status("Ready"), "TODO");
    }

    fn project_item(assignee: &str, status: &str, number: u64) -> ProjectItem {
        ProjectItem {
            assignees: vec![assignee.into()],
            status: Some(status.into()),
            priority: Some("P1".into()),
            target_date: Some("2026-08-14".into()),
            content: Some(ProjectContent {
                number,
                title: "test".into(),
                url: format!("https://github.com/art-tra2021/example/issues/{number}"),
                repository: "art-tra2021/example".into(),
                content_type: "Issue".into(),
            }),
        }
    }
}
