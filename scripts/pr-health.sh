#!/usr/bin/env bash
set -euo pipefail

: "${GH_REPO:?GH_REPO is required}"
prs="$(gh pr list --repo "$GH_REPO" --state open --limit 100 \
	--json number,title,url,mergeStateStatus,updatedAt,additions,deletions,files)"
now_epoch="${NOW_EPOCH:-$(date +%s)}"

echo "## PR health" >>"$GITHUB_STEP_SUMMARY"
count="$(jq 'length' <<<"$prs")"
echo "Open PR: ${count}" >>"$GITHUB_STEP_SUMMARY"
jq -r '
  .[]
  | "- [#\(.number)](\(.url)): \(.additions + .deletions) changed lines (+\(.additions) / -\(.deletions))"
' <<<"$prs" >>"$GITHUB_STEP_SUMMARY"

while IFS= read -r row; do
	number="$(jq -r '.number' <<<"$row")"
	state="$(jq -r '.mergeStateStatus' <<<"$row")"
	updated="$(jq -r '.updatedAt' <<<"$row")"
	age_days="$(
		jq -nr --arg updated "$updated" --argjson now "$now_epoch" \
			'((($now - ($updated | fromdateiso8601)) / 86400) | floor)'
	)"

	if [[ "$state" == "DIRTY" ]]; then
		gh pr edit "$number" --repo "$GH_REPO" --add-label "status/conflict" >/dev/null
	else
		gh pr edit "$number" --repo "$GH_REPO" --remove-label "status/conflict" >/dev/null 2>&1 || true
	fi
	if [[ "$state" == "BEHIND" || "$age_days" -ge 3 ]]; then
		gh pr edit "$number" --repo "$GH_REPO" --add-label "status/needs-update" >/dev/null
	else
		gh pr edit "$number" --repo "$GH_REPO" --remove-label "status/needs-update" >/dev/null 2>&1 || true
	fi
done < <(jq -c '.[]' <<<"$prs")

jq -r '
  [ .[] | {number, title, url, files: [.files[].path]} ] as $prs
  | range(0; $prs|length) as $i
  | range($i + 1; $prs|length) as $j
  | [ $prs[$i].files[] as $f | select($prs[$j].files | index($f)) | $f ] as $shared
  | select($shared|length > 0)
  | "- ⚠️ #\($prs[$i].number) / #\($prs[$j].number): \($shared | join(", "))"
' <<<"$prs" >>"$GITHUB_STEP_SUMMARY"
