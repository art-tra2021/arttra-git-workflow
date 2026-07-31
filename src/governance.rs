use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Deserialize, Serialize)]
struct RulesetSummary {
    id: u64,
    name: String,
    source_type: String,
    source: String,
    enforcement: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct RuleSuite {
    id: u64,
    actor_name: Option<String>,
    before_sha: String,
    after_sha: String,
    #[serde(rename = "ref")]
    git_ref: String,
    pushed_at: String,
    result: String,
    #[serde(default)]
    evaluation_result: Option<String>,
    #[serde(default)]
    rule_evaluations: Vec<Value>,
}

#[derive(Debug, Serialize)]
struct RulesReport {
    schema_version: u32,
    repository: String,
    rulesets: Vec<RulesetSummary>,
    suites: Vec<RuleSuite>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
struct PropertyDefinition {
    property_name: String,
    value_type: String,
    #[serde(default)]
    required: bool,
    #[serde(default)]
    default_value: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    allowed_values: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct PropertySchema {
    schema_version: u32,
    properties: Vec<PropertyDefinition>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum PropertyAction {
    Create,
    Update,
    Unchanged,
}

#[derive(Debug, Serialize)]
struct PropertyPlan {
    property_name: String,
    action: PropertyAction,
}

#[derive(Debug, Serialize)]
struct PropertiesReport {
    schema_version: u32,
    organization: String,
    applied: bool,
    changes: Vec<PropertyPlan>,
}

pub fn rules(limit: u8, suite: Option<u64>, output_json: bool) -> Result<()> {
    let repository = gh_text(&[
        "repo",
        "view",
        "--json",
        "nameWithOwner",
        "--jq",
        ".nameWithOwner",
    ])?;
    let rulesets: Vec<RulesetSummary> = gh_json(&format!("repos/{repository}/rulesets"))?;
    let suites = if let Some(suite) = suite {
        vec![gh_json(&format!(
            "repos/{repository}/rulesets/rule-suites/{suite}"
        ))?]
    } else {
        gh_json(&format!(
            "repos/{repository}/rulesets/rule-suites?per_page={limit}"
        ))?
    };
    let report = RulesReport {
        schema_version: 1,
        repository,
        rulesets,
        suites,
    };

    if output_json {
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }

    println!("Ruleset: {}件", report.rulesets.len());
    for ruleset in &report.rulesets {
        println!(
            "- #{} {} [{} / {}]",
            ruleset.id, ruleset.name, ruleset.enforcement, ruleset.source_type
        );
    }
    println!("直近のRule Insights: {}件", report.suites.len());
    for suite in &report.suites {
        let actor = suite.actor_name.as_deref().unwrap_or("unknown");
        println!(
            "- #{} {} {} {} ({})",
            suite.id, suite.result, suite.git_ref, suite.pushed_at, actor
        );
        for evaluation in &suite.rule_evaluations {
            let rule_type = evaluation
                .get("rule_type")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let result = evaluation
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            println!("  - {result}: {rule_type}");
        }
    }
    Ok(())
}

pub fn properties(
    organization: &str,
    schema_path: &Path,
    apply: bool,
    dry_run: bool,
    yes: bool,
    output_json: bool,
) -> Result<()> {
    if apply && dry_run {
        bail!("`--apply`と`--dry-run`は同時に指定できません");
    }
    if apply && !yes {
        bail!("Custom Propertiesを変更するには`--apply --yes`を指定してください");
    }
    validate_organization(organization)?;

    let contents = std::fs::read_to_string(schema_path)
        .with_context(|| format!("{}を読み込めませんでした", schema_path.display()))?;
    let desired: PropertySchema = serde_json::from_str(&contents).with_context(|| {
        format!(
            "{}は正しいCustom Properties schemaではありません",
            schema_path.display()
        )
    })?;
    if desired.schema_version != 1 {
        bail!(
            "未対応のCustom Properties schema versionです: {}",
            desired.schema_version
        );
    }
    validate_properties(&desired.properties)?;

    let current: Vec<PropertyDefinition> =
        gh_json(&format!("orgs/{organization}/properties/schema"))?;
    let plans = property_plan(&desired.properties, &current);
    if apply {
        for (definition, plan) in desired.properties.iter().zip(&plans) {
            if plan.action != PropertyAction::Unchanged {
                put_property(organization, definition)?;
            }
        }
    }

    let report = PropertiesReport {
        schema_version: 1,
        organization: organization.to_owned(),
        applied: apply,
        changes: plans,
    };
    if output_json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        println!(
            "Custom Properties: {} ({})",
            organization,
            if apply { "適用済み" } else { "dry-run" }
        );
        for change in &report.changes {
            let action = match change.action {
                PropertyAction::Create => "作成",
                PropertyAction::Update => "更新",
                PropertyAction::Unchanged => "変更なし",
            };
            println!("- {action}: {}", change.property_name);
        }
        if !apply
            && report
                .changes
                .iter()
                .any(|plan| plan.action != PropertyAction::Unchanged)
        {
            println!("適用する場合: 同じコマンドへ`--apply --yes`を追加してください");
        }
    }
    Ok(())
}

fn property_plan(
    desired: &[PropertyDefinition],
    current: &[PropertyDefinition],
) -> Vec<PropertyPlan> {
    let current = current
        .iter()
        .map(|property| (property.property_name.as_str(), property))
        .collect::<BTreeMap<_, _>>();
    desired
        .iter()
        .map(|property| PropertyPlan {
            property_name: property.property_name.clone(),
            action: match current.get(property.property_name.as_str()) {
                None => PropertyAction::Create,
                Some(existing) if *existing == property => PropertyAction::Unchanged,
                Some(_) => PropertyAction::Update,
            },
        })
        .collect()
}

fn put_property(organization: &str, property: &PropertyDefinition) -> Result<()> {
    let endpoint = format!(
        "orgs/{organization}/properties/schema/{}",
        property.property_name
    );
    let mut body = json!({
        "value_type": property.value_type,
        "required": property.required,
    });
    let object = body
        .as_object_mut()
        .context("Custom Property requestを構築できませんでした")?;
    if let Some(default_value) = &property.default_value {
        object.insert("default_value".into(), json!(default_value));
    }
    if let Some(description) = &property.description {
        object.insert("description".into(), json!(description));
    }
    if !property.allowed_values.is_empty() {
        object.insert("allowed_values".into(), json!(property.allowed_values));
    }
    gh_json_input(&endpoint, "PUT", &body)?;
    Ok(())
}

fn validate_organization(value: &str) -> Result<()> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        bail!("Organization名は英数字とhyphenだけで指定してください");
    }
    Ok(())
}

fn validate_properties(properties: &[PropertyDefinition]) -> Result<()> {
    let mut names = BTreeMap::new();
    for property in properties {
        if property.property_name.is_empty()
            || !property
                .property_name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            bail!("不正なCustom Property名です: {}", property.property_name);
        }
        if names.insert(property.property_name.as_str(), ()).is_some() {
            bail!(
                "Custom Property名が重複しています: {}",
                property.property_name
            );
        }
        if !matches!(
            property.value_type.as_str(),
            "string" | "single_select" | "multi_select" | "true_false" | "url"
        ) {
            bail!(
                "{}のvalue_typeはGitHub未対応です: {}",
                property.property_name,
                property.value_type
            );
        }
        if matches!(
            property.value_type.as_str(),
            "single_select" | "multi_select"
        ) && property.allowed_values.is_empty()
        {
            bail!("{}にはallowed_valuesが必要です", property.property_name);
        }
    }
    Ok(())
}

fn gh_text(args: &[&str]) -> Result<String> {
    let output = Command::new("gh")
        .args(args)
        .output()
        .context("ghを起動できませんでした")?;
    if !output.status.success() {
        bail!(
            "gh failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn gh_json<T>(endpoint: &str) -> Result<T>
where
    T: for<'de> Deserialize<'de>,
{
    let output = Command::new("gh")
        .args(["api", endpoint])
        .output()
        .context("gh apiを起動できませんでした")?;
    if !output.status.success() {
        bail!(
            "GitHub APIの読み取りに失敗しました: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    serde_json::from_slice(&output.stdout).context("GitHub APIの応答が正しいJSONではありません")
}

fn gh_json_input(endpoint: &str, method: &str, body: &Value) -> Result<Value> {
    let mut child = Command::new("gh")
        .args(["api", "--method", method, endpoint, "--input", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("gh apiを起動できませんでした")?;
    child
        .stdin
        .take()
        .context("gh apiのstdinを開けませんでした")?
        .write_all(&serde_json::to_vec(body)?)
        .context("gh apiへJSONを渡せませんでした")?;
    let output = child
        .wait_with_output()
        .context("gh apiの完了を待てませんでした")?;
    if !output.status.success() {
        bail!(
            "GitHub APIの書き込みに失敗しました: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    serde_json::from_slice(&output.stdout).context("GitHub APIの応答が正しいJSONではありません")
}

#[cfg(test)]
mod tests {
    use super::{
        PropertyAction, PropertyDefinition, property_plan, validate_organization,
        validate_properties,
    };

    fn property(name: &str, value_type: &str) -> PropertyDefinition {
        PropertyDefinition {
            property_name: name.into(),
            value_type: value_type.into(),
            required: true,
            default_value: None,
            description: None,
            allowed_values: if value_type == "single_select" {
                vec!["one".into()]
            } else {
                Vec::new()
            },
        }
    }

    #[test]
    fn plans_create_update_and_unchanged_without_deleting_unmanaged_properties() {
        let desired = vec![
            property("new", "string"),
            property("changed", "single_select"),
            property("same", "string"),
        ];
        let current = vec![
            property("changed", "string"),
            property("same", "string"),
            property("unmanaged", "string"),
        ];
        let actions = property_plan(&desired, &current)
            .into_iter()
            .map(|plan| plan.action)
            .collect::<Vec<_>>();

        assert_eq!(
            actions,
            vec![
                PropertyAction::Create,
                PropertyAction::Update,
                PropertyAction::Unchanged
            ]
        );
    }

    #[test]
    fn rejects_unsafe_organization_and_invalid_property_shapes() {
        assert!(validate_organization("art-tra2021").is_ok());
        assert!(validate_organization("../other").is_err());
        assert!(validate_properties(&[property("owner_team", "string")]).is_ok());
        assert!(validate_properties(&[property("name", "unknown")]).is_err());
        let duplicate = property("same", "string");
        assert!(validate_properties(&[duplicate.clone(), duplicate]).is_err());
    }
}
