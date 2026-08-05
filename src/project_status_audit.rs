use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::process::{Command, Stdio};

use serde::Serialize;
use serde_json::{Value, json};

use crate::policy::TasksPolicy;

const PROJECT_ITEMS_QUERY: &str = r#"
query ArttraProjectStatusItems($owner: String!, $number: Int!, $after: String) {
  organization(login: $owner) {
    projectV2(number: $number) {
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          fieldValues(first: 100) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2FieldCommon { name } }
              }
            }
          }
          content {
            ... on Issue {
              url
              state
              issueType { name }
              repository {
                nameWithOwner
                labels(first: 100, query: "status/") {
                  pageInfo { hasNextPage }
                  nodes { name }
                }
              }
              labels(first: 100) {
                pageInfo { hasNextPage }
                nodes { name }
              }
            }
          }
        }
      }
    }
  }
}
"#;

const LABELED_ISSUES_QUERY: &str = r#"
query ArttraStatusLabeledIssues($query: String!, $after: String) {
  search(query: $query, type: ISSUE, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Issue {
        url
        state
        issueType { name }
        repository {
          nameWithOwner
          labels(first: 100, query: "status/") {
            pageInfo { hasNextPage }
            nodes { name }
          }
        }
        labels(first: 100) {
          pageInfo { hasNextPage }
          nodes { name }
        }
      }
    }
  }
}
"#;

const ACTIVE_STATUS_LABELS: [&str; 6] = [
    "status/triage",
    "status/todo",
    "status/urgent-unstarted",
    "status/in-progress",
    "status/blocked",
    "status/in-review",
];

const WORKFLOW_STATUS_LABELS: [&str; 8] = [
    "status/triage",
    "status/todo",
    "status/urgent-unstarted",
    "status/in-progress",
    "status/blocked",
    "status/in-review",
    "status/intake",
    "status/done",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AuditStatus {
    Clean,
    Drift,
    Failed,
}

#[derive(Debug, Serialize)]
pub struct ProjectStatusAuditReport {
    pub schema_version: u32,
    pub status: AuditStatus,
    pub project: ProjectReference,
    pub checked_project_items: usize,
    pub checked_labeled_issues: usize,
    pub exemptions: Vec<ProjectStatusExemption>,
    pub diagnostics: Vec<ProjectStatusDiagnostic>,
}

impl ProjectStatusAuditReport {
    pub fn execution_succeeded(&self) -> bool {
        self.status != AuditStatus::Failed
    }

    pub fn is_clean(&self) -> bool {
        self.status == AuditStatus::Clean
    }
}

#[derive(Debug, Serialize)]
pub struct ProjectReference {
    pub owner: String,
    pub number: u64,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectStatusDiagnostic {
    pub code: &'static str,
    pub issue_url: Option<String>,
    pub issue_state: Option<String>,
    pub repository: Option<String>,
    pub issue_type: Option<String>,
    pub project_value: Option<String>,
    pub label_values: Vec<String>,
    pub detail: String,
    pub recommendation: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectStatusExemption {
    pub issue_url: String,
    pub issue_state: String,
    pub repository: String,
    pub issue_type: Option<String>,
    pub project_value: Option<String>,
    pub label_values: Vec<String>,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct IssueSnapshot {
    url: String,
    state: String,
    repository: String,
    issue_type: Option<String>,
    labels: Vec<String>,
    repository_status_labels: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProjectItemSnapshot {
    status: Option<String>,
    issue: Option<IssueSnapshot>,
}

#[derive(Debug, Default)]
struct AuditInput {
    project_items: Vec<ProjectItemSnapshot>,
    labeled_issues: Vec<IssueSnapshot>,
}

trait AuditSource {
    fn load(&self, owner: &str, number: u64) -> Result<AuditInput, String>;
}

struct GhAuditSource;

pub fn audit(policy: &TasksPolicy) -> ProjectStatusAuditReport {
    let owner = policy
        .project_owner
        .clone()
        .unwrap_or_else(|| "<unset>".into());
    let number = policy.project_number.unwrap_or_default();
    audit_with_source(&GhAuditSource, owner, number)
}

fn audit_with_source(
    source: &impl AuditSource,
    owner: String,
    number: u64,
) -> ProjectStatusAuditReport {
    let project = ProjectReference {
        url: format!("https://github.com/orgs/{owner}/projects/{number}"),
        owner: owner.clone(),
        number,
    };
    if owner == "<unset>" || number == 0 {
        return failed_report(
            project,
            "arttra.tomlのtasks.project_ownerとtasks.project_numberを両方設定してください".into(),
        );
    }

    match source.load(&owner, number) {
        Ok(input) => audit_input(project, input),
        Err(detail) => failed_report(project, detail),
    }
}

fn failed_report(project: ProjectReference, detail: String) -> ProjectStatusAuditReport {
    ProjectStatusAuditReport {
        schema_version: 1,
        status: AuditStatus::Failed,
        project,
        checked_project_items: 0,
        checked_labeled_issues: 0,
        exemptions: Vec::new(),
        diagnostics: vec![ProjectStatusDiagnostic {
            code: "AR-PROJECT-STATUS-007",
            issue_url: None,
            issue_state: None,
            repository: None,
            issue_type: None,
            project_value: None,
            label_values: Vec::new(),
            detail,
            recommendation: "GitHub認証とOrganization Projectのread権限（project scope）を確認し、監査を再実行してください。Projectやlabelは自動更新されません。".into(),
        }],
    }
}

fn audit_input(project: ProjectReference, input: AuditInput) -> ProjectStatusAuditReport {
    let checked_project_items = input.project_items.len();
    let mut diagnostics = Vec::new();
    let mut exemptions = Vec::new();
    let mut project_issue_urls = BTreeSet::new();

    for item in input.project_items {
        let Some(issue) = item.issue else {
            continue;
        };
        project_issue_urls.insert(issue.url.clone());

        let label_values = workflow_labels(&issue.labels);
        if !repository_has_status_schema(&issue.repository_status_labels) {
            exemptions.push(ProjectStatusExemption {
                issue_url: issue.url,
                issue_state: issue.state,
                repository: issue.repository,
                issue_type: issue.issue_type,
                project_value: item.status,
                label_values,
                reason: "repositoryに互換status label schemaが導入されていないため、Issue label監査を免除します。Project Statusは引き続き正本です。".into(),
            });
            continue;
        }

        if issue.state == "CLOSED" {
            if !label_values.is_empty() {
                diagnostics.push(issue_diagnostic(
                    "AR-PROJECT-STATUS-008",
                    &issue,
                    item.status.clone(),
                    label_values.clone(),
                    "CLOSED Issueに作業中のstatus labelが残っています。".into(),
                    format!(
                        "CLOSED・Doneは互換status labelなしを正常とするため、{}をIssueから手作業で外してください。",
                        quoted_labels(&label_values)
                    ),
                ));
            }
            if item.status.as_deref() != Some("Done") {
                diagnostics.push(issue_diagnostic(
                    "AR-PROJECT-STATUS-009",
                    &issue,
                    item.status.clone(),
                    label_values,
                    "IssueはCLOSEDですがProject StatusがDoneではありません。".into(),
                    "Issue lifecycleに合わせてProject Statusを手作業でDoneへ設定してください。"
                        .into(),
                ));
            }
            continue;
        }

        if item.status.is_none() {
            diagnostics.push(issue_diagnostic(
                "AR-PROJECT-STATUS-002",
                &issue,
                None,
                label_values.clone(),
                "Project itemのStatusが未設定です。".into(),
                "Project #8でStatusを手作業で設定してください。label値からProject Statusを自動推定しません。".into(),
            ));
        }

        if label_values.len() > 1 {
            diagnostics.push(issue_diagnostic(
                "AR-PROJECT-STATUS-003",
                &issue,
                item.status.clone(),
                label_values.clone(),
                "互換status labelが複数設定されています。".into(),
                match item.status.as_deref().and_then(expected_label) {
                    Some(expected) => format!(
                        "Project Statusを正本として`{expected}`だけを残し、他の互換status labelを手作業で外してください。"
                    ),
                    None => "先にProject Statusを手作業で設定し、対応する互換status labelだけを残してください。".into(),
                },
            ));
        }

        let Some(status) = item.status.as_deref() else {
            continue;
        };
        if status == "Done" {
            diagnostics.push(issue_diagnostic(
                "AR-PROJECT-STATUS-009",
                &issue,
                Some(status.into()),
                label_values,
                "IssueはOPENですがProject StatusがDoneです。".into(),
                "Issue lifecycleとProject Statusを確認し、IssueをcloseするかProject Statusを作業中の値へ手作業で戻してください。".into(),
            ));
            continue;
        }
        let Some(expected) = expected_label(status) else {
            diagnostics.push(issue_diagnostic(
                "AR-PROJECT-STATUS-006",
                &issue,
                Some(status.into()),
                label_values,
                "Project Statusを既知の互換status labelへ対応付けできません。".into(),
                "Project #8のStatus optionと監査の決定的な対応表を確認してください。自動変換は行いません。".into(),
            ));
            continue;
        };

        if label_values.is_empty() {
            diagnostics.push(issue_diagnostic(
                "AR-PROJECT-STATUS-004",
                &issue,
                Some(status.into()),
                label_values,
                "OPEN Issueに互換status labelが未設定です。".into(),
                format!(
                    "Project Statusを正本として`{expected}`をIssueへ手作業で追加してください。"
                ),
            ));
        } else if label_values.len() == 1 && label_values[0] != expected {
            diagnostics.push(issue_diagnostic(
                "AR-PROJECT-STATUS-001",
                &issue,
                Some(status.into()),
                label_values.clone(),
                format!(
                    "Project Status `{status}` と互換status label `{}` が一致しません。",
                    label_values[0]
                ),
                format!("Project Statusを正本として`{expected}`へ手作業で付け替えてください。"),
            ));
        }
    }

    let mut labeled_by_url: BTreeMap<String, IssueSnapshot> = BTreeMap::new();
    for mut issue in input.labeled_issues {
        match labeled_by_url.get_mut(&issue.url) {
            Some(existing) => existing.labels.append(&mut issue.labels),
            None => {
                labeled_by_url.insert(issue.url.clone(), issue);
            }
        }
    }
    for issue in labeled_by_url.values_mut() {
        issue.labels.sort();
        issue.labels.dedup();
    }
    let checked_labeled_issues = labeled_by_url.len();
    for (url, issue) in labeled_by_url {
        if !project_issue_urls.contains(&url)
            && repository_has_status_schema(&issue.repository_status_labels)
        {
            let labels = workflow_labels(&issue.labels);
            if issue.state == "CLOSED" {
                diagnostics.push(issue_diagnostic(
                    "AR-PROJECT-STATUS-008",
                    &issue,
                    None,
                    labels.clone(),
                    "Project itemがないCLOSED Issueに作業中のstatus labelが残っています。"
                        .into(),
                    format!(
                        "CLOSED Issueは互換status labelなしを正常とするため、{}をIssueから手作業で外してください。",
                        quoted_labels(&labels)
                    ),
                ));
            } else {
                diagnostics.push(issue_diagnostic(
                    "AR-PROJECT-STATUS-005",
                    &issue,
                    None,
                    labels,
                    "互換status labelを持つOPEN IssueにProject #8のitemがありません。".into(),
                    "IssueをProject #8へ手作業で追加してStatusを設定してください。labelからProject itemやStatusを自動作成しません。".into(),
                ));
            }
        }
    }

    exemptions.sort_by(|left, right| left.issue_url.cmp(&right.issue_url));
    diagnostics.sort_by(|left, right| {
        left.issue_url
            .cmp(&right.issue_url)
            .then_with(|| left.code.cmp(right.code))
    });
    ProjectStatusAuditReport {
        schema_version: 1,
        status: if diagnostics.is_empty() {
            AuditStatus::Clean
        } else {
            AuditStatus::Drift
        },
        project,
        checked_project_items,
        checked_labeled_issues,
        exemptions,
        diagnostics,
    }
}

fn issue_diagnostic(
    code: &'static str,
    issue: &IssueSnapshot,
    project_value: Option<String>,
    label_values: Vec<String>,
    detail: String,
    recommendation: String,
) -> ProjectStatusDiagnostic {
    ProjectStatusDiagnostic {
        code,
        issue_url: Some(issue.url.clone()),
        issue_state: Some(issue.state.clone()),
        repository: Some(issue.repository.clone()),
        issue_type: issue.issue_type.clone(),
        project_value,
        label_values,
        detail,
        recommendation,
    }
}

fn workflow_labels(labels: &[String]) -> Vec<String> {
    let mut matches = labels
        .iter()
        .filter(|label| WORKFLOW_STATUS_LABELS.contains(&label.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    matches.sort();
    matches.dedup();
    matches
}

fn repository_has_status_schema(labels: &[String]) -> bool {
    ACTIVE_STATUS_LABELS
        .iter()
        .all(|expected| labels.iter().any(|label| label == expected))
}

fn quoted_labels(labels: &[String]) -> String {
    labels
        .iter()
        .map(|label| format!("`{label}`"))
        .collect::<Vec<_>>()
        .join("、")
}

fn expected_label(status: &str) -> Option<&'static str> {
    match status.trim().to_ascii_lowercase().as_str() {
        "intake" => Some("status/triage"),
        "ready" => Some("status/todo"),
        "urgent (unstarted)" => Some("status/urgent-unstarted"),
        "in progress" => Some("status/in-progress"),
        "blocked" => Some("status/blocked"),
        "in review" => Some("status/in-review"),
        _ => None,
    }
}

impl AuditSource for GhAuditSource {
    fn load(&self, owner: &str, number: u64) -> Result<AuditInput, String> {
        let mut input = AuditInput::default();
        let mut after = None;
        loop {
            let response = graphql(
                PROJECT_ITEMS_QUERY,
                json!({"owner": owner, "number": number, "after": after}),
            )?;
            let items = response
                .pointer("/data/organization/projectV2/items")
                .ok_or_else(|| format!("Organization Project #{number}を読み取れませんでした"))?;
            input.project_items.extend(parse_project_items(items)?);
            after = next_cursor(items)?;
            if after.is_none() {
                break;
            }
        }

        for label in WORKFLOW_STATUS_LABELS {
            let mut after = None;
            loop {
                let response = graphql(
                    LABELED_ISSUES_QUERY,
                    json!({
                        "query": format!("org:{owner} is:issue label:\"{label}\""),
                        "after": after,
                    }),
                )?;
                let search = response.pointer("/data/search").ok_or_else(|| {
                    format!("互換label `{label}` のIssue検索結果を読み取れませんでした")
                })?;
                input.labeled_issues.extend(parse_issues(search)?);
                after = next_cursor(search)?;
                if after.is_none() {
                    break;
                }
            }
        }
        Ok(input)
    }
}

fn graphql(query: &str, variables: Value) -> Result<Value, String> {
    let mut child = Command::new("gh")
        .args(["api", "graphql", "--input", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("gh api graphqlを起動できませんでした: {error}"))?;
    let payload = json!({"query": query, "variables": variables});
    child
        .stdin
        .take()
        .ok_or_else(|| "gh api graphqlの標準入力を開けませんでした".to_string())?
        .write_all(payload.to_string().as_bytes())
        .map_err(|error| format!("gh api graphqlへqueryを書き込めませんでした: {error}"))?;
    let output = child
        .wait_with_output()
        .map_err(|error| format!("gh api graphqlの完了を待てませんでした: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "GitHub GraphQL APIに失敗しました: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let response: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("GitHub GraphQL APIのJSONを解析できませんでした: {error}"))?;
    if let Some(errors) = response.get("errors").and_then(Value::as_array)
        && !errors.is_empty()
    {
        let messages = errors
            .iter()
            .filter_map(|error| error.get("message").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" / ");
        return Err(format!("GitHub GraphQL APIがerrorを返しました: {messages}"));
    }
    Ok(response)
}

fn parse_project_items(items: &Value) -> Result<Vec<ProjectItemSnapshot>, String> {
    let nodes = items
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| "Project item一覧が配列ではありません".to_string())?;
    nodes
        .iter()
        .map(|node| {
            let status = node
                .pointer("/fieldValues/nodes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|field| {
                    field.pointer("/field/name").and_then(Value::as_str) == Some("Status")
                })
                .and_then(|field| field.get("name"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let issue = match node.pointer("/content/url").and_then(Value::as_str) {
                Some(url) => Some(parse_issue(
                    node.get("content").unwrap_or(&Value::Null),
                    url,
                )?),
                None => None,
            };
            Ok(ProjectItemSnapshot { status, issue })
        })
        .collect()
}

fn parse_issues(search: &Value) -> Result<Vec<IssueSnapshot>, String> {
    let nodes = search
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| "Issue検索結果が配列ではありません".to_string())?;
    nodes
        .iter()
        .filter_map(|node| {
            node.get("url")
                .and_then(Value::as_str)
                .map(|url| parse_issue(node, url))
        })
        .collect()
}

fn parse_issue(value: &Value, url: &str) -> Result<IssueSnapshot, String> {
    if value
        .pointer("/labels/pageInfo/hasNextPage")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(format!(
            "{url} のlabelが100件を超えたため、監査を不完全な状態で続行しません"
        ));
    }
    let labels = value
        .pointer("/labels/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|label| label.get("name").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if value
        .pointer("/repository/labels/pageInfo/hasNextPage")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(format!(
            "{url} のrepository status labelが100件を超えたため、監査を不完全な状態で続行しません"
        ));
    }
    let repository_status_labels = value
        .pointer("/repository/labels/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|label| label.get("name").and_then(Value::as_str))
        .map(str::to_owned)
        .collect();
    let repository = value
        .pointer("/repository/nameWithOwner")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{url} のrepositoryを読み取れませんでした"))?
        .to_owned();
    let state = value
        .get("state")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{url} のIssue stateを読み取れませんでした"))?
        .to_owned();
    let issue_type = value
        .pointer("/issueType/name")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            labels
                .iter()
                .find(|label| label.starts_with("type/"))
                .cloned()
        });
    Ok(IssueSnapshot {
        url: url.into(),
        state,
        repository,
        issue_type,
        labels,
        repository_status_labels,
    })
}

fn next_cursor(connection: &Value) -> Result<Option<String>, String> {
    let page_info = connection
        .get("pageInfo")
        .ok_or_else(|| "GitHub GraphQL APIのpageInfoがありません".to_string())?;
    if !page_info
        .get("hasNextPage")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(None);
    }
    page_info
        .get("endCursor")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .map(Some)
        .ok_or_else(|| "次のpageがあるのにendCursorがありません".to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        ACTIVE_STATUS_LABELS, AuditInput, AuditSource, AuditStatus, IssueSnapshot,
        ProjectItemSnapshot, audit_with_source,
    };

    struct MockSource(Result<AuditInput, String>);

    impl AuditSource for MockSource {
        fn load(&self, _owner: &str, _number: u64) -> Result<AuditInput, String> {
            match &self.0 {
                Ok(input) => Ok(AuditInput {
                    project_items: input.project_items.clone(),
                    labeled_issues: input.labeled_issues.clone(),
                }),
                Err(error) => Err(error.clone()),
            }
        }
    }

    #[test]
    fn reports_each_drift_with_stable_code_and_fix() {
        let source = MockSource(Ok(AuditInput {
            project_items: vec![
                open_item(Some("In progress"), &["type/task", "status/todo"], 1),
                open_item(Some("Ready"), &["type/task"], 2),
                open_item(None, &["type/task", "status/todo", "status/blocked"], 3),
            ],
            labeled_issues: vec![managed_issue("OPEN", &["type/work", "status/todo"], 4)],
        }));

        let report = audit_with_source(&source, "art-tra2021".into(), 8);

        assert_eq!(report.status, AuditStatus::Drift);
        assert_eq!(report.checked_project_items, 3);
        assert_eq!(report.checked_labeled_issues, 1);
        assert_eq!(
            report
                .diagnostics
                .iter()
                .map(|diagnostic| diagnostic.code)
                .collect::<Vec<_>>(),
            [
                "AR-PROJECT-STATUS-001",
                "AR-PROJECT-STATUS-004",
                "AR-PROJECT-STATUS-002",
                "AR-PROJECT-STATUS-003",
                "AR-PROJECT-STATUS-005",
            ]
        );
        assert!(
            report
                .diagnostics
                .iter()
                .all(
                    |diagnostic| diagnostic.issue_state.as_deref() == Some("OPEN")
                        && diagnostic.repository.as_deref() == Some("art-tra2021/repo")
                        && diagnostic.issue_type.is_some()
                        && !diagnostic.recommendation.is_empty()
                )
        );
    }

    #[test]
    fn open_mapping_and_closed_done_without_status_label_are_clean() {
        let statuses = [
            ("Intake", "status/triage"),
            ("Ready", "status/todo"),
            ("Urgent (unstarted)", "status/urgent-unstarted"),
            ("In progress", "status/in-progress"),
            ("Blocked", "status/blocked"),
            ("In review", "status/in-review"),
        ];
        let mut items = statuses
            .iter()
            .enumerate()
            .map(|(index, (status, label))| {
                open_item(Some(status), &["type/task", *label], index as u64 + 1)
            })
            .collect::<Vec<_>>();
        items.push(ProjectItemSnapshot {
            status: Some("Done".into()),
            issue: Some(managed_issue("CLOSED", &["type/task"], 7)),
        });
        let labeled_issues = items.iter().filter_map(|item| item.issue.clone()).collect();
        let report = audit_with_source(
            &MockSource(Ok(AuditInput {
                project_items: items,
                labeled_issues,
            })),
            "art-tra2021".into(),
            8,
        );

        assert_eq!(report.status, AuditStatus::Clean);
        assert!(report.diagnostics.is_empty());
        assert!(report.exemptions.is_empty());
    }

    #[test]
    fn closed_done_with_active_or_legacy_status_labels_requests_removal() {
        let report = audit_with_source(
            &MockSource(Ok(AuditInput {
                project_items: vec![
                    ProjectItemSnapshot {
                        status: Some("Done".into()),
                        issue: Some(managed_issue(
                            "CLOSED",
                            &["type/task", "status/in-progress"],
                            1,
                        )),
                    },
                    ProjectItemSnapshot {
                        status: Some("Done".into()),
                        issue: Some(managed_issue(
                            "CLOSED",
                            &["type/repository-request", "status/intake"],
                            2,
                        )),
                    },
                ],
                labeled_issues: Vec::new(),
            })),
            "art-tra2021".into(),
            8,
        );

        assert_eq!(report.status, AuditStatus::Drift);
        assert_eq!(report.diagnostics.len(), 2);
        assert!(
            report
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code == "AR-PROJECT-STATUS-008"
                    && diagnostic.recommendation.contains("手作業で外して"))
        );
    }

    #[test]
    fn repository_without_complete_status_schema_is_explicitly_exempt() {
        let mut issue = managed_issue("OPEN", &[], 1);
        issue.repository = "art-tra2021/legacy".into();
        issue.repository_status_labels.clear();
        let report = audit_with_source(
            &MockSource(Ok(AuditInput {
                project_items: vec![ProjectItemSnapshot {
                    status: Some("Intake".into()),
                    issue: Some(issue),
                }],
                labeled_issues: Vec::new(),
            })),
            "art-tra2021".into(),
            8,
        );

        assert_eq!(report.status, AuditStatus::Clean);
        assert!(report.diagnostics.is_empty());
        assert_eq!(report.exemptions.len(), 1);
        assert_eq!(report.exemptions[0].issue_state, "OPEN");
        assert_eq!(report.exemptions[0].repository, "art-tra2021/legacy");
        assert!(report.exemptions[0].reason.contains("schema"));
    }

    #[test]
    fn closed_labeled_issue_without_project_item_requests_label_removal() {
        let report = audit_with_source(
            &MockSource(Ok(AuditInput {
                project_items: Vec::new(),
                labeled_issues: vec![managed_issue(
                    "CLOSED",
                    &["type/task", "status/in-review"],
                    1,
                )],
            })),
            "art-tra2021".into(),
            8,
        );

        assert_eq!(report.status, AuditStatus::Drift);
        assert_eq!(report.diagnostics.len(), 1);
        assert_eq!(report.diagnostics[0].code, "AR-PROJECT-STATUS-008");
        assert!(
            report.diagnostics[0]
                .recommendation
                .contains("手作業で外して")
        );
    }

    #[test]
    fn api_failure_is_structured_and_never_looks_clean() {
        let report = audit_with_source(
            &MockSource(Err("Resource not accessible by integration".into())),
            "art-tra2021".into(),
            8,
        );

        assert_eq!(report.status, AuditStatus::Failed);
        assert!(!report.execution_succeeded());
        assert_eq!(report.diagnostics[0].code, "AR-PROJECT-STATUS-007");
        assert!(report.diagnostics[0].issue_url.is_none());
        assert!(report.diagnostics[0].issue_state.is_none());
        assert!(report.diagnostics[0].repository.is_none());
        assert!(report.diagnostics[0].issue_type.is_none());
        assert!(
            report.diagnostics[0]
                .detail
                .contains("Resource not accessible")
        );
    }

    fn open_item(status: Option<&str>, labels: &[&str], number: u64) -> ProjectItemSnapshot {
        ProjectItemSnapshot {
            status: status.map(str::to_owned),
            issue: Some(managed_issue("OPEN", labels, number)),
        }
    }

    fn managed_issue(state: &str, labels: &[&str], number: u64) -> IssueSnapshot {
        IssueSnapshot {
            url: format!("https://github.com/art-tra2021/repo/issues/{number}"),
            state: state.into(),
            repository: "art-tra2021/repo".into(),
            issue_type: labels
                .iter()
                .find(|label| label.starts_with("type/"))
                .map(|label| (*label).into()),
            labels: labels.iter().map(|label| (*label).into()).collect(),
            repository_status_labels: ACTIVE_STATUS_LABELS
                .iter()
                .map(|label| (*label).into())
                .collect(),
        }
    }
}
