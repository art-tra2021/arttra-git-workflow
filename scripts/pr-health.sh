#!/usr/bin/env bash
set -euo pipefail

: "${GH_REPO:?GH_REPO is required}"
prs="$(gh pr list --repo "$GH_REPO" --state open --limit 100 \
  --json number,title,url,mergeStateStatus,updatedAt,additions,deletions,files)"

echo "## PR health" >>"$GITHUB_STEP_SUMMARY"
count="$(jq 'length' <<<"$prs")"
echo "Open PR: ${count}" >>"$GITHUB_STEP_SUMMARY"

while IFS= read -r row; do
  number="$(jq -r '.number' <<<"$row")"
  state="$(jq -r '.mergeStateStatus' <<<"$row")"
  changed="$(jq '.additions + .deletions' <<<"$row")"
  updated="$(jq -r '.updatedAt' <<<"$row")"
  age_days="$(( ($(date +%s) - $(date -d "$updated" +%s)) / 86400 ))"

  if (( changed <= 50 )); then size="size/S"
  elif (( changed <= 250 )); then size="size/M"
  elif (( changed <= 800 )); then size="size/L"
  else size="size/XL"
  fi
  for candidate in size/S size/M size/L size/XL; do
    [[ "$candidate" == "$size" ]] ||
      gh pr edit "$number" --repo "$GH_REPO" --remove-label "$candidate" >/dev/null 2>&1 || true
  done
  gh pr edit "$number" --repo "$GH_REPO" --add-label "$size" >/dev/null

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
