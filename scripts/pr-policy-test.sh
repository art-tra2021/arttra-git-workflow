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
	"issue view")
		if [[ "$3" == "$MOCK_PARENT_URL" ]]; then
			jq -cn --argjson labels "$(jq -Rn '[inputs | {name: .}]' <<<"$MOCK_PARENT_LABELS")" --arg url "$MOCK_PARENT_URL" \
				'{labels: $labels, url: $url}'
		else
			jq -cn --argjson labels "$(jq -Rn '[inputs | {name: .}]' <<<"$MOCK_ISSUE_LABELS")" --arg parent "$MOCK_PARENT_URL" \
				'{labels: $labels, parent: (if $parent == "" then null else {url: $parent} end)}'
		fi
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
	local body="${4:-Closes #42
Relates to https://github.com/test/repo/issues/41}"
	jq -cn \
		--arg author "$author" \
		--arg head_ref "$head_ref" \
		--arg body "$body" \
		--argjson closing_issues "$closing_issues" \
		'{author: {login: $author}, body: $body, headRefName: $head_ref, closingIssuesReferences: $closing_issues, reviews: []}'
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
export MOCK_ISSUE_LABELS=$'type/task\nmerge/self'
export MOCK_PARENT_LABELS="type/work"
export MOCK_PARENT_URL="https://github.com/test/repo/issues/41"
export MOCK_PR_JSON

MOCK_PR_JSON="$(make_pr_json "alice" "feature/86-policy" '[]')"
run_policy "missing-closing-issue" 1 "AR-PR-001"

MOCK_PR_JSON="$(make_pr_json "alice" "feature/86-policy" '[{"number": 42}, {"number": 43}]')"
run_policy "multiple-closing-issues" 1 "AR-PR-005"
if ! grep -Fq 'Relates to https://github.com/owner/repo/issues/456' "${test_dir}/multiple-closing-issues.output"; then
	printf 'not ok - multiple-closing-issues: secondary relation guidance is missing\n' >&2
	exit 1
fi
if [[ -e "$MOCK_API_CALL_LOG" ]]; then
	printf 'not ok - multiple-closing-issues: merge labels were queried before primary Issue validation\n' >&2
	exit 1
fi

MOCK_PR_JSON="$(make_pr_json "alice" "feature/42-policy" '[{"number": 42}]')"
run_policy "single-primary-task" 0 "Issue #42: 本人マージ可"
if [[ "$(wc -l <"$MOCK_API_CALL_LOG" | tr -d ' ')" -ne 2 ]]; then
	printf 'not ok - single-primary-task: expected Task and parent queries\n' >&2
	exit 1
fi

MOCK_PR_JSON="$(make_pr_json "alice" "feature/41-policy" '[{"number": 42}]')"
run_policy "reject-branch-task-mismatch" 1 "AR-PR-007"

for issue_type in work business intake; do
	MOCK_ISSUE_LABELS="type/${issue_type}"$'\nmerge/self'
	MOCK_PR_JSON="$(make_pr_json "alice" "feature/42-policy" '[{"number": 42}]')"
	run_policy "reject-closing-${issue_type}" 1 "AR-PR-006"
	if ! grep -Fq 'その配下にPR 1件で完了できるTaskを作成' "${test_dir}/reject-closing-${issue_type}.output"; then
		printf 'not ok - reject-closing-%s: Task作成の修正案がありません\n' "$issue_type" >&2
		exit 1
	fi
done

MOCK_ISSUE_LABELS="merge/self"
run_policy "reject-closing-without-type" 1 "現在: typeラベルなし"

MOCK_ISSUE_LABELS=$'type/task\ntype/work\nmerge/self'
run_policy "reject-multiple-issue-types" 1 "現在: type/task, type/work"

MOCK_ISSUE_LABELS=$'type/task\ntype/custom\nmerge/self'
run_policy "reject-custom-extra-issue-type" 1 "現在: type/task, type/custom"

MOCK_ISSUE_LABELS=$'type/task\nmerge/self\nmerge/custom'
run_policy "reject-custom-extra-merge-mode" 1 "AR-PR-002"

MOCK_ISSUE_LABELS=$'type/task\nmerge/self'
MOCK_PARENT_URL=""
run_policy "reject-task-without-parent" 1 "AR-PR-008"

MOCK_PARENT_URL="https://github.com/test/repo/issues/41"
MOCK_PARENT_LABELS="type/intake"
run_policy "reject-invalid-task-parent" 1 "AR-PR-009"

MOCK_PARENT_LABELS=$'type/work\nmerge/self'
run_policy "reject-merge-mode-on-parent" 1 "AR-PR-011"

MOCK_PARENT_LABELS="type/work"
MOCK_PR_JSON="$(make_pr_json "alice" "feature/42-policy" '[{"number": 42}]' 'Closes #42')"
run_policy "require-actual-parent-relation" 1 "AR-PR-010"

MOCK_PR_JSON="$(make_pr_json "app/dependabot" "dependabot/cargo/serde-1" '[]')"
run_policy "dependabot-exception" 0 "Issue関連付けを免除"

MOCK_PR_JSON="$(make_pr_json "app/renovate" "renovate/bun" '[{"number": 42}, {"number": 43}]')"
run_policy "renovate-exception" 0 "Issue関連付けを免除"
