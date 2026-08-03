#!/usr/bin/env bash

set -uo pipefail

# Responsive header and gradient fallback behavior are adapted from Gemini CLI
# AppHeader.tsx and ThemedGradient.tsx (Apache-2.0, Copyright Google LLC).
# Spinner frames are copied from Charmbracelet Bubbles spinner/spinner.go
# (MIT, Copyright Charmbracelet, Inc.). Matrix rain state, head, and fading-tail
# behavior are adapted from fakesteak (CC0-1.0). The authentication-channel
# reveal is adapted from TerminalTextEffects' decrypt effect, the landscape /
# portrait split follows lazygit, and the block meter follows cli-tracker (all
# MIT). See THIRD_PARTY_NOTICES.md.

readonly STEP_COUNT=5
readonly OPERATION_COUNT=15
readonly FORMATION_FINAL_FRAME=45
readonly MAX_UI_WIDTH=148
readonly MIN_BOX_WIDTH=34
readonly NARROW_TERMINAL_BREAKPOINT=60
readonly SIDE_PANEL_BREAKPOINT=88
readonly SETUP_MANUAL_URL='https://app.notion.com/p/3af8c19110bf81af8c5dcc1e0403bd38'
readonly MISE_MANUAL_URL='https://app.notion.com/p/3af8c19110bf81b0832bc3a18cfb909f'
readonly GH_AUTH_MANUAL_URL='https://app.notion.com/p/3af8c19110bf812a8f71f29486da997f'
readonly AI_MANUAL_URL='https://app.notion.com/p/3af8c19110bf818d911dc8cfa19ae0b7'
readonly FAILURE_GUIDANCE_JA='これを実行し、エラーメッセージを見る、またはAIに渡してください'

repository_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)
readonly REPOSITORY_ROOT=$repository_root
readonly DEFAULT_FAILURE_LOG_DIR="$REPOSITORY_ROOT/.arttra/local/setup-logs"

readonly -a STEP_TITLES=('TOOLCHAIN' 'GIT-AR' 'INTEGRATIONS' 'PRESENCE' 'DIAGNOSTICS')
readonly -a STAGE_OPERATION_ENDS=(5 7 10 12 15)
readonly -a STEP_DETAILS=(
	'SYNC LOCKED RUNTIMES + TOOLS'
	'COMPILE + INSTALL WORKFLOW ENGINE'
	'ARM GIT + CLAUDE + CODEX HOOKS'
	'REGISTER BACKGROUND HEARTBEAT'
	'RUN FINAL SYSTEM CHECKS'
)
readonly -a OPERATION_NAMES=(
	'MISE LOCK RESOLUTION'
	'RUST TOOLCHAIN'
	'UV + PYTHON'
	'BUN RUNTIME'
	'TOOL CHECKSUMS'
	'GIT-AR BUILD'
	'CLI ENTRYPOINT'
	'SHARED GIT HOOKS'
	'CLAUDE INTEGRATION'
	'CODEX INTEGRATION'
	'PRESENCE HEARTBEAT'
	'OS SCHEDULER'
	'FORMAT + LINT'
	'TEST + CLIPPY'
	'SECURITY + READY'
)
readonly -a OPERATION_SHORT_NAMES=(
	'MISE'
	'RUST'
	'UV'
	'BUN'
	'CHECKSUM'
	'GIT-AR'
	'ENTRYPOINT'
	'GIT HOOK'
	'CLAUDE'
	'CODEX'
	'HEARTBEAT'
	'SCHEDULER'
	'FMT/LINT'
	'TEST/CLIPPY'
	'SECURITY'
)
readonly -a OPERATION_COMMANDS=(
	'mise install --locked'
	'mise install rust'
	'mise install uv python'
	'mise install bun'
	'mise lock --check'
	'cargo install --path . --locked --force'
	'git ar --version'
	'git ar setup --hooks'
	'git ar setup --claude'
	'git ar setup --codex'
	'git ar presence publish --yes'
	'git ar presence install --yes'
	'cargo fmt + hk check'
	'cargo test + cargo clippy'
	'zizmor + gitleaks + git ar doctor'
)
readonly -a OPERATION_DETAILS=(
	'Resolve mise.lock and immutable artifact metadata'
	'Authenticate rustc and cargo against the pinned channel'
	'Provision uv and its managed Python execution path'
	'Provision the pinned Bun JavaScript runtime'
	'Validate URL and SHA256 artifact locks'
	'Compile the workflow engine from Cargo.lock'
	'Probe executable discovery and command routing'
	'Arm mise-managed hk shared hooks'
	'Generate and authenticate the Claude adapter'
	'Generate and authenticate the Codex adapter'
	'Publish the branch and changed-file heartbeat'
	'Register launchd or systemd scheduling'
	'Run deterministic formatting and repository lint'
	'Execute tests and deny all Clippy warnings'
	'Validate workflows, secrets policy, and readiness'
)
readonly -a OPERATION_GENRES=(
	'RUNTIME' 'RUNTIME' 'RUNTIME' 'RUNTIME' 'RUNTIME'
	'BUILD' 'BUILD'
	'INTEGRATION' 'INTEGRATION' 'INTEGRATION' 'INTEGRATION' 'INTEGRATION'
	'VALIDATION' 'VALIDATION' 'VALIDATION'
)

readonly DECRYPT_GLYPHS='01ART{}[]<>+=/#$%&?'
readonly LOGO_GLYPHS='ART'

# Copied from charmbracelet/bubbles spinner/spinner.go. Keeping the exact frame
# sets is both prettier and much less defensible than inventing another spinner.
readonly -a MINI_DOT_FRAMES=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
readonly -a PULSE_FRAMES=('█' '▓' '▒' '░')
readonly -a POINTS_FRAMES=('∙∙∙' '●∙∙' '∙●∙' '∙∙●')
readonly -a METER_FRAMES=('▱▱▱' '▰▱▱' '▰▰▱' '▰▰▰' '▰▰▱' '▰▱▱' '▱▱▱')

preview=false
copy_latest_log=false
show_latest_log=false
clipboard_backend='auto'
requested_width=""
requested_height=""
color_mode="auto"
step_states=('PENDING' 'PENDING' 'PENDING' 'PENDING' 'PENDING')
operation_cursor=0
has_degraded=false
setup_failed=false
failure_exit=0
failure_title=''
failure_command=''
failure_manual_url=$SETUP_MANUAL_URL
failure_log_path=''
failure_log_display=''
failure_log_copy_command=''
failure_stage=0

usage() {
	printf '%s\n' \
		'Usage: scripts/setup-ui.sh [--preview] [--fail-at STEP] [--copy-latest-log|--show-latest-log] [--clipboard-backend BACKEND] [--width COLUMNS] [--height ROWS] [--color auto|always|never]' \
		'' \
		'  --preview        Render the setup sequence without changing the environment.' \
		'  --fail-at STEP   Simulate a preview failure at 1-5 or a named setup step.' \
		'  --copy-latest-log  Copy the latest redacted failure log to the clipboard.' \
		'  --show-latest-log  Print the latest redacted failure log.' \
		'  --clipboard-backend BACKEND  Select auto, pbcopy, wl-copy, xclip, clip, powershell, osc52, or none.' \
		'  --width COLUMNS  Preview or render at a specific terminal width.' \
		'  --height ROWS    Preview or render at a specific terminal height.' \
		'  --color MODE     Select auto, always, or never.'
}

while (($# > 0)); do
	case "$1" in
	--preview)
		preview=true
		shift
		;;
	--copy-latest-log)
		copy_latest_log=true
		shift
		;;
	--show-latest-log)
		show_latest_log=true
		shift
		;;
	--clipboard-backend)
		if (($# < 2)); then
			printf 'error: --clipboard-backend requires a value\n' >&2
			exit 2
		fi
		clipboard_backend=$2
		shift 2
		;;
	--fail-at)
		if (($# < 2)); then
			printf 'error: --fail-at requires a value\n' >&2
			exit 2
		fi
		case "$2" in
		1 | toolchain) failure_stage=1 ;;
		2 | git-ar) failure_stage=2 ;;
		3 | integrations) failure_stage=3 ;;
		4 | presence) failure_stage=4 ;;
		5 | diagnostics) failure_stage=5 ;;
		*)
			printf 'error: --fail-at must be 1-5, toolchain, git-ar, integrations, presence, or diagnostics\n' >&2
			exit 2
			;;
		esac
		shift 2
		;;
	--width)
		if (($# < 2)); then
			printf 'error: --width requires a value\n' >&2
			exit 2
		fi
		requested_width=$2
		shift 2
		;;
	--height)
		if (($# < 2)); then
			printf 'error: --height requires a value\n' >&2
			exit 2
		fi
		requested_height=$2
		shift 2
		;;
	--color)
		if (($# < 2)); then
			printf 'error: --color requires a value\n' >&2
			exit 2
		fi
		color_mode=$2
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		printf 'error: unknown option: %s\n' "$1" >&2
		usage >&2
		exit 2
		;;
	esac
done

case "$clipboard_backend" in
auto | pbcopy | wl-copy | xclip | clip | powershell | osc52 | none) ;;
*)
	printf 'error: --clipboard-backend must be auto, pbcopy, wl-copy, xclip, clip, powershell, osc52, or none\n' >&2
	exit 2
	;;
esac

if $copy_latest_log && $show_latest_log; then
	printf 'error: --copy-latest-log and --show-latest-log cannot be combined\n' >&2
	exit 2
fi

if ((failure_stage > 0)) && ! $preview; then
	printf 'error: --fail-at is available only with --preview\n' >&2
	exit 2
fi

if [[ -n $requested_width && ! $requested_width =~ ^[0-9]+$ ]]; then
	printf 'error: --width must be a positive integer\n' >&2
	exit 2
fi
if [[ -n $requested_width && $requested_width -lt 20 ]]; then
	printf 'error: --width must be at least 20 columns\n' >&2
	exit 2
fi
if [[ -n $requested_height && ! $requested_height =~ ^[0-9]+$ ]]; then
	printf 'error: --height must be a positive integer\n' >&2
	exit 2
fi
if [[ -n $requested_height && $requested_height -lt 12 ]]; then
	printf 'error: --height must be at least 12 rows\n' >&2
	exit 2
fi
case "$color_mode" in
auto | always | never) ;;
*)
	printf 'error: --color must be auto, always, or never\n' >&2
	exit 2
	;;
esac

stdout_is_tty=false
if [[ -t 1 ]]; then stdout_is_tty=true; fi

terminal_width() {
	local width
	if [[ -n $requested_width ]]; then
		width=$requested_width
	elif [[ ${ARTTRA_SETUP_WIDTH:-} =~ ^[0-9]+$ ]]; then
		width=$ARTTRA_SETUP_WIDTH
	elif $stdout_is_tty && [[ ${screen_width:-} =~ ^[0-9]+$ ]]; then
		width=$screen_width
	elif [[ ${COLUMNS:-} =~ ^[0-9]+$ ]]; then
		width=$COLUMNS
	else
		width=80
	fi
	if $stdout_is_tty && [[ ${screen_width:-} =~ ^[0-9]+$ ]] &&
		((screen_width >= 20 && width > screen_width)); then
		width=$screen_width
	fi
	if ((width < 20)); then
		width=20
	fi
	printf '%s' "$width"
}

terminal_height() {
	local height
	if [[ -n $requested_height ]]; then
		height=$requested_height
	elif [[ ${ARTTRA_SETUP_HEIGHT:-} =~ ^[0-9]+$ ]]; then
		height=$ARTTRA_SETUP_HEIGHT
	elif $stdout_is_tty && [[ ${screen_height:-} =~ ^[0-9]+$ ]]; then
		height=$screen_height
	elif [[ ${LINES:-} =~ ^[0-9]+$ ]]; then
		height=$LINES
	else
		height=24
	fi
	if $stdout_is_tty && [[ ${screen_height:-} =~ ^[0-9]+$ ]] &&
		((screen_height >= 12 && height > screen_height)); then
		height=$screen_height
	fi
	if ((height < 12)); then
		height=12
	fi
	printf '%s' "$height"
}

physical_terminal_width() {
	local dimensions
	local width
	if $stdout_is_tty; then
		dimensions=$(stty size </dev/tty 2>/dev/null || true)
		width=${dimensions##* }
	elif [[ ${COLUMNS:-} =~ ^[0-9]+$ ]]; then
		width=$COLUMNS
	else
		width=80
	fi
	if [[ ! $width =~ ^[0-9]+$ ]]; then width=80; fi
	if ((width < 20)); then width=20; fi
	printf '%s' "$width"
}

physical_terminal_height() {
	local dimensions
	local height
	if $stdout_is_tty; then
		dimensions=$(stty size </dev/tty 2>/dev/null || true)
		height=${dimensions%% *}
	elif [[ ${LINES:-} =~ ^[0-9]+$ ]]; then
		height=$LINES
	else
		height=24
	fi
	if [[ ! $height =~ ^[0-9]+$ ]]; then height=24; fi
	if ((height < 12)); then height=12; fi
	printf '%s' "$height"
}

screen_width=$(physical_terminal_width)
screen_height=$(physical_terminal_height)
viewport_width=$(terminal_width)
viewport_height=$(terminal_height)
ui_width=$viewport_width
if ((ui_width > MAX_UI_WIDTH)); then
	ui_width=$MAX_UI_WIDTH
fi
layout_mode='portrait'

refresh_terminal_dimensions() {
	screen_width=$(physical_terminal_width)
	screen_height=$(physical_terminal_height)
	viewport_width=$(terminal_width)
	viewport_height=$(terminal_height)
	ui_width=$viewport_width
	if ((ui_width > MAX_UI_WIDTH)); then
		ui_width=$MAX_UI_WIDTH
	fi
	if ((ui_width >= SIDE_PANEL_BREAKPOINT && viewport_height >= 22 && viewport_width >= viewport_height * 2)); then
		layout_mode='landscape'
	elif ((ui_width >= NARROW_TERMINAL_BREAKPOINT && viewport_height >= 20)) ||
		((ui_width >= MIN_BOX_WIDTH && viewport_height >= 22)); then
		layout_mode='portrait'
	else
		layout_mode='minimal'
	fi
}

refresh_terminal_width() {
	refresh_terminal_dimensions
}

# Reflow the next dashboard after a live terminal resize. Rendering from inside
# the signal handler would corrupt command output, so the next paint is the
# equivalent of the browser's next layout pass.
if [[ -z $requested_width && -z ${ARTTRA_SETUP_WIDTH:-} && -z $requested_height && -z ${ARTTRA_SETUP_HEIGHT:-} ]] && $stdout_is_tty; then
	trap 'refresh_terminal_dimensions' WINCH
fi

refresh_terminal_dimensions

color_enabled=false
case "$color_mode" in
always) color_enabled=true ;;
never) color_enabled=false ;;
auto)
	if $stdout_is_tty && [[ ${TERM:-} != dumb && -z ${NO_COLOR:-} ]]; then
		color_enabled=true
	fi
	;;
esac

motion_enabled=false
if $stdout_is_tty && [[ ${TERM:-} != dumb && ${ARTTRA_SETUP_MOTION:-1} != 0 ]]; then
	motion_enabled=true
fi

tui_enabled=false
if $stdout_is_tty && [[ ${TERM:-} != dumb ]]; then
	tui_enabled=true
fi
tui_active=false
tui_event='EVENT STREAM // WAITING'
tui_tick=0
persistent_frame=false

readonly RESET='0'
readonly MUTED='38;2;101;116;139'
readonly CYAN='38;2;34;211;238'
readonly BLUE='38;2;59;130;246'
readonly VIOLET='1;38;2;241;245;249'
readonly MAGENTA='38;2;255;95;135'
readonly GREEN='38;2;74;222;128'
readonly MATRIX_HEAD='1;38;2;235;255;245'
readonly MATRIX_BRIGHT='1;38;2;0;255;135'
readonly MATRIX_MID='38;2;0;190;95'
readonly MATRIX_DIM='38;2;0;105;55'
readonly MATRIX_GHOST='2;38;2;0;55;32'
readonly AMBER='38;2;251;191;36'
readonly RED='38;2;248;113;113'
readonly WHITE='1;38;2;241;245;249'
readonly LOGO_GREEN='1;38;2;137;222;160'
readonly LOGO_YELLOW='1;38;2;245;204;88'
readonly LOGO_CORAL='1;38;2;255;138;131'
readonly LOGO_BLUE='1;38;2;126;161;221'

paint() {
	local style=$1
	shift
	if $color_enabled; then
		printf '\033[%sm%s\033[%sm' "$style" "$*" "$RESET"
	else
		printf '%s' "$*"
	fi
}

repeat() {
	local character=$1
	local count=$2
	local output=""
	if ((count <= 0)); then
		return
	fi
	printf -v output '%*s' "$count" ''
	printf '%s' "${output// /$character}"
}

text_width() {
	# Setup TUI labels are ASCII plus terminal glyphs rendered as one cell by the
	# supported terminals. Keeping the count literal prevents right borders from
	# drifting left once animated dots accumulate in a row.
	if [[ $1 == "$FAILURE_GUIDANCE_JA" ]]; then
		# 30 full-width Japanese characters plus the two ASCII cells in "AI".
		printf '%s' '62'
		return
	fi
	printf '%s' "${#1}"
}

completion_next_command() {
	if $preview; then
		printf '%s' 'mise run setup-ar'
	else
		printf '%s' 'git ar'
	fi
}

manual_url_for_step() {
	local number=$1
	case "$number" in
	1) printf '%s' "$MISE_MANUAL_URL" ;;
	3) printf '%s' "$AI_MANUAL_URL" ;;
	*) printf '%s' "$SETUP_MANUAL_URL" ;;
	esac
}

manual_url_for_failure() {
	local number=$1
	local log_file=$2
	if grep -Eiq 'gh auth|github.{0,24}auth' "$log_file"; then
		printf '%s' "$GH_AUTH_MANUAL_URL"
	elif grep -Eiq 'claude|codex|ai integration|ai設定' "$log_file"; then
		printf '%s' "$AI_MANUAL_URL"
	elif grep -Eiq 'mise|toolchain|runtime' "$log_file"; then
		printf '%s' "$MISE_MANUAL_URL"
	else
		manual_url_for_step "$number"
	fi
}

shell_command_for_display() {
	local command=''
	local argument
	local escaped
	for argument in "$@"; do
		printf -v escaped '%q' "$argument"
		if [[ -n $command ]]; then command+=' '; fi
		command+=$escaped
	done
	printf '%s' "$command"
}

sanitize_failure_stream() {
	awk '
		function redact_tokens(text, pattern) {
			pattern = "(github_pat_|gh[pousr]_|glpat-|xox[baprs]-|sk-(proj-)?)" \
				"[A-Za-z0-9_-]+"
			while (match(text, pattern)) {
				text = substr(text, 1, RSTART - 1) "[REDACTED_TOKEN]" \
					substr(text, RSTART + RLENGTH)
			}
			pattern = "AKIA[A-Z0-9]+"
			while (match(text, pattern)) {
				text = substr(text, 1, RSTART - 1) "[REDACTED_ACCESS_KEY]" \
					substr(text, RSTART + RLENGTH)
			}
			return text
		}

		function redact_assignments(text, lower, pattern, prefix, rest) {
			lower = tolower(text)
			pattern = "\"?(token|password|passwd|secret|api[_-]?key|private[_-]?key|" \
				"client[_-]?secret|access[_-]?key)[a-z0-9_-]*\"?" \
				"([[:space:]]*[:=][[:space:]]*|[[:space:]]+)"
			while (match(lower, pattern)) {
				prefix = substr(text, 1, RSTART - 1)
				rest = substr(text, RSTART + RLENGTH)
				if (match(rest, /^"[^"]*"|^\047[^\047]*\047|^[^[:space:]]+/)) {
					text = prefix "[REDACTED_SECRET]" substr(rest, RLENGTH + 1)
				} else {
					text = prefix "[REDACTED_SECRET]" rest
				}
				lower = tolower(text)
			}
			return text
		}

		BEGIN {
			escape = sprintf("%c", 27)
			private_key = 0
		}
		{
			line = $0
			gsub(/\r/, "", line)
			gsub(escape "\\[[0-9;?]*[ -/]*[@-~]", "", line)
			lower = tolower(line)
			if (line ~ /-----BEGIN .*PRIVATE KEY-----/) {
				print "[REDACTED_PRIVATE_KEY]"
				private_key = 1
				next
			}
			if (private_key) {
				if (line ~ /-----END .*PRIVATE KEY-----/) {
					private_key = 0
				}
				next
			}
			if (lower ~ /(authorization|proxy-authorization|cookie|set-cookie)[[:space:]]*:/ ||
				lower ~ /authorization[[:space:]]+(bearer|basic)[[:space:]]+/) {
				print "[REDACTED_HTTP_CREDENTIAL]"
				next
			}
			if (lower ~ /https?:\/\/[^[:space:]\/@]+:[^[:space:]@]+@/) {
				print "[REDACTED_URL_CREDENTIAL]"
				next
			}
			line = redact_tokens(line)
			line = redact_assignments(line)
			print line
		}
	'
}

failure_log_slug() {
	local title=$1
	local slug
	slug=$(printf '%s' "$title" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9_-')
	if [[ -z $slug ]]; then slug='operation'; fi
	printf '%s' "${slug:0:32}"
}

configured_failure_log_dir() {
	local log_dir=${ARTTRA_SETUP_LOG_DIR:-$DEFAULT_FAILURE_LOG_DIR}
	if [[ $log_dir != /* && ! $log_dir =~ ^[A-Za-z]:[/\\] ]]; then
		log_dir="$REPOSITORY_ROOT/$log_dir"
	fi
	printf '%s' "$log_dir"
}

latest_failure_log_path() {
	local log_dir
	log_dir=$(configured_failure_log_dir)
	if [[ -d $log_dir ]]; then
		log_dir=$(cd "$log_dir" && pwd -P)
	fi
	printf '%s/latest.log' "$log_dir"
}

show_latest_failure_log() {
	local latest_log
	latest_log=$(latest_failure_log_path)
	if [[ ! -f $latest_log ]]; then
		printf 'error: no redacted setup failure log found at %s\n' "$latest_log" >&2
		return 2
	fi
	cat -- "$latest_log"
}

copy_via_osc52() {
	local path=$1
	local max_bytes=${ARTTRA_SETUP_OSC52_MAX_BYTES:-100000}
	local byte_count
	local payload
	local escape=$'\033'
	local bell=$'\a'
	local backslash=$'\\'
	if [[ ! $max_bytes =~ ^[0-9]+$ || $max_bytes -lt 1 ]]; then
		printf 'error: ARTTRA_SETUP_OSC52_MAX_BYTES must be a positive integer\n' >&2
		return 2
	fi
	byte_count=$(wc -c <"$path" | tr -d '[:space:]')
	if ((byte_count > max_bytes)); then
		printf 'error: redacted log is %s bytes; OSC52 limit is %s bytes\n' "$byte_count" "$max_bytes" >&2
		return 3
	fi
	payload=$(base64 <"$path" | tr -d '\r\n')
	if [[ -n ${TMUX:-} ]]; then
		printf '%sPtmux;%s%s]52;c;%s%s%s%s' \
			"$escape" "$escape" "$escape" "$payload" "$bell" "$escape" "$backslash"
	elif [[ ${TERM:-} == screen* ]]; then
		printf '%sP%s]52;c;%s%s%s%s' \
			"$escape" "$escape" "$payload" "$bell" "$escape" "$backslash"
	else
		printf '%s]52;c;%s%s' "$escape" "$payload" "$bell"
	fi
}

copy_with_clipboard_backend() {
	local backend=$1
	local path=$2
	local powershell_command="\$content = [Console]::In.ReadToEnd(); Set-Clipboard -Value \$content"
	case "$backend" in
	pbcopy)
		command -v pbcopy >/dev/null 2>&1 || return 127
		pbcopy <"$path"
		;;
	wl-copy)
		command -v wl-copy >/dev/null 2>&1 || return 127
		wl-copy <"$path"
		;;
	xclip)
		command -v xclip >/dev/null 2>&1 || return 127
		xclip -selection clipboard <"$path"
		;;
	clip)
		command -v clip.exe >/dev/null 2>&1 || return 127
		clip.exe <"$path"
		;;
	powershell)
		if command -v powershell.exe >/dev/null 2>&1; then
			powershell.exe -NoLogo -NoProfile -NonInteractive -Command "$powershell_command" <"$path"
		elif command -v pwsh >/dev/null 2>&1; then
			pwsh -NoLogo -NoProfile -NonInteractive -Command "$powershell_command" <"$path"
		else
			return 127
		fi
		;;
	osc52) copy_via_osc52 "$path" ;;
	*) return 127 ;;
	esac
}

copy_latest_failure_log() {
	local latest_log
	local backend
	local selected_backend=''
	local -a backends=()
	latest_log=$(latest_failure_log_path)
	if [[ ! -f $latest_log ]]; then
		printf 'error: no redacted setup failure log found at %s\n' "$latest_log" >&2
		return 2
	fi
	if [[ $clipboard_backend != auto ]]; then
		backends=("$clipboard_backend")
	else
		if command -v pbcopy >/dev/null 2>&1; then backends+=('pbcopy'); fi
		if [[ -n ${WAYLAND_DISPLAY:-} ]] && command -v wl-copy >/dev/null 2>&1; then backends+=('wl-copy'); fi
		if [[ -n ${DISPLAY:-} ]] && command -v xclip >/dev/null 2>&1; then backends+=('xclip'); fi
		if command -v clip.exe >/dev/null 2>&1; then backends+=('clip'); fi
		if command -v powershell.exe >/dev/null 2>&1 || command -v pwsh >/dev/null 2>&1; then
			backends+=('powershell')
		fi
		if [[ -t 1 && ${TERM:-dumb} != dumb ]]; then backends+=('osc52'); fi
	fi
	for backend in "${backends[@]}"; do
		if [[ $backend == none ]]; then continue; fi
		if copy_with_clipboard_backend "$backend" "$latest_log"; then
			selected_backend=$backend
			break
		fi
	done
	if [[ -z $selected_backend ]]; then
		printf '%s\n' 'error: no usable clipboard backend; the redacted log was not copied.' >&2
		printf 'redacted support log: %s\n' "$latest_log" >&2
		printf '%s\n' 'run mise run setup-log:show to inspect it.' >&2
		return 3
	fi
	printf '\ncopied redacted support log (%s): %s\n' "$selected_backend" "$latest_log"
}

create_failure_report() {
	local number=$1
	local title=$2
	local command=$3
	local status=$4
	local raw_log=$5
	local log_dir
	local timestamp
	local slug
	local filename
	local latest_temp
	local operation_number=$((operation_cursor + 1))
	if ((operation_number > OPERATION_COUNT)); then operation_number=$OPERATION_COUNT; fi

	failure_log_path=''
	failure_log_display='UNAVAILABLE // RAW OUTPUT DISCARDED'
	failure_log_copy_command='CHECK LOG DIRECTORY PERMISSIONS; THEN RETRY'
	log_dir=$(configured_failure_log_dir)
	if ! mkdir -p -- "$log_dir"; then
		return 1
	fi
	if ! log_dir=$(cd "$log_dir" && pwd -P); then
		return 1
	fi
	chmod 700 "$log_dir" 2>/dev/null || true
	timestamp=$(date -u '+%Y%m%dT%H%M%SZ')
	slug=$(failure_log_slug "$title")
	printf -v filename '%s-op%02d-%s-%s.log' "$timestamp" "$operation_number" "$slug" "$$"
	failure_log_path="$log_dir/$filename"
	if ! (
		umask 077
		{
			printf '%s\n' \
				'ARTTRA SETUP FAILURE REPORT' \
				"generated_at_utc: $timestamp" \
				"stage: $number/$STEP_COUNT" \
				"operation: $operation_number/$OPERATION_COUNT" \
				"title: $title" \
				"command: $command" \
				"exit_code: $status" \
				"os: $(uname -s 2>/dev/null || printf unknown)" \
				"arch: $(uname -m 2>/dev/null || printf unknown)" \
				'redaction: deterministic local filter applied' \
				'raw_output_retained: false' \
				'' \
				'--- SANITIZED COMMAND OUTPUT ---'
			cat -- "$raw_log"
		} | sanitize_failure_stream >"$failure_log_path"
	); then
		rm -f -- "$failure_log_path"
		failure_log_path=''
		return 1
	fi
	chmod 600 "$failure_log_path" 2>/dev/null || true
	failure_log_display=$failure_log_path
	latest_temp="$log_dir/.latest.$$.log"
	if cp "$failure_log_path" "$latest_temp" 2>/dev/null &&
		chmod 600 "$latest_temp" 2>/dev/null &&
		mv -f "$latest_temp" "$log_dir/latest.log" 2>/dev/null; then
		failure_log_display="$log_dir/latest.log"
	else
		rm -f -- "$latest_temp"
	fi
	failure_log_copy_command='mise run setup-log:copy'
}

print_failure_support_details() {
	if $stdout_is_tty; then
		return
	fi
	printf 'setup failed: %s (exit %s)\n' "$failure_title" "$failure_exit" >&2
	if [[ -n $failure_log_path ]]; then
		printf 'redacted support log: %s\n' "$failure_log_path" >&2
		printf '%s\n' "$FAILURE_GUIDANCE_JA" >&2
		printf '%s\n' 'show log: mise run setup-log:show' >&2
		printf 'copy log: %s\n' "$failure_log_copy_command" >&2
		printf '%s\n' 'share only this redacted log; raw command output was discarded.' >&2
	else
		printf '%s\n' 'support log unavailable; raw command output was discarded.' >&2
	fi
}

clip() {
	local text=$1
	local limit=$2
	local width
	width=$(text_width "$text")
	if ((width <= limit)); then
		printf '%s' "$text"
		return
	fi

	local result=""
	local character
	local character_width
	local used=0
	local suffix='...'
	local index
	if ((limit <= 3)); then
		suffix=""
	fi
	for ((index = 0; index < ${#text}; index++)); do
		character=${text:index:1}
		character_width=$(text_width "$character")
		if ((used + character_width + ${#suffix} > limit)); then
			break
		fi
		result+=$character
		used=$((used + character_width))
	done
	printf '%s%s' "$result" "$suffix"
}

border() {
	local left=$1
	local fill=$2
	local right=$3
	paint "$VIOLET" "$left$(repeat "$fill" "$((ui_width - 2))")$right"
	printf '\n'
}

row() {
	local text=$1
	local style=${2:-$WHITE}
	local limit=$((ui_width - 4))
	local visible
	local padding
	visible=$(clip "$text" "$limit")
	padding=$((ui_width - $(text_width "$visible") - 3))
	paint "$VIOLET" '│'
	printf ' '
	paint "$style" "$visible"
	printf '%*s' "$padding" ''
	paint "$VIOLET" '│'
	printf '\n'
}

centered_row() {
	local text=$1
	local style=${2:-$WHITE}
	local limit=$((ui_width - 2))
	local visible
	local space
	local left_padding
	local right_padding
	visible=$(clip "$text" "$limit")
	space=$((ui_width - $(text_width "$visible") - 2))
	left_padding=$((space / 2))
	right_padding=$((space - left_padding))
	paint "$VIOLET" '│'
	printf '%*s' "$left_padding" ''
	paint "$style" "$visible"
	printf '%*s' "$right_padding" ''
	paint "$VIOLET" '│'
	printf '\n'
}

centered_plain() {
	local text=$1
	local style=${2:-$WHITE}
	local visible
	local padding
	visible=$(clip "$text" "$ui_width")
	padding=$(((ui_width - $(text_width "$visible")) / 2))
	printf '%*s' "$padding" ''
	paint "$style" "$visible"
	printf '\n'
}

render_ascii_logo_box() {
	local index
	local encoded
	local inner_width=$((ui_width - 2))
	local left_padding=$(((inner_width - 18) / 2))
	local right_padding=$((inner_width - 18 - left_padding))
	for index in 0 1 2 3 4 5 6; do
		encoded=$(encoded_logo_line "$index" 18 7)
		paint "$VIOLET" '│'
		printf '%*s' "$left_padding" ''
		render_encoded_logo_cells "$encoded"
		printf '%*s' "$right_padding" ''
		paint "$VIOLET" '│'
		printf '\n'
	done
}

render_ascii_logo_plain() {
	local index
	local encoded
	local padding=$(((ui_width - 18) / 2))
	for index in 0 1 2 3 4 5 6; do
		encoded=$(encoded_logo_line "$index" 18 7)
		printf '%*s' "$padding" ''
		render_encoded_logo_cells "$encoded"
		printf '\n'
	done
}

hero_ascii_logo_row() {
	local logo_line=$1
	local right_text=$2
	local right_text_style=$3
	local left_width=$4
	local right_width=$5
	local normalized
	local logo_width=30
	local space=$((left_width - logo_width))
	local left_padding=$((space / 2))
	local right_padding=$((space - left_padding))
	printf -v normalized '%-30s' "$logo_line"
	paint "$VIOLET" '│'
	printf '%*s' "$left_padding" ''
	render_encoded_logo_cells "$normalized"
	printf '%*s' "$right_padding" ''
	paint "$VIOLET" '│'
	dashboard_cell "$right_text" "$right_text_style" "$right_width"
	paint "$VIOLET" '│'
	printf '\n'
}

encoded_logo_line() {
	local row_number=$1
	local logo_width=$2
	local logo_height=$3
	local cell_height=$((logo_height / 3))
	local width_cell_height=$((logo_width / 6))
	if ((width_cell_height < cell_height)); then cell_height=$width_cell_height; fi
	if ((cell_height < 1)); then cell_height=1; fi
	local active_width=$((cell_height * 6))
	local active_height=$((cell_height * 3))
	local active_left=$(((logo_width - active_width) / 2))
	local active_top=$(((logo_height - active_height) / 2))
	local corner_radius_y=${4:-$cell_height}
	local corner_radius_x=$((corner_radius_y * 2))
	local diameter_x=$((corner_radius_x * 2))
	local diameter_y=$((corner_radius_y * 2))
	local column
	local delta_x
	local delta_y
	local marker
	local left=-1
	local right=-1
	local top=-1
	local bottom=-1
	local corner_column
	local corner_row
	local relative_column
	local relative_row
	local line=''
	for ((column = 0; column < logo_width; column++)); do
		marker=' '
		left=-1
		right=-1
		top=-1
		bottom=-1
		# Four 2x1 plates tile a 3x3 grid with only its center cell left empty.
		# Deriving every bound from the grid cell keeps the silhouette and corner
		# radius proportional at 18x7, 30x10, 38x18, and 50x24.
		if ((row_number >= active_top && row_number < active_top + cell_height && \
			column >= active_left && column < active_left + cell_height * 4)); then
			marker='g'
			left=$active_left
			right=$((active_left + cell_height * 4 - 1))
			top=$active_top
			bottom=$((active_top + cell_height - 1))
		elif ((row_number >= active_top && row_number < active_top + cell_height * 2 && \
			column >= active_left + cell_height * 4 && column < active_left + cell_height * 6)); then
			marker='q'
			left=$((active_left + cell_height * 4))
			right=$((active_left + cell_height * 6 - 1))
			top=$active_top
			bottom=$((active_top + cell_height * 2 - 1))
		elif ((row_number >= active_top + cell_height && row_number < active_top + cell_height * 3 && \
			column >= active_left && column < active_left + cell_height * 2)); then
			marker='c'
			left=$active_left
			right=$((active_left + cell_height * 2 - 1))
			top=$((active_top + cell_height))
			bottom=$((active_top + cell_height * 3 - 1))
		elif ((row_number >= active_top + cell_height * 2 && row_number < active_top + cell_height * 3 && \
			column >= active_left + cell_height * 2 && column < active_left + cell_height * 6)); then
			marker='b'
			left=$((active_left + cell_height * 2))
			right=$((active_left + cell_height * 6 - 1))
			top=$((active_top + cell_height * 2))
			bottom=$((active_top + cell_height * 3 - 1))
		fi
		if [[ $marker != ' ' ]] && ((corner_radius_y > 0)); then
			relative_column=$((column - left))
			relative_row=$((row_number - top))
			corner_row=-1
			corner_column=-1
			# Apply a quarter ellipse only to the four outside corners. Terminal
			# cells are roughly twice as tall as they are wide, so the horizontal
			# radius uses twice as many columns. Center-facing corners stay square.
			case "$marker" in
			g)
				corner_row=$relative_row
				corner_column=$relative_column
				;;
			q)
				corner_row=$relative_row
				corner_column=$((right - column))
				;;
			c)
				corner_row=$((bottom - row_number))
				corner_column=$relative_column
				;;
			b)
				corner_row=$((bottom - row_number))
				corner_column=$((right - column))
				;;
			esac
			if ((corner_row >= 0 && corner_row < corner_radius_y && \
				corner_column >= 0 && corner_column < corner_radius_x)); then
				delta_x=$((diameter_x - (corner_column * 2 + 1)))
				delta_y=$((diameter_y - (corner_row * 2 + 1)))
				if ((delta_x * delta_x * diameter_y * diameter_y + \
					delta_y * delta_y * diameter_x * diameter_x > \
					diameter_x * diameter_x * diameter_y * diameter_y)); then
					marker='s'
				fi
			fi
		fi
		line+="$marker"
	done
	printf '%s' "$line"
}

render_logo_formation_content() {
	local frame=$1
	local use_color=0
	if $color_enabled; then use_color=1; fi
	awk \
		-v sw="$screen_width" \
		-v sh="$screen_height" \
		-v frame="$frame" \
		-v final="$FORMATION_FINAL_FRAME" \
		-v use_color="$use_color" \
		-v green="$LOGO_GREEN" \
		-v yellow="$LOGO_YELLOW" \
		-v coral="$LOGO_CORAL" \
		-v blue="$LOGO_BLUE" '
		function outside_round(x, y, radius_y,    radius_x, normalized_x, normalized_y) {
			if (radius_y <= 0) return 0
			radius_x = radius_y * 2
			if (y >= radius_y || x >= radius_x) return 0
			normalized_x = (radius_x - (x + 0.5)) / radius_x
			normalized_y = (radius_y - (y + 0.5)) / radius_y
			return normalized_x * normalized_x + normalized_y * normalized_y > 1
		}
		function target_marker(x, y,    marker, left, right, top, bottom, relative_row, relative_column, corner_row, corner_column) {
			marker = " "
			left = right = top = bottom = -1
			if (y >= active_top && y < active_top + cell_height && x >= active_left && x < active_left + cell_height * 4) {
				marker = "g"; left = active_left; right = active_left + cell_height * 4 - 1
				top = active_top; bottom = active_top + cell_height - 1
			} else if (y >= active_top && y < active_top + cell_height * 2 && x >= active_left + cell_height * 4 && x < active_left + cell_height * 6) {
				marker = "q"; left = active_left + cell_height * 4; right = active_left + cell_height * 6 - 1
				top = active_top; bottom = active_top + cell_height * 2 - 1
			} else if (y >= active_top + cell_height && y < active_top + cell_height * 3 && x >= active_left && x < active_left + cell_height * 2) {
				marker = "c"; left = active_left; right = active_left + cell_height * 2 - 1
				top = active_top + cell_height; bottom = active_top + cell_height * 3 - 1
			} else if (y >= active_top + cell_height * 2 && y < active_top + cell_height * 3 && x >= active_left + cell_height * 2 && x < active_left + cell_height * 6) {
				marker = "b"; left = active_left + cell_height * 2; right = active_left + cell_height * 6 - 1
				top = active_top + cell_height * 2; bottom = active_top + cell_height * 3 - 1
			}
			if (marker == " " || radius_y == 0) return marker
			relative_row = y - top
			relative_column = x - left
			if (marker == "g") {
				corner_row = relative_row; corner_column = relative_column
			} else if (marker == "q") {
				corner_row = relative_row; corner_column = right - x
			} else if (marker == "c") {
				corner_row = bottom - y; corner_column = relative_column
			} else {
				corner_row = bottom - y; corner_column = right - x
			}
			if (outside_round(corner_column, corner_row, radius_y)) return "s"
			return marker
		}
		function family_style(family) {
			if (family == 0) return green
			if (family == 1) return yellow
			if (family == 2) return coral
			return blue
		}
		function marker_style(marker) {
			if (marker == "g") return green
			if (marker == "q") return yellow
			if (marker == "c") return coral
			return blue
		}
		BEGIN {
			esc = sprintf("%c", 27)
			glyphs = "01ART"
			printf "%s[2J%s[H", esc, esc
			if (sw >= 54 && sh >= 26) { lw = 50; lh = 24 } else { lw = 38; lh = 18 }
			cell_height = int(lh / 3)
			width_cell_height = int(lw / 6)
			if (width_cell_height < cell_height) cell_height = width_cell_height
			active_width = cell_height * 6
			active_height = cell_height * 3
			active_left = int((lw - active_width) / 2)
			active_top = int((lh - active_height) / 2)
			scaled_radius_y = cell_height
			logo_left = int((sw - lw) / 2)
			logo_top = int((sh - lh) / 2)
			radius_y = 0
			if (frame >= 34) {
				radius_y = int(((frame - 33) * scaled_radius_y + (final - 34)) / (final - 33))
				if (radius_y > scaled_radius_y) radius_y = scaled_radius_y
			}
			tail_length = 16 - int(frame / 9)
			if (tail_length < 8) tail_length = 8
			fade_progress = frame >= 25 ? int((frame - 24) * 12 / (final - 24)) : 0
			for (row = 0; row < sh; row++) {
				line = ""; current_style = ""
				for (column = 0; column < sw; column++) {
					logo_row = row - logo_top
					marker = target_marker(column - logo_left, logo_row)
					glyph = " "; style = ""
					if (marker != "s" && marker != " " && frame >= final) {
						glyph = substr("ART", ((column - logo_left) % 3) + 1, 1)
						style = marker_style(marker)
					} else if (frame < final && marker != "s") {
						activation = 12 + ((logo_row * 7 + column * 11) % 20)
						if (marker != " " && frame >= activation) {
							glyph = substr("ART", ((column - logo_left) % 3) + 1, 1)
							style = marker_style(marker)
						} else {
							fade_value = (column * 7 + row * 11) % 12
							if (!(fade_progress > 0 && fade_value < fade_progress)) {
								stream = column
								family = ((stream % 4) * 3 + (int(stream / 4) % 4)) % 4
								style = family_style(family)
								head = ((stream * 7 + frame * 3) % (sh + 20)) - 10
								distance = head - row
								stream_active = ((stream * 7 + int(stream / 3) * 11) % 5) != 0
								if (stream_active && distance == 0) glyph = "0"
								else if (stream_active && distance == 1) glyph = "1"
								else if (stream_active && distance >= 2 && distance <= 3) glyph = "A"
								else if (stream_active && distance >= 4 && distance <= 5) glyph = "R"
								else if (stream_active && distance >= 6 && distance <= tail_length) glyph = "T"
								else {
									flow_row = row - frame * 3 + sh * final
									particle = (column * 17 + flow_row * 13) % 80
									if (particle < 1) glyph = substr(glyphs, ((column * 5 + flow_row * 3) % 5) + 1, 1)
								}
							}
						}
					}
					if (!use_color || glyph == " ") {
						line = line glyph
					} else {
						if (style != current_style) {
							line = line esc "[" style "m"
							current_style = style
						}
						line = line glyph
					}
				}
				if (use_color && current_style != "") line = line esc "[0m"
				printf "%s[%d;1H%s%s[K", esc, row + 1, line, esc
			}
		}'
}

render_encoded_logo_cells() {
	local encoded=$1
	local character
	local glyph
	local index
	local style
	local current_style=''
	local output=''
	for ((index = 0; index < ${#encoded}; index++)); do
		character=${encoded:index:1}
		glyph=''
		style=''
		case "$character" in
		g) style=$LOGO_GREEN glyph=${LOGO_GLYPHS:index%3:1} ;;
		q) style=$LOGO_YELLOW glyph=${LOGO_GLYPHS:index%3:1} ;;
		c) style=$LOGO_CORAL glyph=${LOGO_GLYPHS:index%3:1} ;;
		b) style=$LOGO_BLUE glyph=${LOGO_GLYPHS:index%3:1} ;;
		[GHIJK])
			style=$LOGO_GREEN glyph=${character//G/0}
			glyph=${glyph//H/1}
			glyph=${glyph//I/A}
			glyph=${glyph//J/R}
			glyph=${glyph//K/T}
			;;
		[YUVWX])
			style=$LOGO_YELLOW glyph=${character//Y/0}
			glyph=${glyph//U/1}
			glyph=${glyph//V/A}
			glyph=${glyph//W/R}
			glyph=${glyph//X/T}
			;;
		[CDEFO])
			style=$LOGO_CORAL glyph=${character//C/0}
			glyph=${glyph//D/1}
			glyph=${glyph//E/A}
			glyph=${glyph//F/R}
			glyph=${glyph//O/T}
			;;
		[BNMLP])
			style=$LOGO_BLUE glyph=${character//B/0}
			glyph=${glyph//N/1}
			glyph=${glyph//M/A}
			glyph=${glyph//L/R}
			glyph=${glyph//P/T}
			;;
		s | ' ') glyph=' ' ;;
		*) style=$WHITE glyph=$character ;;
		esac
		if ! $color_enabled; then
			output+="$glyph"
		elif [[ $glyph == ' ' ]]; then
			output+=' '
		else
			if [[ $style != "$current_style" ]]; then
				output+=$'\033['"$style"'m'
				current_style=$style
			fi
			output+="$glyph"
		fi
	done
	if $color_enabled && [[ -n $current_style ]]; then
		output+=$'\033[0m'
	fi
	printf '%s' "$output"
}

render_large_logo_hero_row() {
	local encoded=$1
	local right_text=$2
	local right_text_style=$3
	local left_width=$4
	local right_width=$5
	local logo_width=${#encoded}
	local space=$((left_width - logo_width))
	local left_padding=$((space / 2))
	local right_padding=$((space - left_padding))
	paint "$VIOLET" '│'
	printf '%*s' "$left_padding" ''
	render_encoded_logo_cells "$encoded"
	printf '%*s' "$right_padding" ''
	paint "$VIOLET" '│'
	dashboard_cell "$right_text" "$right_text_style" "$right_width"
	paint "$VIOLET" '│'
	printf '\n'
}

render_large_fastfetch_intro() {
	local left_width=$((ui_width * 42 / 100))
	local right_width=$((ui_width - left_width - 3))
	local logo_width=38
	local logo_height=18
	local system_name
	local architecture
	local shell_name=${SHELL##*/}
	local profile
	local index
	local encoded
	local -a right_lines
	local -a right_styles
	system_name=$(uname -s 2>/dev/null || printf 'UNKNOWN')
	architecture=$(uname -m 2>/dev/null || printf 'UNKNOWN')
	if $preview; then profile='DEMO / NO MUTATIONS'; else profile='LIVE / DETERMINISTIC'; fi
	right_lines=(
		'──── ENVIRONMENT // LOCAL ────'
		"OS          :: $system_name"
		"ARCH        :: $architecture"
		"SHELL       :: $shell_name"
		'ENGINE      :: MISE / LOCKED'
		'SOURCE      :: MISE.LOCK'
		"VIEWPORT    :: ${viewport_width}x${viewport_height}"
		"CANVAS      :: ${ui_width} COL / CENTERED"
		'──── SOFTWARE BUS // STANDBY ────'
		'MOTION      :: DECRYPT + MATRIX'
		"PROFILE     :: $profile"
		'AESTHETIC   :: 100%'
		'NECESSITY   :: 0%'
		'PARTICLES   :: ARMED'
		'ENTROPY     :: 0.983'
		'PURPOSE     :: NULL'
		'MATRIX BUS  :: SYNCHRONIZED'
		'SIGNAL      :: READY'
	)
	right_styles=("$CYAN" "$WHITE" "$WHITE" "$WHITE" "$WHITE" "$MUTED" "$MAGENTA" "$MAGENTA" "$CYAN" "$MATRIX_MID" "$MUTED" "$MAGENTA" "$MUTED" "$MAGENTA" "$MUTED" "$MUTED" "$MATRIX_MID" "$GREEN")
	paint "$VIOLET" "╭$(repeat '─' "$left_width")┬$(repeat '─' "$right_width")╮"
	printf '\n'
	for ((index = 0; index < logo_height; index++)); do
		encoded=$(encoded_logo_line "$index" "$logo_width" "$logo_height")
		render_large_logo_hero_row "$encoded" "${right_lines[$index]}" "${right_styles[$index]}" "$left_width" "$right_width"
	done
	paint "$VIOLET" "╰$(repeat '─' "$left_width")┴$(repeat '─' "$right_width")╯"
	printf '\n'
}

completed_in_range() {
	local start=$1
	local count=$2
	if ((operation_cursor <= start)); then
		printf '0'
	elif ((operation_cursor >= start + count)); then
		printf '%s' "$count"
	else
		printf '%s' "$((operation_cursor - start))"
	fi
}

top_block_border() {
	local position=$1
	local first_width=$2
	local second_width=$3
	local third_width=$4
	local gap=$5
	local left
	local right
	case "$position" in
	top) left='╭' right='╮' ;;
	*) left='╰' right='╯' ;;
	esac
	paint "$WHITE" "$left$(repeat '─' "$((first_width - 2))")$right"
	printf '%*s' "$gap" ''
	paint "$WHITE" "$left$(repeat '─' "$((second_width - 2))")$right"
	printf '%*s' "$gap" ''
	paint "$WHITE" "$left$(repeat '─' "$((third_width - 2))")$right"
	printf '\n'
}

top_block_text_cell() {
	local text=$1
	local style=$2
	local width=$3
	local visible
	local padding
	visible=$(clip "$text" "$((width - 4))")
	padding=$((width - $(text_width "$visible") - 3))
	paint "$WHITE" '│'
	printf ' '
	paint "$style" "$visible"
	printf '%*s' "$padding" ''
	paint "$WHITE" '│'
}

top_block_logo_cell() {
	local encoded=$1
	local width=$2
	local inner_width=$((width - 2))
	local left_padding=$(((inner_width - ${#encoded}) / 2))
	local right_padding=$((inner_width - ${#encoded} - left_padding))
	paint "$WHITE" '│'
	printf '%*s' "$left_padding" ''
	render_encoded_logo_cells "$encoded"
	printf '%*s' "$right_padding" ''
	paint "$WHITE" '│'
}

genre_progress_label() {
	local label=$1
	local start=$2
	local count=$3
	local completed
	local marker=' '
	completed=$(completed_in_range "$start" "$count")
	if ((operation_cursor >= start && operation_cursor < start + count)); then marker='>'; fi
	printf '%s %-11s // %02d OF %02d' "$marker" "$label" "$completed" "$count"
}

genre_progress_bar() {
	local start=$1
	local count=$2
	local width=$3
	local completed
	local percent
	completed=$(completed_in_range "$start" "$count")
	percent=$((completed * 100 / count))
	printf '%s' "$(tracker_bar "$percent" "$width")"
}

render_three_block_header() {
	local gap=2
	local available=$((ui_width - gap * 2))
	local first_width=$((available * 30 / 100))
	local second_width=$((available * 31 / 100))
	local third_width=$((available - first_width - second_width))
	local graph_width=$((third_width - 4))
	local system_name
	local architecture
	local shell_name=${SHELL##*/}
	local profile
	local index
	local logo_line
	local -a environment_lines
	local -a environment_styles
	local -a progress_lines
	local -a progress_styles
	system_name=$(uname -s 2>/dev/null || printf 'UNKNOWN')
	architecture=$(uname -m 2>/dev/null || printf 'UNKNOWN')
	if $preview; then
		profile='DEMO / NULL WRITE'
	else
		profile='LIVE / LOCKED'
	fi
	environment_lines=(
		'ENVIRONMENT // LOCAL'
		"OS      :: $system_name"
		"ARCH    :: $architecture"
		"SHELL   :: $shell_name"
		'ENGINE  :: MISE'
		'LOCK    :: MISE.LOCK'
		"PROFILE :: $profile"
		"VIEW    :: ${viewport_width}x${viewport_height}"
		"CANVAS  :: ${ui_width} COL"
		"${MINI_DOT_FRAMES[$((tui_tick % ${#MINI_DOT_FRAMES[@]}))]} SIGNAL :: SYNCHRONIZED"
	)
	environment_styles=("$CYAN" "$WHITE" "$WHITE" "$WHITE" "$WHITE" "$MUTED" "$MAGENTA" "$MAGENTA" "$MUTED" "$GREEN")
	progress_lines=(
		'PROGRESS // ACCUMULATION'
		"$(genre_progress_label 'RUNTIME' 0 5)"
		"$(genre_progress_bar 0 5 "$graph_width")"
		"$(genre_progress_label 'BUILD' 5 2)"
		"$(genre_progress_bar 5 2 "$graph_width")"
		"$(genre_progress_label 'INTEGRATION' 7 5)"
		"$(genre_progress_bar 7 5 "$graph_width")"
		"$(genre_progress_label 'VALIDATION' 12 3)"
		"$(genre_progress_bar 12 3 "$graph_width")"
		"TOTAL // $(printf '%02d' "$operation_cursor") OF $(printf '%02d' "$OPERATION_COUNT")"
	)
	progress_styles=("$CYAN" "$WHITE" "$LOGO_GREEN" "$WHITE" "$LOGO_YELLOW" "$WHITE" "$LOGO_CORAL" "$WHITE" "$LOGO_BLUE" "$MAGENTA")

	top_block_border top "$first_width" "$second_width" "$third_width" "$gap"
	for ((index = 0; index < 10; index++)); do
		if ((first_width >= 32)); then
			logo_line=$(encoded_logo_line "$index" 30 10)
		elif ((index >= 1 && index <= 7)); then
			logo_line=$(encoded_logo_line "$((index - 1))" 18 7)
		else
			logo_line=''
		fi
		top_block_logo_cell "$logo_line" "$first_width"
		printf '%*s' "$gap" ''
		top_block_text_cell "${environment_lines[$index]}" "${environment_styles[$index]}" "$second_width"
		printf '%*s' "$gap" ''
		top_block_text_cell "${progress_lines[$index]}" "${progress_styles[$index]}" "$third_width"
		printf '\n'
	done
	top_block_border bottom "$first_width" "$second_width" "$third_width" "$gap"
}

render_fastfetch_intro() {
	render_three_block_header
}

scramble_line() {
	local target=$1
	local frame=$2
	local row_number=$3
	local result=''
	local index
	local character
	local activation
	local discovery
	local glyph_index
	for ((index = 0; index < ${#target}; index++)); do
		character=${target:index:1}
		if [[ $character == ' ' ]]; then
			result+=' '
			continue
		fi
		activation=$(((index + row_number * 5) % 4))
		discovery=$((3 + (index * 7 + row_number * 13) % 9))
		if ((frame < activation)); then
			result+=' '
		elif ((frame >= discovery)); then
			result+=$character
		else
			glyph_index=$(((frame * 11 + index * 5 + row_number * 7) % ${#DECRYPT_GLYPHS}))
			result+=${DECRYPT_GLYPHS:glyph_index:1}
		fi
	done
	printf '%s' "$result"
}

divider() {
	paint "$VIOLET" '├'
	paint "$MUTED" "$(repeat '─' "$((ui_width - 2))")"
	paint "$VIOLET" '┤'
	printf '\n'
}

particle_frame() {
	local frame=$1
	local line=""
	local column
	local value
	for ((column = 0; column < ui_width; column++)); do
		value=$(((column * 17 + frame * 23 + column * frame) % 67))
		case "$value" in
		0) line+='*' ;;
		1 | 2) line+='+' ;;
		3 | 4 | 5) line+='.' ;;
		*) line+=' ' ;;
		esac
	done
	printf '%s' "$line"
}

animate_particles() {
	$motion_enabled || return 0
	local frames=${1:-8}
	local frame
	local field
	local style
	for ((frame = 0; frame < frames; frame++)); do
		case $((frame % 4)) in
		0) style=$CYAN ;;
		1) style=$BLUE ;;
		2) style=$VIOLET ;;
		*) style=$MAGENTA ;;
		esac
		field=$(particle_frame "$frame")
		printf '\r\033[2K'
		paint "$style" "${PULSE_FRAMES[$((frame % ${#PULSE_FRAMES[@]}))]}${field:1}"
		sleep 0.04
	done
	printf '\r\033[2K'
}

matrix_glyph() {
	local frame=$1
	local row=$2
	local column=$3
	local glyphs='01ART{}[]<>+=/'
	local index=$(((frame * 5 + row * 7 + column * 13) % ${#glyphs}))
	printf '%s' "${glyphs:index:1}"
}

matrix_signal_line() {
	local frame=$1
	local glyphs='01ART{}[]<>+=/'
	local column
	local value
	local glyph_index
	local line=''
	for ((column = 0; column < ui_width; column++)); do
		value=$(((column * 17 + frame * 29) % 31))
		if ((value < 7)); then
			glyph_index=$(((column * 11 + frame * 7) % ${#glyphs}))
			line+=${glyphs:glyph_index:1}
		else
			line+=' '
		fi
	done
	printf '%s' "$line"
}

render_matrix_row() {
	local frame=$1
	local row=$2
	local rain_rows=$3
	local cycle=$((rain_rows + 9))
	local column
	local head
	local distance
	local tail_length
	local glyph
	for ((column = 0; column < ui_width; column++)); do
		if ((column % 2 == 1)); then
			printf ' '
			continue
		fi
		head=$(((column * 5 + frame) % cycle - 4))
		distance=$((head - row))
		tail_length=$((2 + (column * 11) % 6))
		glyph=$(matrix_glyph "$frame" "$row" "$column")
		case "$distance" in
		0) paint "$MATRIX_HEAD" "$glyph" ;;
		1) paint "$MATRIX_BRIGHT" "$glyph" ;;
		2) paint "$MATRIX_MID" "$glyph" ;;
		3 | 4)
			if ((distance <= tail_length)); then
				paint "$MATRIX_DIM" "$glyph"
			else
				printf ' '
			fi
			;;
		*)
			if ((distance > 0 && distance <= tail_length)); then
				paint "$MATRIX_GHOST" "$glyph"
			elif (((column * 19 + row * 23 + frame * 29) % 97 == 0)); then
				paint "$MATRIX_GHOST" "$glyph"
			else
				printf ' '
			fi
			;;
		esac
	done
}

animate_matrix_rain() {
	$motion_enabled || return 0
	local frames=${1:-10}
	local rain_rows
	if ((ui_width >= 88)); then
		rain_rows=7
	elif ((ui_width >= NARROW_TERMINAL_BREAKPOINT)); then
		rain_rows=5
	elif ((ui_width >= MIN_BOX_WIDTH)); then
		rain_rows=4
	else
		rain_rows=2
	fi

	local frame
	local row
	printf '\033[s'
	for ((frame = 0; frame < frames; frame++)); do
		printf '\033[u'
		for ((row = 0; row < rain_rows; row++)); do
			printf '\r\033[2K'
			render_matrix_row "$frame" "$row" "$rain_rows"
			if ((row + 1 < rain_rows)); then
				printf '\n'
			fi
		done
		sleep 0.055
	done

	printf '\033[u'
	for ((row = 0; row < rain_rows; row++)); do
		printf '\r\033[2K'
		if ((row + 1 < rain_rows)); then
			printf '\n'
		fi
	done
	printf '\033[u'
}

animate_calibration() {
	local title=$1
	$motion_enabled || return 0
	local frame
	local signal
	for ((frame = 0; frame < 7; frame++)); do
		signal=$((91 + (frame * 7 + ${#title}) % 9))
		printf '\r\033[2K'
		paint "$MAGENTA" "${MINI_DOT_FRAMES[$((frame % ${#MINI_DOT_FRAMES[@]}))]}"
		if ((ui_width >= NARROW_TERMINAL_BREAKPOINT)); then
			paint "$WHITE" " CALIBRATING $title"
			paint "$MUTED" "  ${POINTS_FRAMES[$((frame % ${#POINTS_FRAMES[@]}))]}  AURA ${METER_FRAMES[$((frame % ${#METER_FRAMES[@]}))]}  ${signal}%"
		elif ((ui_width >= MIN_BOX_WIDTH)); then
			paint "$WHITE" " CALIBRATING $title"
			paint "$MUTED" "  ${signal}%"
		else
			paint "$WHITE" " $title"
			paint "$MUTED" " ${signal}%"
		fi
		sleep 0.06
	done
	printf '\r\033[2K'
}

render_vanity_telemetry() {
	if ((ui_width >= 88)); then
		row '  AESTHETIC [||||||||||||] 100%    NECESSITY [............]   0%' "$MAGENTA"
		row '  PARTICLES ARMED    ENTROPY 0.983    AURA IMMACULATE    PURPOSE NULL' "$MUTED"
		row '  MATRIX RAIN STANDBY    DROP/TAIL MODEL ONLINE    GLYPH DECAY 6 CELLS' "$MATRIX_MID"
	elif ((ui_width >= NARROW_TERMINAL_BREAKPOINT)); then
		centered_row 'STYLE [||||||||] 100%  //  PURPOSE [........] 0%' "$MAGENTA"
		centered_row 'PARTICLES ARMED  //  AURA IMMACULATE' "$MUTED"
		centered_row 'MATRIX RAIN // STANDBY' "$MATRIX_MID"
	elif ((ui_width >= MIN_BOX_WIDTH)); then
		centered_row 'STYLE 100% // PURPOSE 0%' "$MAGENTA"
		centered_row 'PARTICLES ARMED' "$MUTED"
		centered_row 'MATRIX RAIN // STANDBY' "$MATRIX_MID"
	else
		paint "$MAGENTA" "$(clip '  STYLE 100 // USE 0' "$ui_width")"
		printf '\n'
		paint "$MUTED" "$(clip '  PARTICLES ARMED' "$ui_width")"
		printf '\n'
		paint "$MATRIX_MID" "$(clip '  MATRIX RAIN READY' "$ui_width")"
		printf '\n'
	fi
}

render_wide_intro() {
	render_fastfetch_intro
}

render_compact_intro() {
	border '╭' '─' '╮'
	render_ascii_logo_box
	centered_row 'ART-TRA // ENVIRONMENT ORCHESTRATION' "$CYAN"
	divider
	if $preview; then
		centered_row 'DEMO MODE // NO CHANGES' "$MUTED"
	else
		centered_row 'MISE // LOCKED TOOLCHAIN // LOCAL' "$MUTED"
	fi
	divider
	render_vanity_telemetry
	border '╰' '─' '╯'
}

render_narrow_intro() {
	if ((ui_width < MIN_BOX_WIDTH)); then
		render_ascii_logo_plain
		paint "$WHITE" '  ART-TRA SETUP'
		printf '\n'
		if $preview; then
			paint "$MUTED" '  DEMO // NO CHANGES'
		else
			paint "$MUTED" "  MISE // ${ui_width} COL"
		fi
		printf '\n'
		render_vanity_telemetry
		return
	fi
	border '╭' '─' '╮'
	render_ascii_logo_box
	centered_row 'ART-TRA' "$CYAN"
	centered_row 'ENVIRONMENT SETUP' "$WHITE"
	if $preview; then
		centered_row 'DEMO // NO CHANGES' "$MUTED"
	else
		centered_row 'MISE // LOCKED' "$MUTED"
	fi
	divider
	render_vanity_telemetry
	border '╰' '─' '╯'
}

render_intro() {
	refresh_terminal_width
	printf '\n'
	if [[ $layout_mode == landscape ]]; then
		render_wide_intro
	elif [[ $layout_mode == portrait && $ui_width -ge NARROW_TERMINAL_BREAKPOINT ]]; then
		render_compact_intro
	else
		render_narrow_intro
	fi
}

check_style_and_tag() {
	local state=$1
	case "$state" in
	ONLINE)
		check_style=$GREEN
		check_tag='[OK]'
		;;
	ACTIVE)
		check_style=$MAGENTA
		check_tag='[>>]'
		;;
	DEGRADED)
		check_style=$AMBER
		check_tag='[!!]'
		;;
	ABORTED)
		check_style=$RED
		check_tag='[XX]'
		;;
	*)
		check_style=$MUTED
		check_tag='[  ]'
		;;
	esac
}

resolved_check_count() {
	local count=0
	local state
	for state in "${step_states[@]}"; do
		case "$state" in
		ONLINE | DEGRADED) count=$((count + 1)) ;;
		esac
	done
	printf '%s' "$count"
}

tracker_progress_percent() {
	local resolved
	local percent
	local state
	resolved=$(resolved_check_count)
	percent=$((resolved * 100 / STEP_COUNT))
	for state in "${step_states[@]}"; do
		if [[ $state == ACTIVE ]]; then
			percent=$((percent + 8))
			break
		fi
	done
	if ((percent > 100)); then
		percent=100
	fi
	printf '%s' "$percent"
}

# Port of cli-tracker's renderBar: round the ratio to filled blocks, then pad
# the remainder with light blocks. The numbers are gloriously unactionable.
tracker_bar() {
	local percent=$1
	local width=${2:-10}
	local filled=$(((percent * width + 50) / 100))
	local empty=$((width - filled))
	printf '%s%s' "$(repeat '█' "$filled")" "$(repeat '░' "$empty")"
}

dashboard_cell() {
	local text=$1
	local style=$2
	local width=$3
	local visible
	local padding
	visible=$(clip "$text" "$((width - 2))")
	padding=$((width - $(text_width "$visible") - 1))
	printf ' '
	paint "$style" "$visible"
	printf '%*s' "$padding" ''
}

dashboard_row() {
	local left_text=$1
	local left_style=$2
	local right_text=$3
	local right_style=$4
	local left_width=$5
	local right_width=$6
	paint "$VIOLET" '│'
	dashboard_cell "$left_text" "$left_style" "$left_width"
	paint "$VIOLET" '│'
	dashboard_cell "$right_text" "$right_style" "$right_width"
	paint "$VIOLET" '│'
	printf '\n'
}

render_wide_dashboard() {
	local number=$1
	local operation_index=$operation_cursor
	local operation_name
	local operation_command
	local operation_detail
	local operation_genre
	local right_width=31
	local left_width=$((ui_width - right_width - 3))
	local resolved
	local index
	local right_text
	local right_style
	local dashboard_signal=$((91 + (tui_tick * 13 + number * 7) % 9))
	local command_label='CMD'
	local next_command
	local -a left_texts
	local -a left_styles=("$CYAN" "$WHITE" "$MUTED" "$MAGENTA" "$MAGENTA" "$MUTED")

	if $setup_failed; then
		operation_name="INSTALL HALTED // $failure_title"
		operation_command=$failure_command
		operation_detail="EXIT $failure_exit // REQUIRED COMPONENT UNAVAILABLE"
		operation_genre='FAULT'
		command_label='FAILED'
		dashboard_signal=0
		left_styles=("$RED" "$RED" "$RED" "$AMBER" "$RED" "$MUTED")
	elif ((operation_index >= OPERATION_COUNT)); then
		next_command=$(completion_next_command)
		operation_name='SETUP COMPLETE // ALL OPERATIONS SEALED'
		operation_command=$next_command
		operation_detail="NEXT :: $next_command // GUIDE :: $SETUP_MANUAL_URL"
		operation_genre='COMPLETE'
		command_label='NEXT'
		dashboard_signal=100
	else
		operation_name=${OPERATION_NAMES[$operation_index]}
		operation_command=${OPERATION_COMMANDS[$operation_index]}
		operation_detail=${OPERATION_DETAILS[$operation_index]}
		operation_genre=${OPERATION_GENRES[$operation_index]}
	fi
	left_texts=(
		"OPERATION // $(printf '%02d' "$((operation_index + 1 > OPERATION_COUNT ? OPERATION_COUNT : operation_index + 1))") OF $(printf '%02d' "$OPERATION_COUNT") // $operation_genre"
		"> $operation_name"
		"$command_label :: $operation_command"
		"$(clip "$operation_detail" "$((left_width - 2))")"
		"${PULSE_FRAMES[$((tui_tick % ${#PULSE_FRAMES[@]}))]} INSTALL TRACE ${POINTS_FRAMES[$((tui_tick % ${#POINTS_FRAMES[@]}))]}  SIGNAL ${dashboard_signal}%  PKT $((2048 + tui_tick * 173))"
		"EVENT :: $tui_event"
	)

	resolved=$(resolved_check_count)
	printf '\n'
	paint "$VIOLET" "╭$(repeat '─' "$left_width")┬$(repeat '─' "$right_width")╮"
	printf '\n'
	dashboard_row "${left_texts[0]}" "${left_styles[0]}" \
		"SETUP CHECKS // $(printf '%02d' "$resolved") OF $(printf '%02d' "$STEP_COUNT")" "$CYAN" \
		"$left_width" "$right_width"
	for index in 0 1 2 3 4; do
		check_style_and_tag "${step_states[$index]}"
		right_text="$check_tag $(printf '%02d' "$((index + 1))") ${STEP_TITLES[$index]}"
		right_style=$check_style
		dashboard_row "${left_texts[$((index + 1))]}" "${left_styles[$((index + 1))]}" \
			"$right_text" "$right_style" "$left_width" "$right_width"
	done
	paint "$VIOLET" "╰$(repeat '─' "$left_width")┴$(repeat '─' "$right_width")╯"
	printf '\n'
}

component_top_border() {
	local title=$1
	local visible
	local label
	visible=$(clip "$title" "$((ui_width - 4))")
	label=" $visible "
	local fill_count=$((ui_width - $(text_width "$label") - 2))
	paint "$VIOLET" '╭'
	paint "$CYAN" "$label"
	paint "$VIOLET" "$(repeat '─' "$fill_count")╮"
	printf '\n'
}

completed_genre_line() {
	local label=$1
	local start=$2
	local count=$3
	local completed
	local index
	local items=''
	completed=$(completed_in_range "$start" "$count")
	for ((index = start; index < start + completed; index++)); do
		if [[ -n $items ]]; then items+=' · '; fi
		items+=${OPERATION_SHORT_NAMES[$index]}
	done
	if [[ -z $items ]]; then items='WAITING'; fi
	printf '%-11s [%02d/%02d] :: %s' "$label" "$completed" "$count" "$items"
}

completed_genre_style() {
	local start=$1
	local count=$2
	local completed
	completed=$(completed_in_range "$start" "$count")
	if ((completed == count)); then
		completed_style=$GREEN
	elif ((completed > 0)); then
		completed_style=$CYAN
	else
		completed_style=$MUTED
	fi
}

render_execution_components() {
	local number=$1
	local index=$((number - 1))
	local state=${step_states[$index]}
	local operation_index=$operation_cursor
	local operation_name
	local operation_command
	local operation_genre
	local state_label
	local state_style=$MAGENTA
	local next_command
	local packet_count=$((2048 + tui_tick * 173 + number * 997))
	local signal=$((91 + (tui_tick * 13 + number * 7) % 9))
	local operation_percent=$((operation_cursor * 100 / OPERATION_COUNT))
	local operation_bar
	local latest='NONE'
	local rotor_phase=$((tui_tick % 4))
	local rotor_top='o'
	local rotor_right='o'
	local rotor_bottom='o'
	local rotor_left='o'
	local rotor_core='|'
	case "$rotor_phase" in
	0)
		rotor_top='@'
		rotor_core='|'
		;;
	1)
		rotor_right='@'
		rotor_core='/'
		;;
	2)
		rotor_bottom='@'
		rotor_core='-'
		;;
	3)
		rotor_left='@'
		rotor_core=$'\\'
		;;
	esac
	if ((operation_cursor > 0)); then latest=${OPERATION_SHORT_NAMES[$((operation_cursor - 1))]}; fi
	if $setup_failed; then
		operation_name="INSTALL HALTED // $failure_title"
		operation_command=$failure_command
		operation_genre='FAULT'
		signal=0
		state_style=$RED
	elif ((operation_index >= OPERATION_COUNT)); then
		next_command=$(completion_next_command)
		operation_name='SETUP COMPLETE // ALL OPERATIONS SEALED'
		operation_command=$next_command
		operation_genre='COMPLETE'
		signal=100
	else
		operation_name=${OPERATION_NAMES[$operation_index]}
		operation_command=${OPERATION_COMMANDS[$operation_index]}
		operation_genre=${OPERATION_GENRES[$operation_index]}
	fi
	case "$state" in
	ACTIVE) state_label='EXECUTING' ;;
	ONLINE) state_label='VERIFIED' ;;
	DEGRADED) state_label='MANUAL FALLBACK' ;;
	ABORTED) state_label='ABORTED' ;;
	*) state_label='QUEUED' ;;
	esac
	if [[ $state == ACTIVE ]] && ((operation_percent < 97)); then
		operation_percent=$((operation_percent + 3 + tui_tick % 3))
	fi
	operation_bar=$(tracker_bar "$operation_percent" 18)

	if [[ $layout_mode == portrait ]]; then
		component_top_border "LIVE INSTALL // $(printf '%02d' "$((operation_index + 1 > OPERATION_COUNT ? OPERATION_COUNT : operation_index + 1))") OF $(printf '%02d' "$OPERATION_COUNT")"
		row "  ${MINI_DOT_FRAMES[$((tui_tick % ${#MINI_DOT_FRAMES[@]}))]} [$state_label] $operation_name" "$state_style"
		if $setup_failed; then
			row "  FAILED :: $operation_command // EXIT $failure_exit" "$RED"
			row '  NEXT :: FIX PREREQUISITE; mise run setup-ar' "$AMBER"
			row "  GUIDE :: $failure_manual_url" "$CYAN"
		elif ((operation_index >= OPERATION_COUNT)); then
			row "  NEXT :: $next_command" "$GREEN"
			row "  GUIDE :: $SETUP_MANUAL_URL" "$CYAN"
		else
			row "  > $operation_command" "$WHITE"
		fi
		row "  ROTARY [$rotor_top][$rotor_right][$rotor_bottom][$rotor_left] // CORE $rotor_core // CW // PHASE 0$rotor_phase" "$CYAN"
		row "  $operation_bar ${operation_percent}% // SIG ${signal}% // PKT $packet_count" "$CYAN"
		border '╰' '─' '╯'
		component_top_border 'COMPLETED COLLECTION'
		row "  $(printf '%02d' "$operation_cursor")/$OPERATION_COUNT ARCHIVED // LATEST :: $latest" "$GREEN"
		border '╰' '─' '╯'
		return
	fi

	component_top_border "LIVE INSTALLER // $(printf '%02d' "$((operation_index + 1 > OPERATION_COUNT ? OPERATION_COUNT : operation_index + 1))") OF $(printf '%02d' "$OPERATION_COUNT") // $operation_genre"
	row "  ${MINI_DOT_FRAMES[$((tui_tick % ${#MINI_DOT_FRAMES[@]}))]} [$state_label]  > $operation_name" "$state_style"
	if $setup_failed; then
		row "  FAILED  :: $operation_command" "$RED"
		row "  EXIT    :: $failure_exit // REQUIRED COMPONENT UNAVAILABLE" "$RED"
	elif ((operation_index >= OPERATION_COUNT)); then
		row "  NEXT    :: $next_command" "$GREEN"
		row "  GUIDE   :: $SETUP_MANUAL_URL" "$CYAN"
	else
		row "  COMMAND :: $operation_command" "$WHITE"
		row "  PIPE    :: ACQUIRE -> RESOLVE -> VERIFY -> ARCHIVE" "$CYAN"
	fi
	row "  ROTARY CORE              [$rotor_top]                 PHASE 0$rotor_phase" "$MAGENTA"
	row "                         [$rotor_left] <$rotor_core> [$rotor_right]              CLOCKWISE" "$CYAN"
	row "                             [$rotor_bottom]                 FLUX ${signal}%" "$MAGENTA"
	if $setup_failed; then
		row "  ${PULSE_FRAMES[$((tui_tick % ${#PULSE_FRAMES[@]}))]} $operation_bar ${operation_percent}%  FAULT LATCHED // SIGNAL 0% // EXIT $failure_exit" "$RED"
		row "  NEXT    :: FIX PREREQUISITE; mise run setup-ar // GUIDE :: $failure_manual_url" "$AMBER"
	else
		row "  ${PULSE_FRAMES[$((tui_tick % ${#PULSE_FRAMES[@]}))]} $operation_bar ${operation_percent}%  ${POINTS_FRAMES[$((tui_tick % ${#POINTS_FRAMES[@]}))]} SIGNAL ${signal}%  //  PACKETS $packet_count" "$MAGENTA"
		row "  TRACE   :: $tui_event" "$MATRIX_MID"
	fi
	border '╰' '─' '╯'

	component_top_border "COMPLETED COLLECTION // $(printf '%02d' "$operation_cursor") ARCHIVED"
	completed_genre_style 0 5
	row "  $(completed_genre_line 'RUNTIME' 0 5)" "$completed_style"
	completed_genre_style 5 2
	row "  $(completed_genre_line 'BUILD' 5 2)" "$completed_style"
	completed_genre_style 7 5
	row "  $(completed_genre_line 'INTEGRATION' 7 5)" "$completed_style"
	completed_genre_style 12 3
	row "  $(completed_genre_line 'VALIDATION' 12 3)" "$completed_style"
	border '╰' '─' '╯'
}

compact_check_cell() {
	local index=$1
	local width=$2
	local text
	local visible
	local padding
	check_style_and_tag "${step_states[$index]}"
	text="$check_tag $(printf '%02d' "$((index + 1))") ${STEP_TITLES[$index]}"
	visible=$(clip "$text" "$width")
	padding=$((width - $(text_width "$visible")))
	paint "$check_style" "$visible"
	printf '%*s' "$padding" ''
}

render_stacked_checklist() {
	local resolved
	local progress
	local progress_bar
	local column_width
	local index
	resolved=$(resolved_check_count)
	progress=$(tracker_progress_percent)
	if ((ui_width < MIN_BOX_WIDTH)); then
		paint "$MUTED" "  CHECKS $(repeat '#' "$resolved")$(repeat '.' "$((STEP_COUNT - resolved))") $resolved/$STEP_COUNT"
		printf '\n'
		return
	fi

	progress_bar=$(tracker_bar "$progress" 8)
	if ((ui_width >= NARROW_TERMINAL_BREAKPOINT)); then
		paint "$CYAN" "  SETUP CHECKS // $(printf '%02d' "$resolved") OF $(printf '%02d' "$STEP_COUNT")  "
	else
		paint "$CYAN" "  CHECKS $resolved/$STEP_COUNT  "
	fi
	paint "$MAGENTA" "$progress_bar"
	paint "$MUTED" " ${progress}%"
	printf '\n'
	if ((ui_width >= NARROW_TERMINAL_BREAKPOINT)); then
		column_width=$(((ui_width - 5) / 2))
		for index in 0 2 4; do
			printf '  '
			compact_check_cell "$index" "$column_width"
			if ((index + 1 < STEP_COUNT)); then
				printf ' '
				compact_check_cell "$((index + 1))" "$column_width"
			fi
			printf '\n'
		done
	else
		for index in 0 1 2 3 4; do
			printf '  '
			compact_check_cell "$index" "$((ui_width - 2))"
			printf '\n'
		done
	fi
}

render_stage_dashboard() {
	local number=$1
	local title=$2
	local detail=$3
	refresh_terminal_width
	if [[ $layout_mode == landscape ]]; then
		render_wide_dashboard "$number" "$title" "$detail"
	else
		render_phase "$number" "$title" "$detail"
		render_stacked_checklist
	fi
}

render_phase() {
	local number=$1
	local title=$2
	local detail=$3
	local marker
	local fill_count
	marker=$(printf '%02d/%02d :: %s' "$number" "$STEP_COUNT" "$title")
	printf '\n'
	if ((ui_width >= 50)); then
		fill_count=$((ui_width - $(text_width "$marker") - 5))
		paint "$VIOLET" '━━ '
		paint "$WHITE" "$marker"
		printf ' '
		paint "$MUTED" "$(repeat '━' "$fill_count")"
		printf '\n'
		if ((ui_width >= 88)); then
			paint "$MUTED" "   $detail  //  FLUX 0.$((number * 173 + 109))  //  DUST $((number * 19 + 3))%"
		else
			paint "$MUTED" "   $detail"
		fi
		printf '\n'
	else
		paint "$WHITE" "$(clip "[$(printf '%02d' "$number")/$(printf '%02d' "$STEP_COUNT")] $title" "$ui_width")"
		printf '\n'
		paint "$MUTED" "$(clip "  $detail" "$ui_width")"
		printf '\n'
	fi
}

render_status() {
	local state=$1
	local title=$2
	local elapsed=$3
	local symbol
	local short_state
	local style
	local aura
	case "$state" in
	ONLINE)
		symbol='◆'
		short_state='OK'
		style=$GREEN
		;;
	DEGRADED)
		symbol='◇'
		short_state='WARN'
		style=$AMBER
		;;
	ABORTED)
		symbol='×'
		short_state='FAIL'
		style=$RED
		;;
	esac
	if ((ui_width < MIN_BOX_WIDTH)); then
		paint "$style" "$(clip "$symbol $short_state  $title ${elapsed}s" "$ui_width")"
		printf '\n'
		return
	fi
	paint "$style" "$symbol $state"
	if ((ui_width >= 88)); then
		aura=$((91 + (${#title} * 7 + elapsed) % 9))
		paint "$MUTED" "  $title · ${elapsed}s  //  AURA ${aura}%  //  PARTICLES NOMINAL"
	else
		paint "$MUTED" "  $title · ${elapsed}s"
	fi
	printf '\n'
}

render_event() {
	local japanese_message=$1
	local compact_message=$2
	local confidence=$3
	refresh_terminal_width
	paint "$GREEN" '  [AUTH]'
	if ((ui_width >= NARROW_TERMINAL_BREAKPOINT)); then
		paint "$WHITE" " $japanese_message"
		if ((ui_width >= SIDE_PANEL_BREAKPOINT)); then
			paint "$MUTED" " // TRUST ${confidence}%"
		fi
	else
		paint "$WHITE" " $(clip "$compact_message" "$((ui_width - 9))")"
	fi
	printf '\n'
	if $motion_enabled; then
		sleep 0.09
	fi
}

render_authentication_events() {
	local number=$1
	case "$number" in
	1)
		render_event 'mise.lock を読み込みました' 'mise.lock loaded' 97
		render_event 'runtime version の認証ができました' 'runtime authenticated' 99
		render_event 'toolchain checksum の検証ができました' 'checksum verified' 98
		;;
	2)
		render_event 'git-ar binary の導入ができました' 'git-ar installed' 96
		render_event 'command entrypoint の認証ができました' 'entrypoint authenticated' 99
		;;
	3)
		render_event 'Git hook の認証ができました' 'Git hook authenticated' 99
		render_event 'Claude integration の認証ができました' 'Claude authenticated' 97
		render_event 'Codex integration の認証ができました' 'Codex authenticated' 98
		;;
	4)
		render_event 'presence heartbeat の登録ができました' 'heartbeat registered' 96
		render_event 'background scheduler の認証ができました' 'scheduler authenticated' 95
		;;
	5)
		render_event 'repository diagnostics に合格しました' 'diagnostics passed' 99
		render_event 'workspace readiness の認証ができました' 'workspace authenticated' 99
		;;
	esac
}

render_degraded_event() {
	refresh_terminal_width
	paint "$AMBER" '  [MANUAL]'
	if ((ui_width >= NARROW_TERMINAL_BREAKPOINT)); then
		paint "$WHITE" ' presence scheduler を手動モードへ切り替えました'
	else
		paint "$WHITE" " $(clip 'presence: manual mode' "$((ui_width - 11))")"
	fi
	printf '\n'
}

render_tui_portrait_header() {
	border '╭' '─' '╮'
	render_ascii_logo_box
	centered_row 'ART-TRA // ENVIRONMENT SETUP' "$CYAN"
	centered_row "${viewport_width}x${viewport_height} // $layout_mode // AUTO REFLOW" "$MUTED"
	border '╰' '─' '╯'
}

render_tui_minimal() {
	local number=$1
	local title=$2
	local progress
	local next_command
	render_ascii_logo_plain
	progress=$(tracker_progress_percent)
	centered_plain "$(clip "[$(printf '%02d' "$number")/$STEP_COUNT] $title" "$ui_width")" "$WHITE"
	centered_plain "$(tracker_bar "$progress" 6) ${progress}%" "$MAGENTA"
	centered_plain "$(clip "$tui_event" "$ui_width")" "$MUTED"
	if $setup_failed; then
		centered_plain "$(clip 'NEXT :: FIX PREREQUISITE; mise run setup-ar' "$ui_width")" "$AMBER"
		centered_plain "$(clip "GUIDE :: $failure_manual_url" "$ui_width")" "$CYAN"
	elif ((operation_cursor >= OPERATION_COUNT)); then
		next_command=$(completion_next_command)
		centered_plain "$(clip "NEXT :: $next_command" "$ui_width")" "$GREEN"
		centered_plain "$(clip "GUIDE :: $SETUP_MANUAL_URL" "$ui_width")" "$CYAN"
	fi
}

render_tui_content() {
	local number=$1
	local title=$2
	local detail=$3
	case "$layout_mode" in
	landscape)
		render_fastfetch_intro
		render_wide_dashboard "$number" "$title" "$detail"
		if ((viewport_height >= 38)); then
			render_execution_components "$number"
		fi
		;;
	portrait)
		render_tui_portrait_header
		render_phase "$number" "$title" "$detail"
		if ((ui_width >= NARROW_TERMINAL_BREAKPOINT && viewport_height >= 32)); then
			render_execution_components "$number"
		fi
		render_stacked_checklist
		centered_plain "$(clip "$tui_event" "$ui_width")" "$MUTED"
		if ((ui_width < NARROW_TERMINAL_BREAKPOINT || viewport_height < 32)); then
			if $setup_failed; then
				centered_plain "$(clip 'NEXT :: FIX PREREQUISITE; mise run setup-ar' "$ui_width")" "$AMBER"
				centered_plain "$(clip "GUIDE :: $failure_manual_url" "$ui_width")" "$CYAN"
			elif ((operation_cursor >= OPERATION_COUNT)); then
				centered_plain "$(clip "NEXT :: $(completion_next_command)" "$ui_width")" "$GREEN"
				centered_plain "$(clip "GUIDE :: $SETUP_MANUAL_URL" "$ui_width")" "$CYAN"
			fi
		fi
		;;
	*)
		render_tui_minimal "$number" "$title"
		;;
	esac
	if ! $persistent_frame; then
		centered_plain "$(matrix_signal_line "$tui_tick")" "$MATRIX_GHOST"
	fi
}

render_completion_content() {
	local next_command
	local completion_title
	local completion_status
	local spinner
	next_command=$(completion_next_command)
	if $preview; then
		completion_title='DEMO COMPLETE // NO CHANGES'
	elif $has_degraded; then
		completion_title='SETUP COMPLETE // MANUAL MODE'
	else
		completion_title='SETUP COMPLETE // WORKSPACE READY'
	fi
	if $has_degraded; then
		completion_status='REQUIRED 13/13 // PRESENCE MANUAL // TRUST 100%'
	else
		completion_status='FLUX 100% // SIGNAL 100% // TRUST 100%'
	fi
	case "$((tui_tick % 4))" in
	0) spinner='|' ;;
	1) spinner='/' ;;
	2) spinner='-' ;;
	*) spinner=$'\\' ;;
	esac

	component_top_border "$completion_title"
	if ((viewport_height >= 21)); then
		render_ascii_logo_box
		divider
		centered_row "[$spinner] SETUP COMPLETE [$spinner]" "$GREEN"
		centered_row '15 / 15 OPERATIONS SEALED' "$WHITE"
		if $has_degraded; then
			centered_row 'NEXT COMMAND' "$CYAN"
			centered_row "\$ $next_command" "$GREEN"
			centered_row 'OPTIONAL BACKGROUND WATCHER' "$AMBER"
			centered_row 'mise run presence:watch // KEEP RUNNING IN ANOTHER TERMINAL // CTRL-C TO STOP' "$AMBER"
			centered_row 'NOTION // SETUP GUIDE' "$CYAN"
			centered_row "$SETUP_MANUAL_URL" "$WHITE"
		else
			centered_row ''
			centered_row 'NEXT COMMAND' "$CYAN"
			centered_row "\$ $next_command" "$GREEN"
			centered_row ''
			centered_row 'NOTION // SETUP GUIDE' "$CYAN"
			centered_row "$SETUP_MANUAL_URL" "$WHITE"
			centered_row ''
		fi
		centered_row "$completion_status" "$MAGENTA"
		centered_row 'SHELL CONTROL RETURNED' "$MUTED"
	else
		centered_row 'SETUP COMPLETE' "$GREEN"
		centered_row '15 / 15 OPERATIONS SEALED' "$WHITE"
		divider
		if ((ui_width >= 24)); then
			row "NEXT :: \$ $next_command" "$GREEN"
			if $has_degraded; then
				row 'OPTIONAL WATCH :: mise run presence:watch' "$AMBER"
				row 'LONG-RUNNING // CTRL-C TO STOP' "$MUTED"
			fi
		else
			if $has_degraded; then
				if [[ $next_command == 'mise run setup-ar' ]]; then
					row 'NEXT COMMAND' "$CYAN"
					row '$ mise run' "$GREEN"
					row 'setup-ar' "$GREEN"
					row 'OPTIONAL WATCH' "$AMBER"
					row '$ mise run' "$AMBER"
					row 'presence:watch' "$AMBER"
					row 'CTRL-C TO STOP' "$MUTED"
					border '╰' '─' '╯'
					return
				fi
				row 'NEXT :: git ar' "$GREEN"
				row 'OPTIONAL WATCH' "$AMBER"
				row '$ mise run' "$AMBER"
				row 'presence:watch' "$AMBER"
				row 'CTRL-C TO STOP' "$MUTED"
			else
				row 'NEXT COMMAND' "$CYAN"
				case "$next_command" in
				'mise run setup-ar')
					row '$ mise run' "$GREEN"
					row 'setup-ar' "$GREEN"
					;;
				*) row "\$ $next_command" "$GREEN" ;;
				esac
			fi
		fi
		row 'GUIDE :: NOTION' "$CYAN"
		centered_row "$completion_status" "$MAGENTA"
	fi
	border '╰' '─' '╯'
}

render_failure_content() {
	local operation_number=$((operation_cursor + 1))
	if ((operation_number > OPERATION_COUNT)); then operation_number=$OPERATION_COUNT; fi
	component_top_border "SETUP HALTED // OPERATION $(printf '%02d' "$operation_number") OF $(printf '%02d' "$OPERATION_COUNT")"
	if ((viewport_height >= 24)); then
		centered_row '        \   FAULT   /        ' "$RED"
		centered_row '     [X] CORE LOCKED [X]     ' "$RED"
		centered_row '        /   EXIT    \       ' "$RED"
		divider
		row "FAILED OPERATION :: $failure_title" "$RED"
		row "COMMAND          :: $failure_command" "$WHITE"
		row "EXIT CODE        :: $failure_exit" "$RED"
		row 'STATUS           :: REQUIRED COMPONENT UNAVAILABLE' "$AMBER"
		row 'REDACTED SUPPORT LOG' "$CYAN"
		row "LOG             :: $failure_log_display" "$WHITE"
		if ((ui_width >= 66)); then
			row "$FAILURE_GUIDANCE_JA" "$AMBER"
		else
			row 'RUN SHOW OR COPY; SHARE THE REDACTED RESULT WITH AI' "$AMBER"
		fi
		row 'SHOW            :: mise run setup-log:show' "$GREEN"
		row "COPY            :: $failure_log_copy_command" "$GREEN"
		row 'SAFETY          :: RAW OUTPUT DISCARDED // REVIEW BEFORE SHARING' "$MUTED"
		row 'NEXT COMMAND' "$CYAN"
		row '$ mise run setup-ar' "$AMBER"
		row 'GUIDE :: NOTION' "$CYAN"
		row "$failure_manual_url" "$WHITE"
		divider
		centered_row 'SUCCESS STATE NOT EMITTED // SHELL CONTROL RETURNED' "$MUTED"
	elif ((viewport_height >= 18)); then
		centered_row '[X] SETUP HALTED // FAULT LATCHED [X]' "$RED"
		divider
		row "FAILED :: $failure_title" "$RED"
		row "EXIT   :: $failure_exit // $failure_command" "$WHITE"
		row 'REDACTED SUPPORT LOG' "$CYAN"
		row "LOG    :: $failure_log_display" "$WHITE"
		if ((ui_width >= 66)); then
			row "$FAILURE_GUIDANCE_JA" "$AMBER"
		else
			row 'RUN SHOW OR COPY; SHARE THE REDACTED RESULT WITH AI' "$AMBER"
		fi
		row 'SHOW   :: mise run setup-log:show' "$GREEN"
		row "COPY   :: $failure_log_copy_command" "$GREEN"
		row 'SAFE   :: RAW OUTPUT DISCARDED // REVIEW BEFORE SHARING' "$MUTED"
		row 'NEXT   :: mise run setup-ar' "$AMBER"
		row "GUIDE  :: $failure_manual_url" "$CYAN"
		centered_row 'SUCCESS STATE NOT EMITTED // SHELL CONTROL RETURNED' "$MUTED"
	else
		centered_row 'REDACTED LOG READY' "$CYAN"
		row "OP :: $failure_title" "$RED"
		row "EXIT :: $failure_exit" "$RED"
		row 'SHOW :: mise run' "$WHITE"
		row 'setup-log:show' "$WHITE"
		row 'COPY :: mise run' "$GREEN"
		row 'setup-log:copy' "$GREEN"
		row 'RAW OUTPUT DISCARDED' "$MUTED"
		row 'NEXT :: mise run' "$AMBER"
		row 'setup-ar' "$AMBER"
	fi
	border '╰' '─' '╯'
}

present_tui_frame() {
	local frame=$1
	local placement=${2:-centered}
	local line
	local line_count=0
	local row
	local column
	while IFS= read -r line; do
		line_count=$((line_count + 1))
	done <<<"$frame"
	if [[ $placement == fullscreen ]]; then
		row=1
		column=1
	else
		row=$(((screen_height - line_count) / 2 + 1))
		column=$(((screen_width - ui_width) / 2 + 1))
	fi
	if ((row < 1)); then
		row=1
	fi
	if ((column < 1)); then
		column=1
	fi
	# A real TUI paint pass: discard the previous frame and redraw at absolute
	# coordinates. No saved-cursor assumptions and no append-only animation.
	printf '\033[2J\033[H'
	while IFS= read -r line; do
		printf '\033[%d;%dH%s\033[K' "$row" "$column" "$line"
		row=$((row + 1))
	done <<<"$frame"
}

persist_rendered_frame() {
	local frame=$1
	local line
	local line_count=0
	local first_row
	local cursor_row
	present_tui_frame "$frame"
	while IFS= read -r line; do
		line_count=$((line_count + 1))
	done <<<"$frame"
	first_row=$(((screen_height - line_count) / 2 + 1))
	if ((first_row < 1)); then first_row=1; fi
	cursor_row=$((first_row + line_count))
	if ((cursor_row > screen_height)); then cursor_row=$screen_height; fi
	printf '\033[%d;1H\033[K\033[?25h' "$cursor_row"
}

persist_tui_snapshot() {
	local number=$1
	local title=$2
	local detail=$3
	local frame
	refresh_terminal_dimensions
	persistent_frame=true
	frame=$(render_tui_content "$number" "$title" "$detail")
	persistent_frame=false
	persist_rendered_frame "$frame"
}

persist_completion_snapshot() {
	local frame
	refresh_terminal_dimensions
	frame=$(render_completion_content)
	persist_rendered_frame "$frame"
}

persist_failure_snapshot() {
	local frame
	refresh_terminal_dimensions
	frame=$(render_failure_content)
	persist_rendered_frame "$frame"
}

draw_tui_stage() {
	local number=$1
	local title=$2
	local detail=$3
	local frame
	refresh_terminal_dimensions
	frame=$(render_tui_content "$number" "$title" "$detail")
	present_tui_frame "$frame"
}

draw_completion_screen() {
	local frame
	refresh_terminal_dimensions
	frame=$(render_completion_content)
	present_tui_frame "$frame"
}

draw_failure_screen() {
	local frame
	refresh_terminal_dimensions
	frame=$(render_failure_content)
	present_tui_frame "$frame"
}

show_completion_screen() {
	local frames=1
	local frame
	if $motion_enabled; then frames=8; fi
	for ((frame = 0; frame < frames; frame++)); do
		tui_tick=$((tui_tick + 1))
		draw_completion_screen
		if $motion_enabled; then sleep 0.08; fi
	done
}

restore_tui_screen() {
	if $tui_active; then
		printf '\033[?25h\033[?1049l'
		tui_active=false
	fi
}

abort_tui() {
	if [[ -n ${tui_child_pid:-} ]] && kill -0 "$tui_child_pid" 2>/dev/null; then
		kill "$tui_child_pid" 2>/dev/null || true
		wait "$tui_child_pid" 2>/dev/null || true
	fi
	restore_tui_screen
	exit 130
}

enter_tui() {
	tui_active=true
	printf '\033[?1049h\033[?25l\033[2J\033[H'
	trap 'restore_tui_screen' EXIT
	trap 'abort_tui' INT TERM HUP
}

leave_tui() {
	restore_tui_screen
	trap - EXIT INT TERM HUP
}

stage_event_list() {
	local number=$1
	case "$number" in
	1) printf '%s' 'MISE.LOCK RESOLVED|RUST TOOLCHAIN AUTHENTICATED|UV + PYTHON READY|BUN RUNTIME READY|TOOL CHECKSUMS VERIFIED' ;;
	2) printf '%s' 'GIT-AR BUILD INSTALLED|CLI ENTRYPOINT AUTHENTICATED' ;;
	3) printf '%s' 'GIT HOOK AUTHENTICATED|CLAUDE INTEGRATION AUTHENTICATED|CODEX INTEGRATION AUTHENTICATED' ;;
	4) printf '%s' 'PRESENCE HEARTBEAT REGISTERED|BACKGROUND SCHEDULER AUTHENTICATED' ;;
	5) printf '%s' 'FORMAT + LINT PASSED|TEST + CLIPPY PASSED|SECURITY + READINESS AUTHENTICATED' ;;
	esac
}

show_tui_success_events() {
	local number=$1
	local title=$2
	local detail=$3
	local event_list
	local event
	local -a events
	event_list=$(stage_event_list "$number")
	IFS='|' read -r -a events <<<"$event_list"
	for event in "${events[@]}"; do
		if ((operation_cursor < OPERATION_COUNT)); then
			operation_cursor=$((operation_cursor + 1))
		fi
		tui_event="[AUTH] $event // TRUST $((95 + (${#event} + number) % 5))%"
		draw_tui_stage "$number" "$title" "$detail"
		if $motion_enabled; then
			sleep 0.16
		fi
	done
}

calibrate_tui_stage() {
	local number=$1
	local title=$2
	local detail=$3
	local frames=1
	local frame
	local scrambled
	if $motion_enabled; then
		frames=7
	fi
	for ((frame = 0; frame < frames; frame++)); do
		scrambled=$(scramble_line "AUTH CHANNEL $(printf '%02d' "$number")" "$((frame + 4))" "$number")
		tui_event="${MINI_DOT_FRAMES[$((frame % ${#MINI_DOT_FRAMES[@]}))]} DECRYPT // $scrambled // ${POINTS_FRAMES[$((frame % ${#POINTS_FRAMES[@]}))]} AURA ${METER_FRAMES[$((frame % ${#METER_FRAMES[@]}))]}"
		tui_tick=$((tui_tick + 1))
		draw_tui_stage "$number" "$title" "$detail"
		if $motion_enabled; then
			sleep 0.08
		fi
	done
}

animate_logo_formation() {
	local frame
	if ! $motion_enabled || ((screen_width < 38 || screen_height < 18)); then
		return
	fi
	for ((frame = 0; frame <= FORMATION_FINAL_FRAME; frame++)); do
		tui_tick=$((tui_tick + 1))
		if ((screen_width < 38 || screen_height < 18)); then
			return
		fi
		render_logo_formation_content "$frame"
		sleep 0.012
	done
	sleep 0.32
}

set_simulated_failure() {
	local number=$1
	local operation_index=$operation_cursor
	local preview_log
	if ((operation_index >= OPERATION_COUNT)); then operation_index=$((OPERATION_COUNT - 1)); fi
	step_states[number - 1]='ABORTED'
	setup_failed=true
	failure_exit=78
	failure_title="${OPERATION_NAMES[$operation_index]} // ${STEP_TITLES[$((number - 1))]}"
	failure_command=${OPERATION_COMMANDS[$operation_index]}
	failure_manual_url=$(manual_url_for_step "$number")
	tui_event="[SIMULATED FAILURE] ${OPERATION_NAMES[$operation_index]} // EXIT $failure_exit"
	preview_log=$(mktemp "${TMPDIR:-/tmp}/arttra-setup-preview.XXXXXX")
	printf '%s\n' \
		"simulated failure: ${OPERATION_NAMES[$operation_index]}" \
		'GITHUB_TOKEN=preview-token-is-never-persisted' \
		'No installation changes were made.' >"$preview_log"
	create_failure_report "$number" "$failure_title" "$failure_command" "$failure_exit" "$preview_log" || true
	rm -f -- "$preview_log"
}

set_simulated_presence_fallback() {
	step_states[3]='DEGRADED'
	has_degraded=true
	operation_cursor=${STAGE_OPERATION_ENDS[3]}
	tui_event='[SIMULATED MANUAL MODE] PRESENCE WATCHER IS OPTIONAL'
}

render_preview_tui() {
	local index
	enter_tui
	animate_logo_formation
	for index in 0 1 2 3 4; do
		step_states[index]='ACTIVE'
		calibrate_tui_stage "$((index + 1))" "${STEP_TITLES[$index]}" "${STEP_DETAILS[$index]}"
		if ((failure_stage == index + 1)); then
			if ((failure_stage == 4)); then
				set_simulated_presence_fallback
				draw_tui_stage 4 "${STEP_TITLES[$index]}" 'OPTIONAL SCHEDULER UNAVAILABLE // MANUAL WATCH AVAILABLE'
				if $motion_enabled; then sleep 0.35; fi
				continue
			fi
			set_simulated_failure "$((index + 1))"
			draw_tui_stage "$((index + 1))" "${STEP_TITLES[$index]}" "${STEP_DETAILS[$index]}"
			if $motion_enabled; then sleep 0.3; fi
			draw_failure_screen
			if $motion_enabled; then sleep 0.8; else sleep 0.2; fi
			leave_tui
			persist_failure_snapshot
			print_failure_support_details
			return
		fi
		show_tui_success_events "$((index + 1))" "${STEP_TITLES[$index]}" "${STEP_DETAILS[$index]}"
		step_states[index]='ONLINE'
	done
	tui_event='[AUTH] ALL REQUIRED SYSTEMS AUTHENTICATED // TRUST 100%'
	draw_tui_stage 5 'SETUP COMPLETE' 'NO MUTATIONS // DEMO PAYLOAD DISCARDED'
	if $motion_enabled; then sleep 0.3; fi
	show_completion_screen
	if $motion_enabled; then sleep 0.35; else sleep 0.15; fi
	leave_tui
	persist_completion_snapshot
}

run_tui_command() {
	local number=$1
	local title=$2
	local detail=$3
	local optional=$4
	shift 4
	local log_file
	local status
	local signal
	log_file=$(mktemp "${TMPDIR:-/tmp}/arttra-setup.XXXXXX")
	step_states[number - 1]='ACTIVE'
	calibrate_tui_stage "$number" "$title" "$detail"
	"$@" >"$log_file" 2>&1 &
	tui_child_pid=$!
	while kill -0 "$tui_child_pid" 2>/dev/null; do
		signal=$((91 + (tui_tick * 13 + number * 7) % 9))
		tui_event="${MINI_DOT_FRAMES[$((tui_tick % ${#MINI_DOT_FRAMES[@]}))]} EXECUTING // $title // ${POINTS_FRAMES[$((tui_tick % ${#POINTS_FRAMES[@]}))]} SIGNAL ${signal}%"
		tui_tick=$((tui_tick + 1))
		draw_tui_stage "$number" "$title" "$detail"
		sleep 0.09
	done
	if wait "$tui_child_pid"; then
		status=0
	else
		status=$?
	fi
	tui_child_pid=''
	if ((status == 0)); then
		show_tui_success_events "$number" "$title" "$detail"
		step_states[number - 1]='ONLINE'
		rm -f -- "$log_file"
		return 0
	fi
	if [[ $optional == optional ]]; then
		step_states[number - 1]='DEGRADED'
		has_degraded=true
		operation_cursor=$((operation_cursor + 2))
		if ((operation_cursor > OPERATION_COUNT)); then operation_cursor=$OPERATION_COUNT; fi
		tui_event='[MANUAL] PRESENCE SCHEDULER // FALLBACK MODE'
		draw_tui_stage "$number" "$title" "$detail"
		tui_optional_log=$log_file
		return 0
	fi
	step_states[number - 1]='ABORTED'
	setup_failed=true
	failure_exit=$status
	failure_title=$title
	failure_command=$(shell_command_for_display "$@")
	failure_manual_url=$(manual_url_for_failure "$number" "$log_file")
	create_failure_report "$number" "$failure_title" "$failure_command" "$failure_exit" "$log_file" || true
	rm -f -- "$log_file"
	tui_event="[ABORTED] $title // EXIT $status"
	draw_tui_stage "$number" "$title" "$detail"
	if $motion_enabled; then sleep 0.25; fi
	draw_failure_screen
	if $motion_enabled; then sleep 0.55; else sleep 0.15; fi
	leave_tui
	persist_failure_snapshot
	print_failure_support_details
	return "$status"
}

run_setup_tui() {
	tui_optional_log=''
	enter_tui
	animate_logo_formation
	run_tui_command 1 'TOOLCHAIN' 'SYNC LOCKED RUNTIMES + TOOLS' required mise install || return 1
	run_tui_command 2 'GIT-AR' 'COMPILE + INSTALL WORKFLOW ENGINE' required \
		cargo install --path . --locked --force || return 1
	run_tui_command 3 'INTEGRATIONS' 'ARM GIT + CLAUDE + CODEX HOOKS' required git ar setup || return 1
	run_tui_command 4 'PRESENCE' 'REGISTER BACKGROUND HEARTBEAT' optional \
		git ar presence install --yes
	run_tui_command 5 'DIAGNOSTICS' 'RUN FINAL SYSTEM CHECKS' required mise run ready || return 1
	if $has_degraded; then
		tui_event='[MANUAL] REQUIRED SYSTEMS READY // PRESENCE FALLBACK ACTIVE // TRUST 100%'
	else
		tui_event='[AUTH] ALL REQUIRED SYSTEMS AUTHENTICATED // TRUST 100%'
	fi
	draw_tui_stage 5 'SETUP COMPLETE' 'TOOLCHAIN LOCKED // WORKSPACE READY'
	if $motion_enabled; then sleep 0.3; fi
	show_completion_screen
	if $motion_enabled; then sleep 0.35; else sleep 0.15; fi
	leave_tui
	if [[ -n $tui_optional_log ]]; then
		printf '%s\n' 'presence schedulerは手動モードです。詳細:' >&2
		sanitize_failure_stream <"$tui_optional_log" | tail -n 24 >&2
		rm -f -- "$tui_optional_log"
	fi
	persist_completion_snapshot
}

run_step() {
	local number=$1
	local title=$2
	local detail=$3
	shift 3
	local started=$SECONDS
	local status
	local failed_command
	local log_file
	log_file=$(mktemp "${TMPDIR:-/tmp}/arttra-setup.XXXXXX")
	step_states[number - 1]='ACTIVE'
	render_stage_dashboard "$number" "$title" "$detail"
	animate_calibration "$title"
	"$@" 2>&1 | tee "$log_file"
	status=${PIPESTATUS[0]}
	if ((status == 0)); then
		rm -f -- "$log_file"
		step_states[number - 1]='ONLINE'
		render_authentication_events "$number"
		render_status 'ONLINE' "$title" "$((SECONDS - started))"
		return 0
	fi
	step_states[number - 1]='ABORTED'
	render_status 'ABORTED' "$title" "$((SECONDS - started))"
	failed_command=$(shell_command_for_display "$@")
	setup_failed=true
	failure_exit=$status
	failure_title=$title
	failure_command=$failed_command
	failure_manual_url=$(manual_url_for_failure "$number" "$log_file")
	create_failure_report "$number" "$failure_title" "$failure_command" "$failure_exit" "$log_file" || true
	rm -f -- "$log_file"
	tui_event="[ABORTED] $title // EXIT $status"
	render_failure_content
	print_failure_support_details
	return "$status"
}

run_optional_step() {
	local number=$1
	local title=$2
	local detail=$3
	shift 3
	local started=$SECONDS
	local status
	step_states[number - 1]='ACTIVE'
	render_stage_dashboard "$number" "$title" "$detail"
	animate_calibration "$title"
	"$@"
	status=$?
	if ((status == 0)); then
		step_states[number - 1]='ONLINE'
		render_authentication_events "$number"
		render_status 'ONLINE' "$title" "$((SECONDS - started))"
		return 0
	fi
	step_states[number - 1]='DEGRADED'
	has_degraded=true
	render_degraded_event
	render_status 'DEGRADED' "$title" "$((SECONDS - started))"
	printf '%s\n' 'presenceのOS定期共有を導入できませんでした。表示された代替コマンドを利用してください。' >&2
	paint "$AMBER" '  OPTIONAL WATCH :: mise run presence:watch'
	printf '\n'
	paint "$MUTED" '  LONG-RUNNING // RUN IN ANOTHER TERMINAL // CTRL-C TO STOP'
	printf '\n'
	paint "$CYAN" "  GUIDE  :: $SETUP_MANUAL_URL"
	printf '\n'
	return 0
}

render_complete() {
	refresh_terminal_width
	render_completion_content
}

render_preview() {
	local index
	render_intro
	for index in 0 1 2 3 4; do
		step_states[index]='ACTIVE'
		render_stage_dashboard "$((index + 1))" "${STEP_TITLES[$index]}" "${STEP_DETAILS[$index]}"
		animate_calibration "${STEP_TITLES[$index]}"
		if ((failure_stage == index + 1)); then
			if ((failure_stage == 4)); then
				set_simulated_presence_fallback
				render_degraded_event
				continue
			fi
			set_simulated_failure "$((index + 1))"
			render_failure_content
			print_failure_support_details
			return
		fi
		step_states[index]='ONLINE'
		operation_cursor=${STAGE_OPERATION_ENDS[$index]}
		render_authentication_events "$((index + 1))"
		render_status 'ONLINE' "${STEP_TITLES[$index]}" "$((index + 1))"
	done
	render_complete
}

if $copy_latest_log; then
	copy_latest_failure_log
	exit $?
fi

if $show_latest_log; then
	show_latest_failure_log
	exit $?
fi

if $preview && $tui_enabled; then
	render_preview_tui
	exit 0
fi

if ! $preview && $tui_enabled; then
	run_setup_tui
	exit $?
fi

if $preview; then
	render_preview
	exit 0
fi

render_intro
run_step 1 'TOOLCHAIN' 'SYNC LOCKED RUNTIMES + TOOLS' mise install || exit 1
run_step 2 'GIT-AR' 'COMPILE + INSTALL WORKFLOW ENGINE' \
	cargo install --path . --locked --force || exit 1
run_step 3 'INTEGRATIONS' 'ARM GIT + CLAUDE + CODEX HOOKS' git ar setup || exit 1
run_optional_step 4 'PRESENCE' 'REGISTER BACKGROUND HEARTBEAT' \
	git ar presence install --yes
run_step 5 'DIAGNOSTICS' 'RUN FINAL SYSTEM CHECKS' mise run ready || exit 1
render_complete
