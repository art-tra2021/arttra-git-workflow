use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::policy::{Policy, TelemetryMode};

#[derive(Debug, Deserialize)]
struct Event {
    agent: String,
    decision: String,
    rule_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct Report {
    schema_version: u32,
    enabled: bool,
    total: usize,
    by_agent: BTreeMap<String, usize>,
    by_decision: BTreeMap<String, usize>,
    by_rule: BTreeMap<String, usize>,
}

pub fn report(policy: &Policy, root: &Path, json: bool) -> Result<()> {
    let path = root.join(&policy.telemetry.path);
    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(error).with_context(|| format!("{}を読み込めません", path.display()));
        }
    };

    let mut report = Report {
        schema_version: 1,
        enabled: matches!(policy.telemetry.mode, TelemetryMode::Local),
        total: 0,
        by_agent: BTreeMap::new(),
        by_decision: BTreeMap::new(),
        by_rule: BTreeMap::new(),
    };
    for (index, line) in contents.lines().enumerate() {
        let event: Event = serde_json::from_str(line)
            .with_context(|| format!("telemetryの{}行目が不正です", index + 1))?;
        report.total += 1;
        *report.by_agent.entry(event.agent).or_default() += 1;
        *report.by_decision.entry(event.decision).or_default() += 1;
        if let Some(rule) = event.rule_id {
            *report.by_rule.entry(rule).or_default() += 1;
        }
    }

    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        println!("telemetry events: {}", report.total);
        for (rule, count) in report.by_rule {
            println!("  {rule}: {count}");
        }
        if report.total == 0 {
            println!("  まだ違反イベントはありません。");
        }
    }
    Ok(())
}
