#!/usr/bin/env bash
set -euo pipefail

report_file="$(mktemp "${TMPDIR:-/tmp}/arttra-project-status-audit.XXXXXX")"
cleanup() {
	case "$report_file" in
	"${TMPDIR:-/tmp}"/arttra-project-status-audit.*) rm -f -- "$report_file" ;;
	*) printf 'refusing to remove unexpected audit file: %s\n' "$report_file" >&2 ;;
	esac
}
trap cleanup EXIT

set +e
if [[ -n "${GIT_AR_BIN:-}" ]]; then
	"$GIT_AR_BIN" project-status-audit --json >"$report_file"
else
	mise run ar -- project-status-audit --json >"$report_file"
fi
command_status=$?
set -e

cat "$report_file"
jq -e '
  .schema_version == 1 and
  (.status == "clean" or .status == "drift" or .status == "failed") and
  (.diagnostics | type == "array") and
  all(.diagnostics[];
    (.code | startswith("AR-PROJECT-STATUS-")) and
    (.label_values | type == "array") and
    (.recommendation | type == "string" and length > 0)
  )
' "$report_file" >/dev/null

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
	{
		printf '## Project Status drift audit\n\n'
		jq -r '"Status: **\(.status)**  \nProject items: \(.checked_project_items)  \nstatus label付きIssues: \(.checked_labeled_issues)  \nDiagnostics: \(.diagnostics | length)\n"' "$report_file"
		jq -r '. as $report | .diagnostics[] | "- `\(.code)` [Issue](\(.issue_url // $report.project.url)): \(.detail) 修正案: \(.recommendation)"' "$report_file"
	} >>"$GITHUB_STEP_SUMMARY"
fi

if [[ "$command_status" -ne 0 ]]; then
	printf 'Project status audit command failed with exit code %s\n' "$command_status" >&2
	exit "$command_status"
fi

if ! jq -e '.status == "clean"' "$report_file" >/dev/null; then
	printf 'Project Statusと互換status labelの監査で差分または取得失敗を検出しました\n' >&2
	exit 1
fi
