use serde::Serialize;

pub const PARENT_REVIEW_THRESHOLD: usize = 10;
pub const PARENT_STRONG_WARNING_THRESHOLD: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueAuditLevel {
    Notice,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IssueAuditDiagnostic {
    pub code: &'static str,
    pub level: IssueAuditLevel,
    pub non_blocking: bool,
    pub child_count: usize,
    pub open_child_count: usize,
    pub message_ja: String,
    pub fix: String,
}

pub fn parent_diagnostics(
    kind: &str,
    state: &str,
    child_count: usize,
    open_child_count: usize,
) -> Vec<IssueAuditDiagnostic> {
    if !matches!(kind, "work" | "business") {
        return Vec::new();
    }

    let mut diagnostics = Vec::new();
    if child_count > PARENT_STRONG_WARNING_THRESHOLD {
        diagnostics.push(IssueAuditDiagnostic {
            code: "AR-ISSUE-022",
            level: IssueAuditLevel::Warning,
            non_blocking: true,
            child_count,
            open_child_count,
            message_ja: format!(
                "type/{kind}の直属Taskが{child_count}件あります。20件を超えているため、独立して調整できるWorkまたはBusinessへ分割してください"
            ),
            fix: "親Issueの責務を見直し、独立した成果単位を別のWorkまたはBusinessへ分ける".into(),
        });
    } else if child_count >= PARENT_REVIEW_THRESHOLD {
        diagnostics.push(IssueAuditDiagnostic {
            code: "AR-ISSUE-020",
            level: IssueAuditLevel::Notice,
            non_blocking: true,
            child_count,
            open_child_count,
            message_ja: format!(
                "type/{kind}の直属Taskが{child_count}件あります。10件に達したため、親Issueの責務と分割粒度を見直してください"
            ),
            fix: "Taskを拒否せず作成を続けられます。次のTaskを追加する前に親Issueの分割要否を確認する".into(),
        });
    }

    if state.eq_ignore_ascii_case("closed") && open_child_count > 0 {
        diagnostics.push(IssueAuditDiagnostic {
            code: "AR-ISSUE-021",
            level: IssueAuditLevel::Warning,
            non_blocking: true,
            child_count,
            open_child_count,
            message_ja: format!(
                "閉じたtype/{kind}に未完了の直属Taskが{open_child_count}件残っています"
            ),
            fix:
                "親Issueを再openするか、未完了Taskを適切なopen親Issueへ移してから完了状態を確認する"
                    .into(),
        });
    }

    diagnostics
}

#[cfg(test)]
mod tests {
    use super::{IssueAuditLevel, parent_diagnostics};

    #[test]
    fn emits_review_notice_at_ten_without_blocking() {
        let diagnostics = parent_diagnostics("work", "OPEN", 10, 10);
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].code, "AR-ISSUE-020");
        assert_eq!(diagnostics[0].level, IssueAuditLevel::Notice);
        assert!(diagnostics[0].non_blocking);
    }

    #[test]
    fn emits_only_strong_size_warning_above_twenty() {
        let diagnostics = parent_diagnostics("business", "OPEN", 21, 4);
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].code, "AR-ISSUE-022");
        assert_eq!(diagnostics[0].level, IssueAuditLevel::Warning);
        assert!(diagnostics[0].non_blocking);
    }

    #[test]
    fn closed_parent_with_open_children_is_reported_separately() {
        let diagnostics = parent_diagnostics("work", "CLOSED", 21, 2);
        assert_eq!(
            diagnostics
                .iter()
                .map(|diagnostic| diagnostic.code)
                .collect::<Vec<_>>(),
            vec!["AR-ISSUE-022", "AR-ISSUE-021"]
        );
    }

    #[test]
    fn lower_counts_and_non_parent_kinds_are_clean() {
        assert!(parent_diagnostics("work", "OPEN", 9, 9).is_empty());
        assert!(parent_diagnostics("task", "CLOSED", 30, 3).is_empty());
        assert!(parent_diagnostics("intake", "CLOSED", 30, 3).is_empty());
    }
}
