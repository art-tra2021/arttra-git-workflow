#!/usr/bin/env bash

# GitHub Actions workflow commandのdataを決定的にescapeする。
# https://docs.github.com/actions/using-workflows/workflow-commands-for-github-actions
pr_policy_escape_annotation_data() {
	local value="$1"
	value="${value//%/%25}"
	value="${value//$'\r'/%0D}"
	value="${value//$'\n'/%0A}"
	printf '%s' "$value"
}

# 人間向けstderrを維持しつつ、Actions上では機械可読なPolicy codeをannotationにする。
pr_policy_error() {
	local code="$1"
	local message="$2"
	local rendered="${code}: ${message}"

	if [[ ! "$code" =~ ^AR-PR-[0-9]{3}$ ]]; then
		printf 'invalid PR policy code: %s\n' "$code" >&2
		return 2
	fi
	printf '%s\n' "$rendered" >&2
	if [[ "${GITHUB_ACTIONS:-false}" == "true" ]]; then
		printf '::error title=%s::%s\n' \
			"$code" \
			"$(pr_policy_escape_annotation_data "$rendered")" >&2
	fi
}
