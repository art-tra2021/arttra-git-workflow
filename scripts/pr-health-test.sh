#!/usr/bin/env bash
set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/arttra-pr-health-test.XXXXXX")"

cleanup() {
	case "$test_root" in
	"${TMPDIR:-/tmp}"/arttra-pr-health-test.*) rm -rf -- "$test_root" ;;
	*) printf 'refusing to remove unexpected test directory: %s\n' "$test_root" >&2 ;;
	esac
}
trap cleanup EXIT

fail() {
	printf 'PR health test failed: %s\n' "$1" >&2
	exit 1
}

gh() {
	case "$1 $2" in
	"pr list")
		printf '%s\n' "$MOCK_PR_JSON"
		;;
	"pr edit")
		printf '%s\n' "$*" >>"$MOCK_GH_LOG"
		;;
	*)
		printf 'unexpected gh invocation: %s\n' "$*" >&2
		return 99
		;;
	esac
}
export -f gh

export MOCK_GH_LOG="$test_root/gh.log"
export MOCK_PR_JSON
summary="$test_root/summary.md"

MOCK_PR_JSON="$({
	jq -cn '[
	  {number: 1, title: "dirty", url: "https://github.example/test/repo/pull/1", mergeStateStatus: "DIRTY", updatedAt: "2026-08-04T03:00:00Z", additions: 40, deletions: 10, files: [{path: "src/shared.rs"}]},
	  {number: 2, title: "clean", url: "https://github.example/test/repo/pull/2", mergeStateStatus: "CLEAN", updatedAt: "2026-08-04T03:00:00Z", additions: 50, deletions: 1, files: [{path: "src/shared.rs"}]},
	  {number: 3, title: "behind", url: "https://github.example/test/repo/pull/3", mergeStateStatus: "BEHIND", updatedAt: "2026-08-04T03:00:00Z", additions: 250, deletions: 1, files: [{path: "src/behind.rs"}]},
	  {number: 4, title: "stale", url: "https://github.example/test/repo/pull/4", mergeStateStatus: "CLEAN", updatedAt: "2026-07-30T00:00:00Z", additions: 800, deletions: 1, files: [{path: "src/stale.rs"}]}
	]'
})"

GH_REPO="test/repo" NOW_EPOCH="1785816000" GITHUB_STEP_SUMMARY="$summary" \
	bash "$repository_root/scripts/pr-health.sh"

grep -Fq '[#1](https://github.example/test/repo/pull/1): 50 changed lines (+40 / -10)' "$summary" ||
	fail '50-line summary is missing'
grep -Fq '[#2](https://github.example/test/repo/pull/2): 51 changed lines (+50 / -1)' "$summary" ||
	fail '51-line summary is missing'
grep -Fq '[#3](https://github.example/test/repo/pull/3): 251 changed lines (+250 / -1)' "$summary" ||
	fail '251-line summary is missing'
grep -Fq '[#4](https://github.example/test/repo/pull/4): 801 changed lines (+800 / -1)' "$summary" ||
	fail '801-line summary is missing'
grep -Fq '#1 / #2: src/shared.rs' "$summary" || fail 'overlapping file summary is missing'

if grep -Fq 'size/' "$MOCK_GH_LOG"; then
	fail 'PR size label was modified'
fi
grep -Fq 'pr edit 1 --repo test/repo --add-label status/conflict' "$MOCK_GH_LOG" ||
	fail 'conflict label was not added'
grep -Fq 'pr edit 2 --repo test/repo --remove-label status/conflict' "$MOCK_GH_LOG" ||
	fail 'resolved conflict label was not removed'
grep -Fq 'pr edit 3 --repo test/repo --add-label status/needs-update' "$MOCK_GH_LOG" ||
	fail 'behind label was not added'
grep -Fq 'pr edit 4 --repo test/repo --add-label status/needs-update' "$MOCK_GH_LOG" ||
	fail 'stale label was not added'

MOCK_PR_JSON='[]'
: >"$MOCK_GH_LOG"
empty_summary="$test_root/empty-summary.md"
GH_REPO="test/repo" NOW_EPOCH="1785816000" GITHUB_STEP_SUMMARY="$empty_summary" \
	bash "$repository_root/scripts/pr-health.sh"
grep -Fq 'Open PR: 0' "$empty_summary" || fail 'empty PR summary is missing'
[[ ! -s "$MOCK_GH_LOG" ]] || fail 'empty PR list unexpectedly edited a PR'

printf 'PR health tests passed\n'
