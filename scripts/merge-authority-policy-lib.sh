#!/usr/bin/env bash

merge_authority_fail_config() {
	echo "AR-PR-013: default branchのmerge authority設定が無効です。governance/merge-authority.jsonとschemaをreview付きPRで修正し、schema_version・mode・actor・permission・high-risk pathを再検証してください。" >&2
	return 1
}

merge_authority_validate_schema() {
	local schema_path="$1"
	jq -e '
    ."$schema" == "https://json-schema.org/draft/2020-12/schema" and
    .type == "object" and
    .additionalProperties == false and
    (.required | sort) == ["$schema", "high_risk_paths", "merge_modes", "schema_version"] and
    .properties.schema_version.const == 1 and
    (.properties.merge_modes.required | sort) == ["emergency", "self"] and
    (."$defs".authority.properties.minimum_repository_permission.enum | sort) == ["admin", "maintain", "write"]
  ' "$schema_path" >/dev/null 2>&1 || merge_authority_fail_config
}

merge_authority_validate_config() {
	local config_path="$1"
	jq -e '
    type == "object" and
    (keys | sort) == ["$schema", "high_risk_paths", "merge_modes", "schema_version"] and
    ."$schema" == "./merge-authority.schema.json" and
    .schema_version == 1 and
    (.merge_modes | type) == "object" and
    (.merge_modes | keys | sort) == ["emergency", "self"] and
    all(.merge_modes[];
      type == "object" and
      (keys | sort) == ["allowed_actors", "high_risk_action", "minimum_repository_permission"] and
      (.allowed_actors | type) == "array" and
      (.allowed_actors | length) > 0 and
      (.allowed_actors | length) == (.allowed_actors | unique | length) and
      all(.allowed_actors[];
        type == "string" and
        test("^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$") and
        . == ascii_downcase
      ) and
      (.minimum_repository_permission == "write" or
       .minimum_repository_permission == "maintain" or
       .minimum_repository_permission == "admin") and
      (.high_risk_action == "deny" or .high_risk_action == "allow")
    ) and
    .merge_modes.self.high_risk_action == "deny" and
    .merge_modes.emergency.high_risk_action == "allow" and
    (.high_risk_paths | type) == "array" and
    (.high_risk_paths | length) > 0 and
    (.high_risk_paths | length) == (.high_risk_paths | unique | length) and
    all(.high_risk_paths[];
      type == "string" and length > 0 and test("^[A-Za-z0-9_.?*/-]+$")
    )
  ' "$config_path" >/dev/null 2>&1 || merge_authority_fail_config
}

merge_authority_permission_rank() {
	case "$1" in
	read) printf '1\n' ;;
	triage) printf '2\n' ;;
	write) printf '3\n' ;;
	maintain) printf '4\n' ;;
	admin) printf '5\n' ;;
	*) printf '0\n' ;;
	esac
}

merge_authority_load_permission() {
	local actor="$1"
	local permission
	if ! permission="$(
		gh api "repos/${GH_REPO}/collaborators/${actor}/permission" --jq '.permission' 2>/dev/null
	)"; then
		echo "AR-PR-015: GitHub @${actor} のrepository権限を確認できません。merge/reviewへ戻すか、repository管理者がcollaborator権限を確認してください。" >&2
		return 1
	fi
	printf '%s\n' "$permission"
}

merge_authority_load_changed_paths() {
	local expected_count="$1"
	local paths actual_count
	if ! paths="$(
		gh api --paginate "repos/${GH_REPO}/pulls/${PR_NUMBER}/files?per_page=100" --jq '.[].filename'
	)"; then
		echo "AR-PR-017: PR #${PR_NUMBER}の変更pathを全件取得できません。merge/reviewへ戻すか、GitHub API権限と一時障害を確認してください。" >&2
		return 1
	fi
	actual_count=0
	if [[ -n "$paths" ]]; then
		actual_count="$(grep -c . <<<"$paths" || true)"
	fi
	if [[ "$actual_count" -ne "$expected_count" ]]; then
		echo "AR-PR-017: PR #${PR_NUMBER}の変更path取得件数が一致しません（期待: ${expected_count}、取得: ${actual_count}）。不完全なpath一覧では権限判定せずfail-closedにします。" >&2
		return 1
	fi
	printf '%s\n' "$paths"
}

merge_authority_validate_route() {
	local mode="$1"
	local actor="$2"
	local changed_file_count="$3"
	local config_path="$4"
	local mode_key actor_lower allowed required permission required_rank actual_rank action paths path pattern risky_path
	mode_key="${mode#merge/}"
	actor_lower="$(tr '[:upper:]' '[:lower:]' <<<"$actor")"
	allowed="$(jq -r --arg mode "$mode_key" --arg actor "$actor_lower" '.merge_modes[$mode].allowed_actors | index($actor) != null' "$config_path")"
	if [[ "$allowed" != "true" ]]; then
		echo "AR-PR-014: GitHub @${actor} は ${mode} の許可者ではありません。Taskをmerge/reviewへ戻すか、権限追加が必要ならgovernance/merge-authority.jsonを別のreview付きPRで変更してください。" >&2
		return 1
	fi

	required="$(jq -r --arg mode "$mode_key" '.merge_modes[$mode].minimum_repository_permission' "$config_path")"
	permission="$(merge_authority_load_permission "$actor")" || return 1
	required_rank="$(merge_authority_permission_rank "$required")"
	actual_rank="$(merge_authority_permission_rank "$permission")"
	if [[ "$actual_rank" -lt "$required_rank" ]]; then
		echo "AR-PR-015: GitHub @${actor} のrepository権限 ${permission} は ${mode} に必要な ${required} 以上を満たしません。Taskをmerge/reviewへ戻すか、repository管理者が権限を確認してください。" >&2
		return 1
	fi

	paths="$(merge_authority_load_changed_paths "$changed_file_count")" || return 1
	action="$(jq -r --arg mode "$mode_key" '.merge_modes[$mode].high_risk_action' "$config_path")"
	if [[ "$action" == "allow" ]]; then
		return 0
	fi
	risky_path=""
	while IFS= read -r path; do
		while IFS= read -r pattern; do
			# The validated config value is intentionally used as a glob pattern.
			# shellcheck disable=SC2053
			if [[ "$path" == $pattern ]]; then
				risky_path="$path"
				break 2
			fi
		done < <(jq -r '.high_risk_paths[]' "$config_path")
	done <<<"$paths"
	if [[ -n "$risky_path" ]]; then
		echo "AR-PR-016: ${mode} は高リスクpath「${risky_path}」を変更できません。Taskをmerge/reviewへ戻し、作成者以外の承認を得てください。対象path規則の変更はgovernance/merge-authority.jsonをreview付きPRで行ってください。" >&2
		return 1
	fi
}
