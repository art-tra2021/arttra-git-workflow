#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
review_script="${script_dir}/emergency-review.sh"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

state_file="${test_dir}/state.json"
call_log="${test_dir}/calls.log"

gh() {
	case "$1 $2" in
	"issue view")
		jq '{number: 42, state, labels: [.labels[] | {name: .}], assignees: [.assignees[] | {login: .}], body, parent: {url: "https://github.com/test/repo/issues/41"}, url: "https://github.com/test/repo/issues/42"}' "$state_file"
		;;
	"issue reopen")
		jq '.state = "OPEN"' "$state_file" >"${state_file}.new"
		mv "${state_file}.new" "$state_file"
		printf 'reopen\n' >>"$call_log"
		;;
	"issue edit")
		shift 3
		while [[ $# -gt 0 ]]; do
			case "$1" in
			--repo)
				shift 2
				;;
			--add-label)
				jq --arg value "$2" '.labels += [$value] | .labels |= unique' "$state_file" >"${state_file}.new"
				mv "${state_file}.new" "$state_file"
				shift 2
				;;
			--add-assignee)
				jq --arg value "$2" '.assignees += [$value] | .assignees |= unique' "$state_file" >"${state_file}.new"
				mv "${state_file}.new" "$state_file"
				shift 2
				;;
			--body)
				jq --arg value "$2" '.body = $value' "$state_file" >"${state_file}.new"
				mv "${state_file}.new" "$state_file"
				shift 2
				;;
			*)
				printf 'unexpected issue edit argument: %s\n' "$1" >&2
				return 99
				;;
			esac
		done
		printf 'edit\n' >>"$call_log"
		;;
	"api repos/test/repo/issues/42/comments")
		jq -r '.comments[]?.id' "$state_file"
		;;
	"issue comment")
		local body=''
		while [[ $# -gt 0 ]]; do
			if [[ "$1" == "--body" ]]; then
				body="$2"
				break
			fi
			shift
		done
		jq --arg body "$body" '.comments += [{id: 1, body: $body}]' "$state_file" >"${state_file}.new"
		mv "${state_file}.new" "$state_file"
		printf 'comment\n' >>"$call_log"
		;;
	*)
		printf 'unexpected gh invocation: %s\n' "$*" >&2
		return 99
		;;
	esac
}
export -f gh
export state_file call_log

assert_business_day() {
	local name="$1"
	local merged_at="$2"
	local expected="$3"
	local actual
	actual="$(bash -c 'source "$1"; next_business_day "$2"' _ "$review_script" "$merged_at")"
	if [[ "$actual" != "$expected" ]]; then
		printf 'not ok - %s: expected %s, got %s\n' "$name" "$expected" "$actual" >&2
		exit 1
	fi
	printf 'ok - %s\n' "$name"
}

assert_business_day 'weekday' '2026-08-04T05:00:00Z' '2026-08-05'
assert_business_day 'friday-to-monday' '2026-08-07T05:00:00Z' '2026-08-10'
assert_business_day 'fractional-timestamp' '2026-08-07T05:00:00.123Z' '2026-08-10'

jq -n '{state: "CLOSED", labels: ["type/task", "merge/emergency"], assignees: [], body: "## 完了条件\n\n- [ ] review", comments: []}' >"$state_file"
export GH_REPO='test/repo'
export PR_NUMBER='7'
export PR_URL='https://github.com/test/repo/pull/7'
export PR_BODY='Closes #42'
export PR_MERGED_AT='2026-08-07T05:00:00Z'
export PR_AUTHOR='alice'

bash "$review_script" >/dev/null
bash "$review_script" >/dev/null

if [[ "$(jq -r '.state' "$state_file")" != 'OPEN' ]]; then
	printf 'not ok - reopens original Task\n' >&2
	exit 1
fi
if ! jq -e '.labels == ["merge/emergency", "post-review-required", "type/task"]' "$state_file" >/dev/null; then
	printf 'not ok - label is idempotent\n' >&2
	exit 1
fi
if ! jq -e '.assignees == ["alice"]' "$state_file" >/dev/null; then
	printf 'not ok - assignee is idempotent\n' >&2
	exit 1
fi
if [[ "$(grep -c '^reopen$' "$call_log")" -ne 1 || "$(grep -c '^edit$' "$call_log")" -ne 1 || "$(grep -c '^comment$' "$call_log")" -ne 1 ]]; then
	printf 'not ok - repeated workflow must not duplicate mutations\n' >&2
	cat "$call_log" >&2
	exit 1
fi
if ! jq -e '.body | contains("## 目標日\n\n2026-08-10")' "$state_file" >/dev/null; then
	printf 'not ok - due date is not written to original Task\n' >&2
	exit 1
fi
if ! jq -e '.comments[0].body | contains("別Task") and contains("issues/41")' "$state_file" >/dev/null; then
	printf 'not ok - follow-up guidance must split fixes under the same parent\n' >&2
	exit 1
fi
printf 'ok - original Task follow-up is idempotent\n'

jq -n '{state: "CLOSED", labels: ["type/task", "merge/self"], assignees: [], body: "body", comments: []}' >"$state_file"
: >"$call_log"
bash "$review_script" >/dev/null
if [[ -s "$call_log" ]]; then
	printf 'not ok - non-emergency merge must not mutate Task\n' >&2
	exit 1
fi
printf 'ok - non-emergency merge is ignored\n'

export PR_BODY='Relates to https://github.com/test/repo/issues/41'
: >"$call_log"
bash "$review_script" >/dev/null 2>&1
if [[ -s "$call_log" ]]; then
	printf 'not ok - PR without one closing Task must not mutate Issue\n' >&2
	exit 1
fi
printf 'ok - missing closing Task is a no-op\n'
