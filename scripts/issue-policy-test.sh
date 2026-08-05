#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
policy_script="${script_dir}/issue-policy.sh"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

make_issue() {
	local number="$1"
	local labels="$2"
	local parent_url="$3"
	local child_count="$4"
	local closing_prs="$5"
	local state="${6:-OPEN}"
	local open_child_count="${7:-0}"
	jq -cn \
		--argjson number "$number" \
		--arg url "https://github.com/test/repo/issues/${number}" \
		--argjson labels "$(jq -Rn '[inputs | select(length > 0) | {name: .}]' <<<"$labels")" \
		--arg parent "$parent_url" \
		--argjson child_count "$child_count" \
		--argjson closing_prs "$closing_prs" \
		--arg state "$state" \
		--argjson open_child_count "$open_child_count" \
		'{
      number: $number,
      url: $url,
      state: $state,
      labels: $labels,
      parent: (if $parent == "" then null else {url: $parent} end),
      subIssues: {
        nodes: [range(0; $child_count) | {state: (if . < $open_child_count then "OPEN" else "CLOSED" end)}],
        totalCount: $child_count
      },
      closedByPullRequestsReferences: $closing_prs
    }'
}

gh() {
	if [[ "$1 $2" != "issue view" ]]; then
		printf 'unexpected gh invocation: %s\n' "$*" >&2
		return 99
	fi
	case "$3" in
	42) printf '%s\n' "$MOCK_ROOT_JSON" ;;
	"https://github.com/test/repo/issues/41") printf '%s\n' "$MOCK_PARENT_JSON" ;;
	"https://github.com/test/repo/issues/40") printf '%s\n' "$MOCK_INTAKE_JSON" ;;
	*)
		printf 'unexpected Issue reference: %s\n' "$3" >&2
		return 98
		;;
	esac
	printf '%s\n' "$3" >>"$MOCK_API_CALL_LOG"
}
export -f gh

run_policy() {
	local name="$1"
	local expected_status="$2"
	local expected_text="$3"
	local output_file="${test_dir}/${name}.output"
	local status=0

	GH_REPO="test/repo" ISSUE_NUMBER="42" bash "$policy_script" >"$output_file" 2>&1 || status=$?
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
export MOCK_ROOT_JSON MOCK_PARENT_JSON MOCK_INTAKE_JSON

valid_fixtures() {
	MOCK_ROOT_JSON="$(make_issue 42 $'type/task\nmerge/review' "https://github.com/test/repo/issues/41" 0 '[]')"
	MOCK_PARENT_JSON="$(make_issue 41 'type/work' "https://github.com/test/repo/issues/40" 1 '[]')"
	MOCK_INTAKE_JSON="$(make_issue 40 'type/intake' "" 1 '[]')"
	export MOCK_ROOT_JSON MOCK_PARENT_JSON MOCK_INTAKE_JSON
}

valid_fixtures
run_policy "valid-task" 0 "Task末端・closing PRが有効"
run_policy "valid-task-idempotent" 0 "Task末端・closing PRが有効"
if [[ "$(wc -l <"$MOCK_API_CALL_LOG" | tr -d ' ')" -ne 6 ]]; then
	printf 'not ok - valid-task-idempotent: expected the same three deterministic reads per run\n' >&2
	exit 1
fi

valid_fixtures
MOCK_ROOT_JSON="$(make_issue 42 $'type/task\nmerge/review' "https://github.com/test/repo/issues/41" 0 '[{"number": 50}]')"
run_policy "valid-task-with-existing-closing-pr" 0 "Task末端・closing PRが有効"

valid_fixtures
MOCK_ROOT_JSON="$(make_issue 42 'merge/review' "https://github.com/test/repo/issues/41" 0 '[]')"
run_policy "missing-type" 1 "AR-ISSUE-001"
if ! grep -Fq 'Labelsから余分なtype/*を外し' "${test_dir}/missing-type.output"; then
	printf 'not ok - missing-type: actionable label remediation is missing\n' >&2
	exit 1
fi

valid_fixtures
MOCK_ROOT_JSON="$(make_issue 42 $'type/task\ntype/work\nmerge/review' "https://github.com/test/repo/issues/41" 0 '[]')"
run_policy "multiple-types" 1 "AR-ISSUE-001"

valid_fixtures
MOCK_ROOT_JSON="$(make_issue 42 'type/task' "https://github.com/test/repo/issues/41" 0 '[]')"
run_policy "task-without-merge" 1 "AR-ISSUE-002"

valid_fixtures
MOCK_PARENT_JSON="$(make_issue 41 $'type/work\nmerge/self' "https://github.com/test/repo/issues/40" 1 '[]')"
run_policy "merge-on-work-ancestor" 1 "AR-ISSUE-003"

valid_fixtures
MOCK_ROOT_JSON="$(make_issue 42 $'type/task\nmerge/review' "" 0 '[]')"
run_policy "task-without-parent" 1 "AR-ISSUE-004"

valid_fixtures
MOCK_PARENT_JSON="$(make_issue 41 'type/intake' "" 1 '[]')"
run_policy "task-with-invalid-parent" 1 "AR-ISSUE-005"

valid_fixtures
MOCK_ROOT_JSON="$(make_issue 42 $'type/task\nmerge/review' "https://github.com/test/repo/issues/41" 2 '[]')"
run_policy "task-with-children" 1 "AR-ISSUE-006"
if ! grep -Fq '子IssueをTaskの親Work / Businessへ移す' "${test_dir}/task-with-children.output"; then
	printf 'not ok - task-with-children: actionable hierarchy remediation is missing\n' >&2
	exit 1
fi

valid_fixtures
MOCK_ROOT_JSON="$(make_issue 42 $'type/task\nmerge/review' "https://github.com/test/repo/issues/41" 0 '[{"number": 50}, {"number": 51}]')"
run_policy "task-with-multiple-closing-prs" 1 "AR-ISSUE-007"
if ! grep -Fq '他PRのCloses/Fixes/ResolvesをRelates toへ変更' "${test_dir}/task-with-multiple-closing-prs.output"; then
	printf 'not ok - task-with-multiple-closing-prs: actionable PR remediation is missing\n' >&2
	exit 1
fi

valid_fixtures
MOCK_PARENT_JSON="$(make_issue 41 'type/work' "https://github.com/test/repo/issues/40" 1 '[{"number": 50}]')"
run_policy "work-closed-by-pr" 1 "AR-ISSUE-008"

valid_fixtures
MOCK_PARENT_JSON="$(make_issue 41 'type/work' "" 1 '[]')"
run_policy "invalid-grandparent-chain" 1 "AR-ISSUE-004"

valid_fixtures
MOCK_ROOT_JSON="$(make_issue 42 'type/work' "https://github.com/test/repo/issues/40" 10 '[]' 'OPEN' 10)"
run_policy "parent-review-threshold-is-advisory" 0 "AR-ISSUE-020"

valid_fixtures
MOCK_ROOT_JSON="$(make_issue 42 'type/business' "https://github.com/test/repo/issues/40" 21 '[]' 'OPEN' 4)"
run_policy "parent-strong-threshold-is-advisory" 0 "AR-ISSUE-022"
if grep -Fq 'AR-ISSUE-020' "${test_dir}/parent-strong-threshold-is-advisory.output"; then
	printf 'not ok - strong threshold must not duplicate the review notice\n' >&2
	exit 1
fi

valid_fixtures
MOCK_ROOT_JSON="$(make_issue 42 'type/work' "https://github.com/test/repo/issues/40" 4 '[]' 'CLOSED' 2)"
run_policy "closed-parent-with-open-tasks-is-advisory" 0 "AR-ISSUE-021"
