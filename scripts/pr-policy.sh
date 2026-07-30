#!/usr/bin/env bash
set -euo pipefail

: "${GH_REPO:?GH_REPO is required}"
: "${PR_NUMBER:?PR_NUMBER is required}"

pr_json="$(gh api "repos/${GH_REPO}/pulls/${PR_NUMBER}")"
author="$(jq -r '.user.login' <<<"$pr_json")"
head_ref="$(jq -r '.head.ref' <<<"$pr_json")"
body="$(jq -r '.body // ""' <<<"$pr_json")"

issue_number="$(
  grep -Eio '(close[sd]?|fix(e[sd])?|resolve[sd]?|refs?)[[:space:]]*#[0-9]+' <<<"$body" \
    | grep -Eo '[0-9]+' \
    | head -1 || true
)"
if [[ -z "$issue_number" ]]; then
  echo "AR-PR-001: PR本文に \`Closes #123\` の形式でIssueを関連付けてください。" >&2
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
    reviews="$(
      gh api --paginate "repos/${GH_REPO}/pulls/${PR_NUMBER}/reviews" \
        --jq '.[] | [.user.login, .state, .submitted_at] | @tsv'
    )"
    approved="$(
      awk -F '\t' -v author="$author" '$1 != author {latest[$1]=$2} END {for (user in latest) if (latest[user] == "APPROVED") print user}' \
        <<<"$reviews"
    )"
    if [[ -z "$approved" ]]; then
      echo "AR-PR-004: merge/review ではPR作成者以外の承認が1件必要です。" >&2
      exit 1
    fi
    echo "✓ Issue #${issue_number}: $(tr '\n' ',' <<<"$approved" | sed 's/,$//') が承認済み"
    ;;
esac
