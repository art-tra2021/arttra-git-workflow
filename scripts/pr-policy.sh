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
issue_number="$(jq -r '.closingIssuesReferences[0].number // empty' <<<"$pr_json")"
if [[ -z "$issue_number" ]]; then
	echo "AR-PR-001: PRにIssueが関連付いていません。本文へ \`Closes #123\` を追加してください。" >&2
	exit 1
fi

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
