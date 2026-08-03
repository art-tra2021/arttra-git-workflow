#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
policy_script="${script_dir}/pr-policy.sh"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

gh() {
	case "$1 $2" in
	"pr view")
		printf '%s\n' "$MOCK_PR_JSON"
		;;
	"api repos/test/repo/issues/42")
		printf '%s\n' "$MOCK_ISSUE_LABELS"
		printf 'called\n' >>"$MOCK_API_CALL_LOG"
		;;
	*)
		printf 'unexpected gh invocation: %s\n' "$*" >&2
		return 99
		;;
	esac
}
export -f gh

make_pr_json() {
	local author="$1"
	local head_ref="$2"
	local closing_issues="$3"
	jq -cn \
		--arg author "$author" \
		--arg head_ref "$head_ref" \
		--argjson closing_issues "$closing_issues" \
		'{author: {login: $author}, headRefName: $head_ref, closingIssuesReferences: $closing_issues, reviews: []}'
}

run_policy() {
	local name="$1"
	local expected_status="$2"
	local expected_text="$3"
	local output_file="${test_dir}/${name}.output"
	local status=0

	GH_REPO="test/repo" PR_NUMBER="1" bash "$policy_script" >"$output_file" 2>&1 || status=$?
	if [[ "$status" -ne "$expected_status" ]]; then
		printf 'not ok - %s: expected status %s, got %s\n' "$name" "$expected_status" "$status" >&2
		cat "$output_file" >&2
		return 1
	fi
	if ! grep -Fq "$expected_text" "$output_file"; then
		printf 'not ok - %s: expected output to contain %s\n' "$name" "$expected_text" >&2
		cat "$output_file" >&2
		return 1
	fi
	printf 'ok - %s\n' "$name"
}

export MOCK_API_CALL_LOG="${test_dir}/api-calls"
export MOCK_ISSUE_LABELS="merge/self"
export MOCK_PR_JSON

MOCK_PR_JSON="$(make_pr_json "alice" "feature/86-policy" '[]')"
run_policy "missing-closing-issue" 1 "AR-PR-001"

MOCK_PR_JSON="$(make_pr_json "alice" "feature/86-policy" '[{"number": 42}, {"number": 43}]')"
run_policy "multiple-closing-issues" 1 "AR-PR-005"
if ! grep -Fq 'Relates to #456' "${test_dir}/multiple-closing-issues.output"; then
	printf 'not ok - multiple-closing-issues: secondary relation guidance is missing\n' >&2
	exit 1
fi
if [[ -e "$MOCK_API_CALL_LOG" ]]; then
	printf 'not ok - multiple-closing-issues: merge labels were queried before primary Issue validation\n' >&2
	exit 1
fi

MOCK_PR_JSON="$(make_pr_json "alice" "feature/86-policy" '[{"number": 42}]')"
run_policy "single-primary-closing-issue" 0 "Issue #42: 本人マージ可"
if [[ "$(wc -l <"$MOCK_API_CALL_LOG" | tr -d ' ')" -ne 1 ]]; then
	printf 'not ok - single-primary-closing-issue: expected exactly one merge-label query\n' >&2
	exit 1
fi

MOCK_PR_JSON="$(make_pr_json "app/dependabot" "dependabot/cargo/serde-1" '[]')"
run_policy "dependabot-exception" 0 "Issue関連付けを免除"

MOCK_PR_JSON="$(make_pr_json "app/renovate" "renovate/bun" '[{"number": 42}, {"number": 43}]')"
run_policy "renovate-exception" 0 "Issue関連付けを免除"
