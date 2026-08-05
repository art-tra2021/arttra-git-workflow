#!/usr/bin/env bash
set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/arttra-project-status-audit-test.XXXXXX")"

cleanup() {
	case "$test_root" in
	"${TMPDIR:-/tmp}"/arttra-project-status-audit-test.*) rm -rf -- "$test_root" ;;
	*) printf 'refusing to remove unexpected test directory: %s\n' "$test_root" >&2 ;;
	esac
}
trap cleanup EXIT

fail() {
	printf 'Project status audit test failed: %s\n' "$1" >&2
	exit 1
}

fake_git_ar="$test_root/git-ar"
# These variables are intentionally expanded by the generated mock, not by this test process.
# shellcheck disable=SC2016
printf '%s\n' \
	'#!/usr/bin/env bash' \
	'set -euo pipefail' \
	'printf "%s\\n" "$*" >>"$MOCK_COMMAND_LOG"' \
	'printf "%s\\n" "$MOCK_AUDIT_JSON"' \
	'exit "${MOCK_EXIT_CODE:-0}"' >"$fake_git_ar"
chmod +x "$fake_git_ar"

export GIT_AR_BIN="$fake_git_ar"
export MOCK_COMMAND_LOG="$test_root/commands.log"
export MOCK_AUDIT_JSON
export MOCK_EXIT_CODE=0

clean_summary="$test_root/clean-summary.md"
MOCK_AUDIT_JSON="$(jq -cn '{schema_version: 1, status: "clean", project: {owner: "art-tra2021", number: 8, url: "https://github.example/orgs/art-tra2021/projects/8"}, checked_project_items: 2, checked_labeled_issues: 2, diagnostics: []}')"
GITHUB_STEP_SUMMARY="$clean_summary" bash "$repository_root/scripts/project-status-audit.sh" >/dev/null
grep -Fq 'Status: **clean**' "$clean_summary" || fail 'clean summary is missing'

drift_summary="$test_root/drift-summary.md"
MOCK_AUDIT_JSON="$(jq -cn '{schema_version: 1, status: "drift", project: {owner: "art-tra2021", number: 8, url: "https://github.example/orgs/art-tra2021/projects/8"}, checked_project_items: 1, checked_labeled_issues: 1, diagnostics: [{code: "AR-PROJECT-STATUS-001", issue_url: "https://github.example/org/repo/issues/1", project_value: "Ready", label_values: ["status/in-progress"], detail: "mismatch", recommendation: "status/todoへ手作業で付け替える"}]}')"
if GITHUB_STEP_SUMMARY="$drift_summary" bash "$repository_root/scripts/project-status-audit.sh" >/dev/null 2>&1; then
	fail 'drift unexpectedly passed the scheduled gate'
fi
grep -Fq 'AR-PROJECT-STATUS-001' "$drift_summary" || fail 'drift diagnostic is missing'
grep -Fq 'status/todoへ手作業で付け替える' "$drift_summary" || fail 'drift fix is missing'

failed_summary="$test_root/failed-summary.md"
MOCK_AUDIT_JSON="$(jq -cn '{schema_version: 1, status: "failed", project: {owner: "art-tra2021", number: 8, url: "https://github.example/orgs/art-tra2021/projects/8"}, checked_project_items: 0, checked_labeled_issues: 0, diagnostics: [{code: "AR-PROJECT-STATUS-007", issue_url: null, project_value: null, label_values: [], detail: "permission denied", recommendation: "project read権限を確認する"}]}')"
MOCK_EXIT_CODE=1
if GITHUB_STEP_SUMMARY="$failed_summary" bash "$repository_root/scripts/project-status-audit.sh" >/dev/null 2>&1; then
	fail 'permission failure unexpectedly passed the scheduled gate'
fi
grep -Fq 'permission denied' "$failed_summary" || fail 'permission diagnostic is missing'

if grep -Ev '^project-status-audit --json$' "$MOCK_COMMAND_LOG" | grep -q .; then
	fail 'audit invoked a command other than the read-only entrypoint'
fi
[[ "$(wc -l <"$MOCK_COMMAND_LOG" | tr -d ' ')" == "3" ]] || fail 'unexpected command count'

printf 'Project status audit tests passed\n'
