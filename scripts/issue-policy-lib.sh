#!/usr/bin/env bash

# Shared deterministic Issue hierarchy validation for Issue and Pull Request policy.
# AR-ISSUE-020..022 are reserved for the non-blocking parent-size audit in Issue #101.

issue_policy_load_issue() {
	local reference="$1"
	local fields="number,url,state,labels,parent,subIssues,closedByPullRequestsReferences"

	if [[ "$reference" == https://github.com/* ]]; then
		gh issue view "$reference" --json "$fields"
	else
		gh issue view "$reference" --repo "$GH_REPO" --json "$fields"
	fi
}

issue_policy_type_labels() {
	jq -r '(.labels // [])[] | .name | select(startswith("type/"))' <<<"$1" | LC_ALL=C sort
}

issue_policy_merge_labels() {
	jq -r '(.labels // [])[] | .name | select(startswith("merge/"))' <<<"$1" | LC_ALL=C sort
}

issue_policy_join_lines() {
	local values="$1"
	if [[ -z "$values" ]]; then
		printf '%s' "なし"
	else
		tr '\n' ',' <<<"$values" | sed 's/,$//; s/,/, /g'
	fi
}

issue_policy_read_type() {
	local issue_json="$1"
	local number types count display
	number="$(jq -r '.number' <<<"$issue_json")"
	types="$(issue_policy_type_labels "$issue_json")"
	count="$(grep -c . <<<"$types" || true)"
	if [[ "$count" -ne 1 ]] ||
		[[ ! "$types" =~ ^type/(intake|work|business|task)$ ]]; then
		display="$(issue_policy_join_lines "$types")"
		echo "AR-ISSUE-001: Issue #${number}のtypeラベルは type/intake, type/work, type/business, type/task のうちちょうど1件にしてください（現在: ${display}）。GitHubのLabelsから余分なtype/*を外し、正しいtype/*を1件追加してください。" >&2
		return 1
	fi
	printf '%s\n' "${types#type/}"
}

issue_policy_validate_labels() {
	local issue_json="$1"
	local issue_type="$2"
	local number modes count display
	number="$(jq -r '.number' <<<"$issue_json")"
	modes="$(issue_policy_merge_labels "$issue_json")"
	count="$(grep -c . <<<"$modes" || true)"

	if [[ "$issue_type" == "task" ]]; then
		if [[ "$count" -ne 1 ]] ||
			[[ ! "$modes" =~ ^merge/(review|self|emergency)$ ]]; then
			display="$(issue_policy_join_lines "$modes")"
			echo "AR-ISSUE-002: Task #${number}のmergeラベルは merge/review, merge/self, merge/emergency のうちちょうど1件にしてください（現在: ${display}）。GitHubのLabelsで方針を1件だけ選び直してください。" >&2
			return 1
		fi
	elif [[ "$count" -ne 0 ]]; then
		display="$(issue_policy_join_lines "$modes")"
		echo "AR-ISSUE-003: Issue #${number}は type/${issue_type} のためmergeラベルを持てません（現在: ${display}）。merge方針はPRで閉じるtype/taskだけに設定し、このIssueからmerge/*をすべて外してください。" >&2
		return 1
	fi
}

issue_policy_validate_parent_presence() {
	local issue_json="$1"
	local issue_type="$2"
	local number parent_url
	number="$(jq -r '.number' <<<"$issue_json")"
	parent_url="$(jq -r '.parent.url // empty' <<<"$issue_json")"

	if [[ "$issue_type" == "intake" && -n "$parent_url" ]]; then
		echo "AR-ISSUE-004: Intake #${number}はnative parentを持てません。GitHubのSub-issuesから親子関係を外し、必要なWork / BusinessをこのIntakeの子として登録してください。" >&2
		return 1
	fi
	if [[ "$issue_type" != "intake" && -z "$parent_url" ]]; then
		if [[ "$issue_type" == "task" ]]; then
			echo "AR-ISSUE-004: Task #${number}にnative parentがありません。GitHubのSub-issuesで親type/workまたはtype/businessを1件設定してください。" >&2
		else
			echo "AR-ISSUE-004: Issue #${number}にnative parentがありません。GitHubのSub-issuesで親type/intakeを1件設定してください。" >&2
		fi
		return 1
	fi
}

issue_policy_validate_task_terminal() {
	local issue_json="$1"
	local expected_pr="${2:-}"
	local closing_source="${3:-native}"
	local number child_count closing_count closing_numbers display
	number="$(jq -r '.number' <<<"$issue_json")"
	child_count="$(jq -r '(.subIssues.totalCount // ((.subIssues.nodes // []) | length))' <<<"$issue_json")"
	if [[ "$child_count" -ne 0 ]]; then
		echo "AR-ISSUE-006: Task #${number}は末端Issueである必要があります（子Issue: ${child_count}件）。子IssueをTaskの親Work / Businessへ移すか、別のWork / Businessとして分割してから、このTaskの子関係を外してください。" >&2
		return 1
	fi

	closing_count="$(jq -r '(.closedByPullRequestsReferences // []) | length' <<<"$issue_json")"
	closing_numbers="$(jq -r '(.closedByPullRequestsReferences // [])[] | "#\(.number)"' <<<"$issue_json" | LC_ALL=C sort -V)"
	if [[ -n "$expected_pr" ]]; then
		if [[ "$closing_source" == "body" && "$closing_count" -eq 0 ]]; then
			return 0
		fi
		if [[ "$closing_count" -ne 1 ]] ||
			[[ "$(jq -r '.closedByPullRequestsReferences[0].number // empty' <<<"$issue_json")" != "$expected_pr" ]]; then
			display="$(issue_policy_join_lines "$closing_numbers")"
			echo "AR-PR-012: Task #${number}を閉じるPRは現在のPR #${expected_pr}だけにしてください（現在: ${display}）。他PRのCloses/Fixes/ResolvesをRelates toへ変更するか、現在のPR本文へ \`Closes #${number}\` を設定してください。" >&2
			return 1
		fi
	elif [[ "$closing_count" -gt 1 ]]; then
		display="$(issue_policy_join_lines "$closing_numbers")"
		echo "AR-ISSUE-007: Task #${number}を閉じるPRは最大1件です（現在: ${display}）。採用するPRを1件だけ残し、他PRのCloses/Fixes/ResolvesをRelates toへ変更してください。" >&2
		return 1
	fi
}

issue_policy_validate_non_task_closing_prs() {
	local issue_json="$1"
	local issue_type="$2"
	local number closing_count closing_numbers display
	number="$(jq -r '.number' <<<"$issue_json")"
	closing_count="$(jq -r '(.closedByPullRequestsReferences // []) | length' <<<"$issue_json")"
	if [[ "$closing_count" -eq 0 ]]; then
		return 0
	fi
	closing_numbers="$(jq -r '(.closedByPullRequestsReferences // [])[] | "#\(.number)"' <<<"$issue_json" | LC_ALL=C sort -V)"
	display="$(issue_policy_join_lines "$closing_numbers")"
	echo "AR-ISSUE-008: Issue #${number}は type/${issue_type} のためPRから直接閉じられません（closing PR: ${display}）。PRのCloses/Fixes/Resolvesは子type/taskへ変更し、このIssueはnative sub-issuesの完了後に閉じてください。" >&2
	return 1
}

issue_policy_emit_parent_advisories() {
	local issue_json="$1"
	local issue_type number state child_count open_child_count
	issue_type="$(issue_policy_read_type "$issue_json")" || return 0
	if [[ "$issue_type" != "work" && "$issue_type" != "business" ]]; then
		return 0
	fi

	number="$(jq -r '.number' <<<"$issue_json")"
	state="$(jq -r '.state // "OPEN"' <<<"$issue_json")"
	child_count="$(jq -r '(.subIssues.totalCount // ((.subIssues.nodes // []) | length))' <<<"$issue_json")"
	open_child_count="$(jq -r '[((.subIssues.nodes // [])[]) | select(.state == "OPEN")] | length' <<<"$issue_json")"

	if [[ "$child_count" -gt 20 ]]; then
		printf '::warning title=AR-ISSUE-022::Issue #%s type/%sの直属Taskが%s件あります。20件を超えているため、独立して調整できるWorkまたはBusinessへ分割してください。Task作成自体は拒否しません。\n' \
			"$number" "$issue_type" "$child_count"
	elif [[ "$child_count" -ge 10 ]]; then
		printf '::notice title=AR-ISSUE-020::Issue #%s type/%sの直属Taskが%s件あります。10件に達したため、親Issueの責務と分割粒度を見直してください。Task作成自体は拒否しません。\n' \
			"$number" "$issue_type" "$child_count"
	fi

	if [[ "$state" == "CLOSED" && "$open_child_count" -gt 0 ]]; then
		printf '::warning title=AR-ISSUE-021::閉じたIssue #%s type/%sに未完了の直属Taskが%s件残っています。親を再openするか、未完了Taskを適切なopen親へ移してください。\n' \
			"$number" "$issue_type" "$open_child_count"
	fi
}

issue_policy_validate_hierarchy_json() {
	local issue_json="$1"
	local expected_pr="${2:-}"
	local issue_type number parent_url parent_json parent_type expected_parent
	number="$(jq -r '.number' <<<"$issue_json")"
	issue_type="$(issue_policy_read_type "$issue_json")" || return 1
	issue_policy_validate_labels "$issue_json" "$issue_type" || return 1
	issue_policy_validate_parent_presence "$issue_json" "$issue_type" || return 1

	if [[ "$issue_type" == "task" ]]; then
		issue_policy_validate_task_terminal "$issue_json" "$expected_pr" || return 1
	else
		issue_policy_validate_non_task_closing_prs "$issue_json" "$issue_type" || return 1
	fi

	parent_url="$(jq -r '.parent.url // empty' <<<"$issue_json")"
	if [[ -z "$parent_url" ]]; then
		issue_policy_emit_parent_advisories "$issue_json"
		return 0
	fi
	parent_json="$(issue_policy_load_issue "$parent_url")"
	parent_type="$(issue_policy_read_type "$parent_json")" || return 1
	if [[ "$issue_type" == "task" ]]; then
		expected_parent="type/workまたはtype/business"
		if [[ "$parent_type" != "work" && "$parent_type" != "business" ]]; then
			echo "AR-ISSUE-005: Task #${number}のnative parentは${expected_parent}である必要があります（現在: type/${parent_type}）。GitHubのSub-issuesで正しい親へ付け替えてください。" >&2
			return 1
		fi
	else
		expected_parent="type/intake"
		if [[ "$parent_type" != "intake" ]]; then
			echo "AR-ISSUE-005: Issue #${number}のnative parentは${expected_parent}である必要があります（現在: type/${parent_type}）。GitHubのSub-issuesで正しい親へ付け替えてください。" >&2
			return 1
		fi
	fi

	issue_policy_validate_hierarchy_json "$parent_json" || return 1
	issue_policy_emit_parent_advisories "$issue_json"
}

issue_policy_validate_hierarchy() {
	local reference="$1"
	local expected_pr="${2:-}"
	local issue_json
	issue_json="$(issue_policy_load_issue "$reference")"
	issue_policy_validate_hierarchy_json "$issue_json" "$expected_pr"
}
