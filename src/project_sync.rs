use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::process::{Command, Stdio};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::policy::TasksPolicy;

const STATE_QUERY: &str = r#"
query ArttraProjectFieldState($owner: String!, $number: Int!, $issueId: ID!) {
  organization(login: $owner) {
    projectV2(number: $number) {
      id
      fields(first: 100) {
        totalCount
        nodes {
          ... on ProjectV2Field { id name dataType }
          ... on ProjectV2SingleSelectField { id name dataType options { id name } }
        }
      }
    }
  }
  node(id: $issueId) {
    ... on Issue {
      id
      assignees(first: 100) { nodes { login } }
      projectItems(first: 100) {
        totalCount
        nodes {
          id
          project { id }
          fieldValues(first: 100) {
            totalCount
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2FieldCommon { name } }
              }
              ... on ProjectV2ItemFieldDateValue {
                date
                field { ... on ProjectV2FieldCommon { name } }
              }
            }
          }
        }
      }
    }
  }
}
"#;

const ADD_ITEM_MUTATION: &str = r#"
mutation ArttraAddProjectItem($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
    item { id }
  }
}
"#;

const UPDATE_FIELD_MUTATION: &str = r#"
mutation ArttraUpdateProjectField(
  $projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!
) {
  updateProjectV2ItemFieldValue(
    input: {projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value}
  ) { projectV2Item { id } }
}
"#;

#[derive(Debug, Clone, Default, Serialize)]
pub struct ProjectFieldValues {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

impl ProjectFieldValues {
    pub fn validate(&self) -> Result<()> {
        validate_choice(
            "Priority",
            self.priority.as_deref(),
            &["P0", "P1", "P2", "P3"],
        )?;
        validate_choice("Size", self.size.as_deref(), &["S", "M", "L", "XL"])?;
        validate_choice(
            "Status",
            self.status.as_deref(),
            &[
                "Intake",
                "Ready",
                "Urgent (unstarted)",
                "In progress",
                "Blocked",
                "In review",
                "Done",
            ],
        )?;
        if let Some(value) = &self.start_date {
            validate_date("Start date", value)?;
        }
        if let Some(value) = &self.target_date {
            validate_date("Target date", value)?;
        }
        Ok(())
    }

    fn entries(&self) -> Vec<FieldRequest> {
        [
            ("Priority", self.priority.as_deref(), FieldKind::Select),
            ("Size", self.size.as_deref(), FieldKind::Select),
            ("Start date", self.start_date.as_deref(), FieldKind::Date),
            ("Target date", self.target_date.as_deref(), FieldKind::Date),
            ("Status", self.status.as_deref(), FieldKind::Select),
        ]
        .into_iter()
        .filter_map(|(field, value, kind)| {
            value.map(|value| FieldRequest {
                field: field.into(),
                value: value.into(),
                kind,
            })
        })
        .collect()
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct IssueReadback {
    pub id: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub assignees: Vec<Assignee>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Assignee {
    pub login: String,
}

impl IssueReadback {
    pub fn assignee_logins(&self) -> Vec<String> {
        self.assignees
            .iter()
            .map(|assignee| assignee.login.clone())
            .collect()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectFieldSyncReport {
    pub schema_version: u32,
    pub status: SyncStatus,
    pub project: ProjectReference,
    pub issue: IssueReference,
    pub item_created: bool,
    pub fields: Vec<FieldResult>,
    pub recovery: Recovery,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncStatus {
    Synced,
    Partial,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectReference {
    pub owner: String,
    pub number: u64,
    pub id: Option<String>,
    pub item_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IssueReference {
    pub id: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FieldResult {
    pub field: String,
    pub requested: Value,
    pub actual: Value,
    pub status: FieldStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldStatus {
    Unchanged,
    Updated,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct Recovery {
    pub retryable: bool,
    pub operation: &'static str,
    pub issue_url: String,
    pub instructions: Vec<String>,
}

#[derive(Debug, Clone)]
struct FieldRequest {
    field: String,
    value: String,
    kind: FieldKind,
}

#[derive(Debug, Clone, Copy)]
enum FieldKind {
    Select,
    Date,
}

pub fn read_issue(reference: &str) -> Result<IssueReadback> {
    let output = Command::new("gh")
        .args([
            "issue",
            "view",
            reference,
            "--json",
            "id,number,title,url,assignees",
        ])
        .output()
        .context("作成済みIssueのread-backを起動できませんでした")?;
    if !output.status.success() {
        bail!(
            "作成済みIssueのread-backに失敗しました: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    serde_json::from_slice(&output.stdout).context("作成済みIssueのread-backを解析できませんでした")
}

pub fn sync(
    policy: &TasksPolicy,
    issue: &IssueReadback,
    values: &ProjectFieldValues,
    expected_assignees: &[String],
) -> ProjectFieldSyncReport {
    if let Err(error) = values.validate() {
        return failed_report(policy, issue, values, expected_assignees, error.to_string());
    }
    let (Some(owner), Some(number)) = (&policy.project_owner, policy.project_number) else {
        return failed_report(
            policy,
            issue,
            values,
            expected_assignees,
            "arttra.tomlのtasks.project_ownerとtasks.project_numberを両方設定してください".into(),
        );
    };
    let initial = match state(owner, number, &issue.id) {
        Ok(state) => state,
        Err(error) => {
            return failed_report(policy, issue, values, expected_assignees, error.to_string());
        }
    };
    let Some(project) = initial.pointer("/data/organization/projectV2") else {
        return failed_report(
            policy,
            issue,
            values,
            expected_assignees,
            format!(
                "Organization Project {owner}#{number}を読み取れませんでした。Projects read権限を確認してください"
            ),
        );
    };
    let Some(project_id) = project.get("id").and_then(Value::as_str) else {
        return failed_report(
            policy,
            issue,
            values,
            expected_assignees,
            "Project IDがありません".into(),
        );
    };
    let project_id = project_id.to_owned();
    let fields = project
        .pointer("/fields/nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let field_total = project
        .pointer("/fields/totalCount")
        .and_then(Value::as_u64)
        .unwrap_or(fields.len() as u64);
    if field_total > fields.len() as u64 {
        return failed_report(
            policy,
            issue,
            values,
            expected_assignees,
            "Project fieldが100件を超えており、安全にfieldを特定できません".into(),
        );
    }
    let project_items = initial
        .pointer("/data/node/projectItems/nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let item_total = initial
        .pointer("/data/node/projectItems/totalCount")
        .and_then(Value::as_u64)
        .unwrap_or(project_items.len() as u64);
    if item_total > project_items.len() as u64 {
        return failed_report(
            policy,
            issue,
            values,
            expected_assignees,
            "IssueのProject itemが100件を超えており、重複なく対象itemを特定できません".into(),
        );
    }
    let existing = project_items.iter().find(|item| {
        item.pointer("/project/id").and_then(Value::as_str) == Some(project_id.as_str())
    });
    let (item_id, item_created) = if let Some(item) = existing {
        match item.get("id").and_then(Value::as_str) {
            Some(id) => (id.to_owned(), false),
            None => {
                return failed_report(
                    policy,
                    issue,
                    values,
                    expected_assignees,
                    "Project item IDがありません".into(),
                );
            }
        }
    } else {
        match graphql(
            ADD_ITEM_MUTATION,
            json!({"projectId": project_id, "contentId": issue.id}),
        )
        .and_then(|response| {
            response
                .pointer("/data/addProjectV2ItemById/item/id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| anyhow!("Project item IDを追加応答から読み取れませんでした"))
        }) {
            Ok(id) => (id, true),
            Err(error) => {
                return failed_report(policy, issue, values, expected_assignees, error.to_string());
            }
        }
    };
    let current = existing.map(item_values).unwrap_or_default();
    let mut field_schema = BTreeMap::new();
    for field in &fields {
        if let Some(name) = field.get("name").and_then(Value::as_str) {
            field_schema.insert(name.to_owned(), field.clone());
        }
    }
    let mut results = Vec::new();
    for request in values.entries() {
        if current.get(&request.field) == Some(&request.value) {
            results.push(field_result(
                &request,
                Some(&request.value),
                FieldStatus::Unchanged,
                None,
            ));
            continue;
        }
        let Some(field) = field_schema.get(&request.field) else {
            results.push(field_result(
                &request,
                current.get(&request.field),
                FieldStatus::Failed,
                Some(format!(
                    "Project field {}が見つかりません。schemaは変更しません",
                    request.field
                )),
            ));
            continue;
        };
        let Some(field_id) = field.get("id").and_then(Value::as_str) else {
            results.push(field_result(
                &request,
                current.get(&request.field),
                FieldStatus::Failed,
                Some("Project field IDがありません".into()),
            ));
            continue;
        };
        let value = match request.kind {
            FieldKind::Date => json!({"date": request.value}),
            FieldKind::Select => {
                let option = field
                    .get("options")
                    .and_then(Value::as_array)
                    .and_then(|options| {
                        options.iter().find(|option| {
                            option.get("name").and_then(Value::as_str)
                                == Some(request.value.as_str())
                        })
                    })
                    .and_then(|option| option.get("id"))
                    .and_then(Value::as_str);
                let Some(option_id) = option else {
                    results.push(field_result(
                        &request,
                        current.get(&request.field),
                        FieldStatus::Failed,
                        Some(format!(
                            "{}の選択肢 {} がProject schemaにありません",
                            request.field, request.value
                        )),
                    ));
                    continue;
                };
                json!({"singleSelectOptionId": option_id})
            }
        };
        match graphql(
            UPDATE_FIELD_MUTATION,
            json!({"projectId": project_id, "itemId": item_id, "fieldId": field_id, "value": value}),
        ) {
            Ok(_) => results.push(field_result(&request, None, FieldStatus::Updated, None)),
            Err(error) => results.push(field_result(
                &request,
                current.get(&request.field),
                FieldStatus::Failed,
                Some(error.to_string()),
            )),
        }
    }
    let expected = normalized_logins(expected_assignees);
    let initial_assignees = state_assignees(&initial);
    results.push(FieldResult {
        field: "Assignees".into(),
        requested: json!(expected),
        actual: json!(initial_assignees),
        status: if expected == initial_assignees {
            FieldStatus::Unchanged
        } else {
            FieldStatus::Failed
        },
        message: (expected != initial_assignees)
            .then(|| "Issue Assigneeのwrite後read-backが一致しませんでした".into()),
    });
    match state(owner, number, &issue.id) {
        Ok(verified) => verify_results(&mut results, &verified, &project_id, &expected),
        Err(error) => {
            for result in &mut results {
                if result.status == FieldStatus::Updated {
                    result.status = FieldStatus::Failed;
                    result.message = Some(format!("更新後のread-backに失敗しました: {error}"));
                }
            }
        }
    }
    let failures = results
        .iter()
        .filter(|result| result.status == FieldStatus::Failed)
        .count();
    ProjectFieldSyncReport {
        schema_version: 1,
        status: if failures == 0 {
            SyncStatus::Synced
        } else if failures == results.len() {
            SyncStatus::Failed
        } else {
            SyncStatus::Partial
        },
        project: ProjectReference {
            owner: owner.clone(),
            number,
            id: Some(project_id),
            item_id: Some(item_id),
        },
        issue: IssueReference {
            id: issue.id.clone(),
            url: issue.url.clone(),
        },
        item_created,
        fields: results,
        recovery: recovery(&issue.url),
    }
}

pub fn readback_failure(
    policy: &TasksPolicy,
    issue_url: &str,
    values: &ProjectFieldValues,
    expected_assignees: &[String],
    message: String,
) -> ProjectFieldSyncReport {
    let issue = IssueReadback {
        id: "(unknown)".into(),
        number: 0,
        title: "(read-back failed)".into(),
        url: issue_url.into(),
        assignees: Vec::new(),
    };
    failed_report(policy, &issue, values, expected_assignees, message)
}

fn state(owner: &str, number: u64, issue_id: &str) -> Result<Value> {
    graphql(
        STATE_QUERY,
        json!({"owner": owner, "number": number, "issueId": issue_id}),
    )
}

fn graphql(query: &str, variables: Value) -> Result<Value> {
    let mut child = Command::new("gh")
        .args(["api", "graphql", "--input", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("gh api graphqlを起動できませんでした")?;
    child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("gh api graphqlの標準入力を開けませんでした"))?
        .write_all(
            serde_json::to_string(&json!({"query": query, "variables": variables}))?.as_bytes(),
        )
        .context("GraphQL入力を書き込めませんでした")?;
    let output = child
        .wait_with_output()
        .context("GraphQL応答を待機できませんでした")?;
    if !output.status.success() {
        bail!(
            "GitHub GraphQL操作に失敗しました: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let response: Value = serde_json::from_slice(&output.stdout)
        .context("GitHub GraphQL応答を解析できませんでした")?;
    if let Some(errors) = response.get("errors").and_then(Value::as_array)
        && !errors.is_empty()
    {
        let messages = errors
            .iter()
            .filter_map(|error| error.get("message").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("; ");
        bail!("GitHub GraphQL操作に失敗しました: {messages}");
    }
    Ok(response)
}

fn item_values(item: &Value) -> BTreeMap<String, String> {
    item.pointer("/fieldValues/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| {
            let name = value.pointer("/field/name")?.as_str()?;
            let current = value.get("name").or_else(|| value.get("date"))?.as_str()?;
            Some((name.to_owned(), current.to_owned()))
        })
        .collect()
}

fn verify_results(
    results: &mut [FieldResult],
    state: &Value,
    project_id: &str,
    expected_assignees: &[String],
) {
    let verified = state
        .pointer("/data/node/projectItems/nodes")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find(|item| {
                item.pointer("/project/id").and_then(Value::as_str) == Some(project_id)
            })
        })
        .map(item_values)
        .unwrap_or_default();
    for result in results
        .iter_mut()
        .filter(|result| result.field != "Assignees" && result.status != FieldStatus::Failed)
    {
        let actual = verified.get(&result.field).cloned();
        result.actual = actual.clone().map(Value::String).unwrap_or(Value::Null);
        if result.requested.as_str() != actual.as_deref() {
            result.status = FieldStatus::Failed;
            result.message =
                Some("更新後のProject field read-backが入力値と一致しませんでした".into());
        }
    }
    let actual_assignees = state_assignees(state);
    if let Some(result) = results
        .iter_mut()
        .find(|result| result.field == "Assignees")
    {
        result.actual = json!(actual_assignees);
        if actual_assignees != expected_assignees {
            result.status = FieldStatus::Failed;
            result.message = Some("Issue Assigneeのwrite後read-backが一致しませんでした".into());
        }
    }
}

fn state_assignees(state: &Value) -> Vec<String> {
    let values = state
        .pointer("/data/node/assignees/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| {
            value
                .get("login")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect::<Vec<_>>();
    normalized_logins(&values)
}

fn normalized_logins(values: &[String]) -> Vec<String> {
    let mut unique = BTreeSet::new();
    for value in values {
        let normalized = value.trim();
        if !normalized.is_empty() {
            unique.insert(normalized.to_ascii_lowercase());
        }
    }
    unique.into_iter().collect()
}

fn field_result(
    request: &FieldRequest,
    actual: Option<&String>,
    status: FieldStatus,
    message: Option<String>,
) -> FieldResult {
    FieldResult {
        field: request.field.clone(),
        requested: Value::String(request.value.clone()),
        actual: actual.cloned().map(Value::String).unwrap_or(Value::Null),
        status,
        message,
    }
}

fn failed_report(
    policy: &TasksPolicy,
    issue: &IssueReadback,
    values: &ProjectFieldValues,
    expected_assignees: &[String],
    message: String,
) -> ProjectFieldSyncReport {
    let mut fields = values
        .entries()
        .iter()
        .map(|request| field_result(request, None, FieldStatus::Failed, Some(message.clone())))
        .collect::<Vec<_>>();
    fields.push(FieldResult {
        field: "Assignees".into(),
        requested: json!(normalized_logins(expected_assignees)),
        actual: Value::Null,
        status: FieldStatus::Failed,
        message: Some(message),
    });
    ProjectFieldSyncReport {
        schema_version: 1,
        status: SyncStatus::Failed,
        project: ProjectReference {
            owner: policy
                .project_owner
                .clone()
                .unwrap_or_else(|| "(未設定)".into()),
            number: policy.project_number.unwrap_or(0),
            id: None,
            item_id: None,
        },
        issue: IssueReference {
            id: issue.id.clone(),
            url: issue.url.clone(),
        },
        item_created: false,
        fields,
        recovery: recovery(&issue.url),
    }
}

fn recovery(issue_url: &str) -> Recovery {
    Recovery {
        retryable: true,
        operation: "project-field-sync",
        issue_url: issue_url.into(),
        instructions: vec![
            "Issueは作成済みです。新しいIssueを作らないでください。".into(),
            "Projects write権限とarttra.tomlのtasks設定を確認してください。".into(),
            format!(
                "git ar project-sync --issue {issue_url} と同じfield引数を再実行してください。既存itemと同値fieldは再利用されます。"
            ),
        ],
    }
}

fn validate_choice(field: &str, value: Option<&str>, choices: &[&str]) -> Result<()> {
    if let Some(value) = value
        && !choices.contains(&value)
    {
        bail!("{field}は{}から選択してください", choices.join("、"));
    }
    Ok(())
}

fn validate_date(field: &str, value: &str) -> Result<()> {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
    {
        bail!("{field}はYYYY-MM-DD形式で指定してください");
    }
    let year: u32 = value[0..4].parse()?;
    let month: u32 = value[5..7].parse()?;
    let day: u32 = value[8..10].parse()?;
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let max = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    if day == 0 || day > max {
        bail!("{field}に実在する日付を指定してください");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ProjectFieldValues, item_values, normalized_logins, validate_date};
    use serde_json::json;

    #[test]
    fn project_values_match_project_eight_schema() {
        let values = ProjectFieldValues {
            priority: Some("P1".into()),
            size: Some("XL".into()),
            start_date: Some("2026-08-04".into()),
            target_date: Some("2026-08-31".into()),
            status: Some("In review".into()),
        };
        values.validate().expect("valid Project #8 values");
        assert_eq!(values.entries().len(), 5);
    }

    #[test]
    fn dates_are_deterministic_without_external_parser() {
        assert!(validate_date("Start date", "2024-02-29").is_ok());
        assert!(validate_date("Start date", "2026-02-29").is_err());
        assert!(validate_date("Start date", "2026-13-01").is_err());
    }

    #[test]
    fn readback_values_and_assignees_are_normalized() {
        assert_eq!(
            item_values(&json!({"fieldValues":{"nodes":[
                {"name":"P1","field":{"name":"Priority"}},
                {"date":"2026-08-04","field":{"name":"Start date"}}
            ]}})),
            [
                ("Priority".into(), "P1".into()),
                ("Start date".into(), "2026-08-04".into())
            ]
            .into()
        );
        assert_eq!(
            normalized_logins(&["Alice".into(), "alice".into(), " bob ".into()]),
            vec!["alice", "bob"]
        );
    }
}
