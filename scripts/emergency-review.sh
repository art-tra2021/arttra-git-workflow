#!/usr/bin/env bash
set -euo pipefail

required_env() {
	local name="$1"
	if [[ -z ${!name:-} ]]; then
		printf 'AR-EMERGENCY-001: %s is required\n' "$name" >&2
		return 1
	fi
}

next_business_day() {
	local merged_at="$1"
	jq -nr --arg merged_at "$merged_at" '
    ($merged_at | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) as $merged_epoch
    | ($merged_epoch + 86400) as $next_day
    | ($next_day | strftime("%w") | tonumber) as $weekday
    | (if $weekday == 6 then $next_day + 172800
       elif $weekday == 0 then $next_day + 86400
       else $next_day end)
    | strftime("%Y-%m-%d")
  '
}

closing_task_number() {
	local body="$1"
	local numbers=()
	while IFS= read -r number; do
		[[ -n "$number" ]] && numbers+=("$number")
	done < <(
		grep -Eio '(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]+#[0-9]+' <<<"$body" |
			grep -Eo '[0-9]+' |
			sort -u || true
	)
	if [[ ${#numbers[@]} -ne 1 ]]; then
		printf 'AR-EMERGENCY-002: emergency PR must close exactly one Task (found %s)\n' "${#numbers[@]}" >&2
		return 1
	fi
	printf '%s\n' "${numbers[0]}"
}

upsert_target_date() {
	local due_date="$1"
	awk -v due_date="$due_date" '
    BEGIN { found = 0; skipping = 0 }
    /^## 目標日[[:space:]]*$/ {
      if (!found) {
        print "## 目標日"
        print ""
        print due_date
        found = 1
      }
      skipping = 1
      next
    }
    skipping && /^## / { skipping = 0 }
    skipping { next }
    { print }
    END {
      if (!found) {
        print ""
        print "## 目標日"
        print ""
        print due_date
      }
    }
  '
}

main() {
	for name in GH_REPO PR_NUMBER PR_URL PR_BODY PR_MERGED_AT PR_AUTHOR; do
		required_env "$name"
	done

	local task_number issue_json labels state body parent_url due_date updated_body
	if ! task_number="$(closing_task_number "$PR_BODY")"; then
		printf 'Emergency follow-up skipped because the PR has no single closing Task\n'
		return 0
	fi
	issue_json="$(gh issue view "$task_number" --repo "$GH_REPO" --json number,state,labels,assignees,body,parent,url)"
	labels="$(jq -r '.labels[].name' <<<"$issue_json")"
	if ! grep -Fxq 'merge/emergency' <<<"$labels"; then
		printf 'Emergency follow-up is not required for Task #%s\n' "$task_number"
		return 0
	fi

	state="$(jq -r '.state' <<<"$issue_json")"
	body="$(jq -r '.body' <<<"$issue_json")"
	parent_url="$(jq -r '.parent.url // empty' <<<"$issue_json")"
	due_date="$(next_business_day "$PR_MERGED_AT")"
	updated_body="$(printf '%s\n' "$body" | upsert_target_date "$due_date")"

	if [[ "$state" == "CLOSED" ]]; then
		gh issue reopen "$task_number" --repo "$GH_REPO"
	fi

	local edit_args=(issue edit "$task_number" --repo "$GH_REPO")
	local edit_required=false
	if ! grep -Fxq 'post-review-required' <<<"$labels"; then
		edit_args+=(--add-label post-review-required)
		edit_required=true
	fi
	if jq -e '.assignees | length == 0' <<<"$issue_json" >/dev/null; then
		edit_args+=(--add-assignee "$PR_AUTHOR")
		edit_required=true
	fi
	if [[ "$updated_body" != "$body" ]]; then
		edit_args+=(--body "$updated_body")
		edit_required=true
	fi
	if [[ "$edit_required" == true ]]; then
		gh "${edit_args[@]}"
	fi

	local marker existing_comment guidance
	marker="<!-- arttra:emergency-post-review:${PR_NUMBER} -->"
	existing_comment="$(
		gh api "repos/${GH_REPO}/issues/${task_number}/comments" --paginate \
			--jq ".[] | select(.body | contains(\"${marker}\")) | .id" |
			sed -n '1p'
	)"
	if [[ -z "$existing_comment" ]]; then
		guidance="${marker}
緊急マージした ${PR_URL} の事後レビュー期限は **${due_date}** です。

このTaskで事後レビュー結果を記録し、修正が必要な場合は別Taskを作成してください。"
		if [[ -n "$parent_url" ]]; then
			guidance+=" 新しい修正Taskは元と同じ親 ${parent_url} へ紐づけます。"
		fi
		gh issue comment "$task_number" --repo "$GH_REPO" --body "$guidance"
	fi

	printf 'Task #%s requires post-review by %s\n' "$task_number" "$due_date"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
	main "$@"
fi
