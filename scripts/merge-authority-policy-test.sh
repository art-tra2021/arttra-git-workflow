#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "${script_dir}/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

# shellcheck source=./merge-authority-policy-lib.sh
# The library is resolved from this script's directory at runtime.
# shellcheck disable=SC1091
source "${script_dir}/merge-authority-policy-lib.sh"

config_path="${repository_root}/governance/merge-authority.json"
schema_path="${repository_root}/governance/merge-authority.schema.json"

gh() {
	if [[ "$1" != "api" ]]; then
		printf 'unexpected gh invocation: %s\n' "$*" >&2
		return 99
	fi
	if [[ "$*" == *"/collaborators/"*"/permission"* ]]; then
		printf '%s\n' "$MOCK_PERMISSION"
	elif [[ "$*" == *"/pulls/1/files"* ]]; then
		printf '%s\n' "$MOCK_PATHS"
	else
		printf 'unexpected gh api invocation: %s\n' "$*" >&2
		return 99
	fi
}
export -f gh

run_route() {
	local name="$1"
	local mode="$2"
	local actor="$3"
	local expected_count="$4"
	local expected_status="$5"
	local expected_text="$6"
	local output_file="${test_dir}/${name}.output"
	local status=0

	merge_authority_validate_route "$mode" "$actor" "$expected_count" "$config_path" >"$output_file" 2>&1 || status=$?
	if [[ "$status" -ne "$expected_status" ]]; then
		printf 'not ok - %s: expected status %s, got %s\n' "$name" "$expected_status" "$status" >&2
		cat "$output_file" >&2
		return 1
	fi
	if [[ -n "$expected_text" ]] && ! grep -Fq "$expected_text" "$output_file"; then
		printf 'not ok - %s: expected output to contain %s\n' "$name" "$expected_text" >&2
		cat "$output_file" >&2
		return 1
	fi
	printf 'ok - %s\n' "$name"
}

export GH_REPO="test/repo"
export PR_NUMBER=1
export MOCK_PERMISSION="admin"
export MOCK_PATHS="src/lib.rs"

merge_authority_validate_schema "$schema_path"
merge_authority_validate_config "$config_path"
jq -e '
  .merge_modes.self == {
    allowed_actors: ["rozwer"],
    minimum_repository_permission: "write",
    high_risk_action: "deny"
  } and
  .merge_modes.emergency == {
    allowed_actors: ["rozwer"],
    minimum_repository_permission: "admin",
    high_risk_action: "allow"
  }
' "$config_path" >/dev/null
printf 'ok - default-config-semantics\n'

invalid_config="${test_dir}/invalid-config.json"
jq '.merge_modes.self.allowed_actors = ["Rozwer"]' "$config_path" >"$invalid_config"
status=0
merge_authority_validate_config "$invalid_config" >"${test_dir}/invalid-config.output" 2>&1 || status=$?
if [[ "$status" -ne 1 ]] || ! grep -Fq "AR-PR-013" "${test_dir}/invalid-config.output"; then
	printf 'not ok - invalid-config-is-fail-closed\n' >&2
	exit 1
fi
printf 'ok - invalid-config-is-fail-closed\n'

invalid_schema="${test_dir}/invalid-schema.json"
jq '.properties.schema_version.const = 2' "$schema_path" >"$invalid_schema"
status=0
merge_authority_validate_schema "$invalid_schema" >"${test_dir}/invalid-schema.output" 2>&1 || status=$?
if [[ "$status" -ne 1 ]] || ! grep -Fq "AR-PR-013" "${test_dir}/invalid-schema.output"; then
	printf 'not ok - invalid-schema-is-fail-closed\n' >&2
	exit 1
fi
printf 'ok - invalid-schema-is-fail-closed\n'

run_route "authorized-low-risk-self" "merge/self" "ROZWER" 1 0 ""
run_route "unauthorized-self" "merge/self" "alice" 1 1 "AR-PR-014"

MOCK_PERMISSION="read"
run_route "insufficient-self-permission" "merge/self" "rozwer" 1 1 "AR-PR-015"
MOCK_PERMISSION="admin"

MOCK_PATHS=$'src/lib.rs\ngovernance/ruleset.json'
run_route "high-risk-self" "merge/self" "rozwer" 2 1 "AR-PR-016"
run_route "authorized-high-risk-emergency" "merge/emergency" "rozwer" 2 0 ""

MOCK_PATHS="src/lib.rs"
run_route "incomplete-path-list" "merge/self" "rozwer" 2 1 "AR-PR-017"
