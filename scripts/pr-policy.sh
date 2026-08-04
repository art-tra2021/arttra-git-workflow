#!/usr/bin/env bash
set -euo pipefail

: "${GH_REPO:?GH_REPO is required}"
: "${PR_NUMBER:?PR_NUMBER is required}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./issue-policy-lib.sh
# The library is resolved from this script's directory at runtime.
# shellcheck disable=SC1091
source "${script_dir}/issue-policy-lib.sh"

pr_json="$(
	gh pr view "$PR_NUMBER" --repo "$GH_REPO" \
		--json author,body,closingIssuesReferences,headRefName,reviews
)"
author="$(jq -r '.author.login' <<<"$pr_json")"
body="$(jq -r '.body // ""' <<<"$pr_json")"
head_ref="$(jq -r '.headRefName' <<<"$pr_json")"
closing_issue_count="$(jq -r '(.closingIssuesReferences // []) | length' <<<"$pr_json")"
closing_issue_source="native"

resolve_body_closing_issue() {
	local match reference reference_lower repository number repository_lower
	local -a matches=()
	while IFS= read -r match; do
		if [[ -n "$match" ]]; then
			matches+=("$match")
		fi
	done < <(
		grep -Eio '(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]+(#[1-9][0-9]*|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[1-9][0-9]*|https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/[1-9][0-9]*)' <<<"$body" || true
	)

	closing_issue_count="${#matches[@]}"
	if [[ "$closing_issue_count" -ne 1 ]]; then
		return 0
	fi
	reference="$(sed -E 's/^[^[:space:]]+[[:space:]]+//' <<<"${matches[0]}")"
	reference_lower="$(tr '[:upper:]' '[:lower:]' <<<"$reference")"
	if [[ "$reference_lower" =~ ^#([1-9][0-9]*)$ ]]; then
		repository="$GH_REPO"
		number="${BASH_REMATCH[1]}"
	elif [[ "$reference_lower" =~ ^https://github\.com/([^/]+)/([^/]+)/issues/([1-9][0-9]*)$ ]]; then
		repository="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
		number="${BASH_REMATCH[3]}"
	elif [[ "$reference_lower" =~ ^([^/]+)/([^#]+)#([1-9][0-9]*)$ ]]; then
		repository="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
		number="${BASH_REMATCH[3]}"
	else
		closing_issue_count=0
		return 0
	fi
	repository_lower="$(tr '[:upper:]' '[:lower:]' <<<"$GH_REPO")"
	if [[ "$repository" != "$repository_lower" ]]; then
		echo "AR-PR-018: stacked PRのclosing keywordは同一repositoryのTaskだけを指定できます（現在: ${reference}）。このPRのTaskを \`Closes #<Task番号>\` で1件だけ指定し、cross-repository IssueはRelates toへ変更してください。" >&2
		return 1
	fi
	issue_number="$number"
	closing_issue_source="body"
}

# GitHubが検証した依存更新Appだけは、Issueを別途作らずCIを正本にする。
# branch名だけでは信用せず、Appのloginとprefixの両方を照合する。
if [[ "$author" == "app/dependabot" && "$head_ref" == dependabot/* ]] ||
	[[ "$author" == "app/renovate" && "$head_ref" == renovate/* ]]; then
	echo "✓ ${author}: 自動依存更新PR（Issue関連付けを免除）"
	exit 0
fi

issue_number=""
if [[ "$closing_issue_count" -eq 0 ]]; then
	resolve_body_closing_issue
fi

if [[ "$closing_issue_count" -eq 0 ]]; then
	echo "AR-PR-001: PRにIssueが関連付いていません。本文へ \`Closes #123\` を追加してください。stacked PRではGitHubのclosingIssuesReferencesが空になるため、同一repositoryのTaskをclosing keywordで明記してください。" >&2
	exit 1
fi

if [[ "$closing_issue_count" -ne 1 ]]; then
	echo "AR-PR-005: primary closing Taskはちょうど1件にしてください（現在${closing_issue_count}件）。本文の \`Closes #123\` はTask 1件だけにし、親Work / Businessはnative parentの完全なIssue URLを \`Relates to https://github.com/owner/repo/issues/456\` で記載してください。" >&2
	exit 1
fi

if [[ -z "$issue_number" ]]; then
	issue_number="$(jq -r '.closingIssuesReferences[0].number' <<<"$pr_json")"
fi
branch_issue="${head_ref#*/}"
branch_issue="${branch_issue%%-*}"
if [[ ! "$branch_issue" =~ ^[1-9][0-9]*$ || "$branch_issue" != "$issue_number" ]]; then
	echo "AR-PR-007: branch \`${head_ref}\` とprimary closing Task #${issue_number}が一致しません。Task #${issue_number}から\`git ar branch\`でbranchを作り直すか、PRの\`Closes\`をbranchのTaskに揃えてください。" >&2
	exit 1
fi

issue_json="$(issue_policy_load_issue "$issue_number")"
labels="$(jq -r '.labels[].name' <<<"$issue_json")"
issue_types="$(grep -E '^type/' <<<"$labels" || true)"
issue_type_count="$(grep -Ec '^type/' <<<"$labels" || true)"
if [[ "$issue_type_count" -ne 1 || "$issue_types" != "type/task" ]]; then
	display_type="${issue_types//$'\n'/, }"
	display_type="${display_type:-typeラベルなし}"
	echo "AR-PR-006: primary closing Task #${issue_number} は type/task である必要があります（現在: ${display_type}）。Work / Business / Intakeを直接Closesせず、その配下にPR 1件で完了できるTaskを作成し、PR本文を \`Closes #<Task番号>\` に変更してください。" >&2
	exit 1
fi

mode_count="$(grep -Ec '^merge/' <<<"$labels" || true)"
mode="$(grep -E '^merge/' <<<"$labels" || true)"
if [[ "$mode_count" -ne 1 || ! "$mode" =~ ^merge/(review|self|emergency)$ ]]; then
	echo "AR-PR-002: Issue #${issue_number} に merge/review, merge/self, merge/emergency のどれか一つを付けてください。" >&2
	exit 1
fi

parent_url="$(jq -r '.parent.url // empty' <<<"$issue_json")"
if [[ -z "$parent_url" ]]; then
	echo "AR-PR-008: Task #${issue_number}にnative parentがありません。親WorkまたはBusinessを設定してください。" >&2
	exit 1
fi
parent_json="$(issue_policy_load_issue "$parent_url")"
parent_labels="$(jq -r '.labels[].name' <<<"$parent_json")"
parent_types="$(grep -E '^type/' <<<"$parent_labels" || true)"
parent_type_count="$(wc -l <<<"$parent_types" | tr -d ' ')"
if [[ -z "$parent_types" ]]; then
	parent_type_count=0
fi
if [[ "$parent_type_count" -ne 1 || ! "$parent_types" =~ ^type/(work|business)$ ]]; then
	echo "AR-PR-009: Task #${issue_number}の親はtype/workまたはtype/businessである必要があります（現在: ${parent_types:-typeラベルなし}）。" >&2
	exit 1
fi
if grep -Eq '^merge/' <<<"$parent_labels"; then
	echo "AR-PR-011: Task #${issue_number}の親にmergeラベルがあります。merge方針はtype/taskだけに設定し、親Work / Businessからmergeラベルを外してください。" >&2
	exit 1
fi
issue_policy_validate_task_terminal "$issue_json" "$PR_NUMBER" "$closing_issue_source"
issue_policy_validate_hierarchy_json "$parent_json"
if ! grep -Fxq "Relates to ${parent_url}" <<<"$body"; then
	echo "AR-PR-010: PR本文へTaskの実際の親を \`Relates to ${parent_url}\` と記載してください。" >&2
	exit 1
fi

case "$mode" in
merge/self)
	echo "✓ Issue #${issue_number}: 本人マージ可"
	;;
merge/emergency)
	if [[ "$head_ref" != hotfix/* ]]; then
		echo "AR-PR-003: 緊急マージは hotfix/ で始まるbranchから行ってください。" >&2
		exit 1
	fi
	echo "✓ Issue #${issue_number}: 緊急マージ（事後レビュー対象）"
	;;
merge/review)
	approved="$(
		jq -r --arg author "$author" '
        .reviews
        | sort_by(.submittedAt)
        | group_by(.author.login)
        | map(last)
        | .[]
        | select(.author.login != $author and .state == "APPROVED")
        | .author.login
      ' <<<"$pr_json"
	)"
	if [[ -z "$approved" ]]; then
		echo "AR-PR-004: merge/review ではPR作成者以外の承認が1件必要です。" >&2
		exit 1
	fi
	echo "✓ Issue #${issue_number}: $(tr '\n' ',' <<<"$approved" | sed 's/,$//') が承認済み"
	;;
esac
