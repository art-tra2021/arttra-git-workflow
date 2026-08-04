#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
policy_script="${script_dir}/pr-policy.sh"
annotation_lib="${script_dir}/pr-policy-annotation-lib.sh"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

gh() {
	if [[ "$1" == "api" ]]; then
		if [[ "$*" == *"/collaborators/"*"/permission"* ]]; then
			printf '%s\n' "$MOCK_REPO_PERMISSION"
		elif [[ "$*" == *"/pulls/1/files"* ]]; then
			printf '%s\n' "$MOCK_CHANGED_PATHS"
		else
			printf 'unexpected gh api invocation: %s\n' "$*" >&2
			return 99
		fi
		printf 'called\n' >>"$MOCK_API_CALL_LOG"
		return 0
	fi
	case "$1 $2" in
	"pr view")
		printf '%s\n' "$MOCK_PR_JSON"
		;;
	"issue view")
		if [[ "$3" == "$MOCK_PARENT_URL" ]]; then
			jq -cn \
				--argjson labels "$(jq -Rn '[inputs | {name: .}]' <<<"$MOCK_PARENT_LABELS")" \
				--arg url "$MOCK_PARENT_URL" \
				--arg grandparent "$MOCK_GRANDPARENT_URL" \
				--argjson closing_prs "$MOCK_PARENT_CLOSING_PRS" \
				'{number: 41, labels: $labels, url: $url, parent: (if $grandparent == "" then null else {url: $grandparent} end), subIssues: {nodes: [], totalCount: 1}, closedByPullRequestsReferences: $closing_prs}'
		elif [[ "$3" == "$MOCK_GRANDPARENT_URL" ]]; then
			jq -cn \
				--argjson labels "$(jq -Rn '[inputs | {name: .}]' <<<"$MOCK_GRANDPARENT_LABELS")" \
				--arg url "$MOCK_GRANDPARENT_URL" \
				'{number: 40, labels: $labels, url: $url, parent: null, subIssues: {nodes: [], totalCount: 1}, closedByPullRequestsReferences: []}'
		else
			jq -cn \
				--argjson labels "$(jq -Rn '[inputs | {name: .}]' <<<"$MOCK_ISSUE_LABELS")" \
				--arg parent "$MOCK_PARENT_URL" \
				--argjson child_count "$MOCK_TASK_CHILD_COUNT" \
				--argjson closing_prs "$MOCK_TASK_CLOSING_PRS" \
				'{number: 42, labels: $labels, url: "https://github.com/test/repo/issues/42", parent: (if $parent == "" then null else {url: $parent} end), subIssues: {nodes: [], totalCount: $child_count}, closedByPullRequestsReferences: $closing_prs}'
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
	local changed_files="${5:-1}"
	jq -cn \
		--arg author "$author" \
		--arg head_ref "$head_ref" \
		--arg body "$body" \
		--argjson changed_files "$changed_files" \
		--argjson closing_issues "$closing_issues" \
		'{author: {login: $author}, body: $body, changedFiles: $changed_files, headRefName: $head_ref, closingIssuesReferences: $closing_issues, reviews: []}'
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
export MOCK_GRANDPARENT_LABELS="type/intake"
export MOCK_GRANDPARENT_URL="https://github.com/test/repo/issues/40"
export MOCK_TASK_CHILD_COUNT=0
export MOCK_TASK_CLOSING_PRS='[{"number": 1}]'
export MOCK_PARENT_CLOSING_PRS='[]'
export MOCK_REPO_PERMISSION="admin"
export MOCK_CHANGED_PATHS="src/lib.rs"
export MOCK_PR_JSON

annotation_output="$({
	GITHUB_ACTIONS=true bash -c '
		source "$1"
		pr_policy_error "AR-PR-004" $'"'"'line 1%\r\nline 2'"'"'
	' _ "$annotation_lib"
} 2>&1)"
if ! grep -Fq '::error title=AR-PR-004::AR-PR-004: line 1%25%0D%0Aline 2' <<<"$annotation_output"; then
	printf 'not ok - policy-annotation-escaping\n%s\n' "$annotation_output" >&2
	exit 1
fi
printf 'ok - policy-annotation-escaping\n'

MOCK_PR_JSON="$(make_pr_json "alice" "feature/86-policy" '[]' 'No linked Task')"
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

MOCK_PR_JSON="$(make_pr_json "rozwer" "feature/42-policy" '[{"number": 42}]')"
run_policy "single-primary-task" 0 "Issue #42: 本人マージ可"
if [[ "$(wc -l <"$MOCK_API_CALL_LOG" | tr -d ' ')" -ne 5 ]]; then
	printf 'not ok - single-primary-task: expected hierarchy, permission, and changed-path queries\n' >&2
	exit 1
fi

MOCK_TASK_CLOSING_PRS='[]'
MOCK_PR_JSON="$(make_pr_json "rozwer" "feature/42-policy" '[]')"
run_policy "stacked-pr-bare-closing-task" 0 "Issue #42: 本人マージ可"

MOCK_PR_JSON="$(make_pr_json "rozwer" "feature/42-policy" '[]' $'Closes test/repo#42\nRelates to https://github.com/test/repo/issues/41')"
run_policy "stacked-pr-same-repo-short-reference" 0 "Issue #42: 本人マージ可"

MOCK_PR_JSON="$(make_pr_json "rozwer" "feature/42-policy" '[]' $'Resolves https://github.com/test/repo/issues/42\nRelates to https://github.com/test/repo/issues/41')"
run_policy "stacked-pr-same-repo-url" 0 "Issue #42: 本人マージ可"

MOCK_PR_JSON="$(make_pr_json "alice" "feature/42-policy" '[]' 'Closes other/repo#42')"
run_policy "reject-stacked-cross-repo-closing-task" 1 "AR-PR-018"

MOCK_PR_JSON="$(make_pr_json "alice" "feature/42-policy" '[]' $'Closes #42\nFixes #43')"
run_policy "reject-ambiguous-stacked-closing-tasks" 1 "AR-PR-005"
MOCK_TASK_CLOSING_PRS='[{"number": 1}]'

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

MOCK_PR_JSON="$(make_pr_json "alice" "feature/42-policy" '[{"number": 42}]')"
MOCK_TASK_CHILD_COUNT=1
run_policy "reject-task-with-children" 1 "AR-ISSUE-006"
MOCK_TASK_CHILD_COUNT=0

MOCK_TASK_CLOSING_PRS='[{"number": 1}, {"number": 2}]'
run_policy "reject-second-task-closing-pr" 1 "AR-PR-012"
MOCK_TASK_CLOSING_PRS='[{"number": 1}]'

MOCK_GRANDPARENT_URL=""
run_policy "reject-work-without-intake-ancestor" 1 "AR-ISSUE-004"
MOCK_GRANDPARENT_URL="https://github.com/test/repo/issues/40"

MOCK_GRANDPARENT_LABELS="type/work"
run_policy "reject-invalid-intake-ancestor" 1 "AR-ISSUE-005"
MOCK_GRANDPARENT_LABELS="type/intake"

MOCK_PR_JSON="$(make_pr_json "rozwer" "feature/42-policy" '[{"number": 42}]')"
run_policy "accept-complete-ancestor-chain" 0 "本人マージ可"

MOCK_PR_JSON="$(make_pr_json "alice" "feature/42-policy" '[{"number": 42}]')"
run_policy "reject-unauthorized-self-label" 1 "AR-PR-014"

MOCK_PR_JSON="$(make_pr_json "rozwer" "feature/42-policy" '[{"number": 42}]')"
MOCK_REPO_PERMISSION="read"
run_policy "reject-self-without-required-permission" 1 "AR-PR-015"
MOCK_REPO_PERMISSION="admin"

MOCK_CHANGED_PATHS="governance/ruleset.json"
run_policy "reject-high-risk-self-merge" 1 "AR-PR-016"
MOCK_CHANGED_PATHS="src/lib.rs"

MOCK_PR_JSON="$(make_pr_json "rozwer" "feature/42-policy" '[{"number": 42}]' '' 2)"
run_policy "reject-incomplete-changed-path-list" 1 "AR-PR-017"

MOCK_ISSUE_LABELS=$'type/task\nmerge/emergency'
MOCK_CHANGED_PATHS="governance/ruleset.json"
MOCK_PR_JSON="$(make_pr_json "rozwer" "hotfix/42-policy" '[{"number": 42}]')"
run_policy "accept-authorized-high-risk-emergency" 0 "緊急マージ"

MOCK_PR_JSON="$(make_pr_json "alice" "hotfix/42-policy" '[{"number": 42}]')"
run_policy "reject-unauthorized-emergency-label" 1 "AR-PR-014"

MOCK_ISSUE_LABELS=$'type/task\nmerge/self'
MOCK_CHANGED_PATHS="src/lib.rs"

MOCK_ISSUE_LABELS=$'type/task\nmerge/review'
MOCK_PR_JSON="$(make_pr_json "alice" "feature/42-policy" '[{"number": 42}]')"
GITHUB_ACTIONS=true run_policy "review-approval-wait-annotation" 1 "::error title=AR-PR-004::AR-PR-004: merge/review"

MOCK_ISSUE_LABELS=$'type/task\nmerge/self'

MOCK_PR_JSON="$(make_pr_json "app/dependabot" "dependabot/cargo/serde-1" '[]')"
run_policy "dependabot-exception" 0 "Issue関連付けを免除"

MOCK_PR_JSON="$(make_pr_json "app/renovate" "renovate/bun" '[{"number": 42}, {"number": 43}]')"
run_policy "renovate-exception" 0 "Issue関連付けを免除"
