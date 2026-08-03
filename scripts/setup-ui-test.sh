#!/usr/bin/env bash

set -euo pipefail

repository_root=$(git rev-parse --show-toplevel)
test_root=$(mktemp -d "${TMPDIR:-/tmp}/arttra-setup-ui-test.XXXXXX")

cleanup() {
	case "$test_root" in
	"${TMPDIR:-/tmp}"/arttra-setup-ui-test.*) rm -rf -- "$test_root" ;;
	*) printf 'refusing to remove unexpected test directory: %s\n' "$test_root" >&2 ;;
	esac
}
trap cleanup EXIT

fail() {
	printf 'setup UI test failed: %s\n' "$1" >&2
	exit 1
}

configured_log_dir="$test_root/nested/../logs"
screen_output="$test_root/failure-screen.txt"
ARTTRA_SETUP_LOG_DIR="$configured_log_dir" COLUMNS=148 LINES=30 \
	bash "$repository_root/scripts/setup-ui.sh" \
	--preview --fail-at integrations --color never >"$screen_output" 2>&1

resolved_log_dir=$(cd "$test_root/logs" && pwd -P)
failure_log=$(find "$resolved_log_dir" -type f -name '*-op08-*.log' -print -quit)
latest_log="$resolved_log_dir/latest.log"
[[ -n $failure_log && -f $failure_log ]] || fail 'timestamped failure log was not created'
[[ -f $latest_log && ! -L $latest_log ]] || fail 'latest.log must be a regular file'
cmp "$failure_log" "$latest_log" || fail 'latest.log does not match the newest report'
grep -Fq "LOG             :: $latest_log" "$screen_output" || fail 'failure panel does not point to latest.log'
grep -Fq "redacted support log: $failure_log" "$screen_output" || fail 'screen does not show the absolute log path'
grep -Fq 'これを実行し、エラーメッセージを見る、またはAIに渡してください' "$screen_output" ||
	fail 'Japanese support guidance is missing'
grep -Fq 'show log: mise run setup-log:show' "$screen_output" || fail 'show command is missing'
grep -Fq 'copy log: mise run setup-log:copy' "$screen_output" || fail 'copy command is missing'
grep -Fq 'ARTARTARTART' "$screen_output" || fail 'wide logo outer curve is missing'
grep -Fq 'RTARTARTARTARTAR' "$screen_output" || fail 'wide logo corner transition is missing'
grep -Fq 'ARTART      ARTART' "$screen_output" || fail 'wide logo center channel is malformed'
grep -Fq 'stage: 3/5' "$failure_log" || fail 'stage metadata is missing'
grep -Fq 'operation: 8/15' "$failure_log" || fail 'operation metadata is missing'
grep -Fq '[REDACTED_SECRET]' "$failure_log" || fail 'preview secret was not redacted'
if grep -Fq 'preview-token-is-never-persisted' "$failure_log"; then
	fail 'source secret was retained'
fi

narrow_screen="$test_root/narrow-screen.txt"
ARTTRA_SETUP_MOTION=0 bash "$repository_root/scripts/setup-ui.sh" \
	--preview --width 80 --height 24 --color never >"$narrow_screen"
grep -Fq 'RTARTARTAR' "$narrow_screen" || fail 'narrow logo outer curve is missing'
grep -Fq 'ARTARTARTART' "$narrow_screen" || fail 'narrow logo corner transition is missing'
grep -Fq 'ARTA    TART' "$narrow_screen" || fail 'narrow logo center channel is malformed'

case "$(uname -s)" in
MINGW* | MSYS* | CYGWIN*) ;;
*)
	if stat -f '%Lp' "$failure_log" >/dev/null 2>&1; then
		log_mode=$(stat -f '%Lp' "$failure_log")
	else
		log_mode=$(stat -c '%a' "$failure_log")
	fi
	[[ $log_mode == 600 ]] || fail "failure log mode is $log_mode instead of 600"
	;;
esac

shown_log="$test_root/shown.log"
ARTTRA_SETUP_LOG_DIR="$resolved_log_dir" \
	bash "$repository_root/scripts/setup-ui.sh" --show-latest-log >"$shown_log"
cmp "$latest_log" "$shown_log" || fail 'setup-log:show output differs from latest.log'

function pbcopy { command cat >"$ARTTRA_TEST_CLIPBOARD_CAPTURE"; }
function wl-copy { command cat >"$ARTTRA_TEST_CLIPBOARD_CAPTURE"; }
function xclip { command cat >"$ARTTRA_TEST_CLIPBOARD_CAPTURE"; }
function clip.exe { command cat >"$ARTTRA_TEST_CLIPBOARD_CAPTURE"; }
function powershell.exe { command cat >"$ARTTRA_TEST_CLIPBOARD_CAPTURE"; }
export -f pbcopy wl-copy xclip clip.exe powershell.exe

for backend in pbcopy wl-copy xclip clip powershell; do
	capture="$test_root/$backend.clipboard"
	result="$test_root/$backend.result"
	ARTTRA_SETUP_LOG_DIR="$resolved_log_dir" \
		ARTTRA_TEST_CLIPBOARD_CAPTURE="$capture" \
		bash "$repository_root/scripts/setup-ui.sh" \
		--copy-latest-log --clipboard-backend "$backend" >"$result"
	cmp "$latest_log" "$capture" || fail "$backend copied different content"
	grep -Fq "($backend): $latest_log" "$result" || fail "$backend result path is incorrect"
done

auto_capture="$test_root/auto.clipboard"
auto_result="$test_root/auto.result"
ARTTRA_SETUP_LOG_DIR="$resolved_log_dir" \
	ARTTRA_TEST_CLIPBOARD_CAPTURE="$auto_capture" \
	bash "$repository_root/scripts/setup-ui.sh" --copy-latest-log >"$auto_result"
cmp "$latest_log" "$auto_capture" || fail 'auto backend copied different content'
grep -Fq "(pbcopy): $latest_log" "$auto_result" || fail 'auto backend did not select the first usable backend'

osc52_output="$test_root/osc52.result"
ARTTRA_SETUP_LOG_DIR="$resolved_log_dir" TERM=xterm-256color \
	bash "$repository_root/scripts/setup-ui.sh" \
	--copy-latest-log --clipboard-backend osc52 >"$osc52_output"
encoded_log=$(base64 <"$latest_log" | tr -d '\r\n')
grep -aFq "]52;c;$encoded_log" "$osc52_output" || fail 'OSC52 payload differs from latest.log'
grep -aFq "(osc52): $latest_log" "$osc52_output" || fail 'OSC52 result path is incorrect'

none_error="$test_root/none.error"
if ARTTRA_SETUP_LOG_DIR="$resolved_log_dir" \
	bash "$repository_root/scripts/setup-ui.sh" \
	--copy-latest-log --clipboard-backend none 2>"$none_error"; then
	fail 'none backend unexpectedly succeeded'
fi
grep -Fq "redacted support log: $latest_log" "$none_error" || fail 'headless fallback path is incorrect'
grep -Fq 'mise run setup-log:show' "$none_error" || fail 'headless fallback show command is missing'

printf 'setup UI cross-platform log tests passed (%s)\n' "$(uname -s)"
