#!/usr/bin/env bash
set -euo pipefail

: "${GH_REPO:?GH_REPO is required}"
: "${PR_NUMBER:?PR_NUMBER is required}"

pr_json="$(
	gh pr view "$PR_NUMBER" --repo "$GH_REPO" \
		--json author,closingIssuesReferences,headRefName,reviews
)"
author="$(jq -r '.author.login' <<<"$pr_json")"
head_ref="$(jq -r '.headRefName' <<<"$pr_json")"
closing_issue_count="$(jq -r '(.closingIssuesReferences // []) | length' <<<"$pr_json")"

# GitHubが検証した依存更新Appだけは、Issueを別途作らずCIを正本にする。
# branch名だけでは信用せず、Appのloginとprefixの両方を照合する。
if [[ "$author" == "app/dependabot" && "$head_ref" == dependabot/* ]] ||
	[[ "$author" == "app/renovate" && "$head_ref" == renovate/* ]]; then
	echo "✓ ${author}: 自動依存更新PR（Issue関連付けを免除）"
	exit 0
fi

if [[ "$closing_issue_count" -eq 0 ]]; then
	echo "AR-PR-001: PRにIssueが関連付いていません。本文へ \`Closes #123\` を追加してください。" >&2
	exit 1
fi

if [[ "$closing_issue_count" -ne 1 ]]; then
	echo "AR-PR-005: primary closing Issueはちょうど1件にしてください（現在${closing_issue_count}件）。本文の \`Closes #123\` は1件だけにし、追加の関連Issueは \`Relates to #456\` などで記載してください。" >&2
	exit 1
fi

issue_number="$(jq -r '.closingIssuesReferences[0].number' <<<"$pr_json")"
labels="$(gh api "repos/${GH_REPO}/issues/${issue_number}" --jq '.labels[].name')"
mode_count="$(grep -Ec '^merge/(review|self|emergency)$' <<<"$labels" || true)"
if [[ "$mode_count" -ne 1 ]]; then
	echo "AR-PR-002: Issue #${issue_number} に merge/review, merge/self, merge/emergency のどれか一つを付けてください。" >&2
	exit 1
fi

mode="$(grep -E '^merge/(review|self|emergency)$' <<<"$labels")"
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
