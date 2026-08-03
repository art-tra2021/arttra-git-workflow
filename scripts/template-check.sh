#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail() {
	echo "template検証エラー: $*" >&2
	exit 1
}

command -v jq >/dev/null 2>&1 || fail "jqが必要です。mise installを実行してください"

registry="$root/governance/template-registry.json"
lock="$root/templates/repository/base/template.lock.json"
wrapper_schema="$root/governance/template-wrapper.schema.json"
registry_schema="$root/governance/template-registry.schema.json"
lock_schema="$root/governance/template-lock.schema.json"

for json_file in "$registry" "$lock" "$wrapper_schema" "$registry_schema" "$lock_schema"; do
	display_path="${json_file#"$root"/}"
	jq empty "$json_file" || fail "JSONを読み込めません: $display_path"
done

jq -e '
  .schema_version == 1 and
  .base.id == "arttra-repository-base" and
  .base.path == "templates/repository/base" and
  ([.repository_profiles[].profile] | sort) == ["business", "minimal", "python", "typescript"] and
  .sync.mode == "pull-request" and
  (.sync.never_copy | index(".agents/")) != null and
  (.sync.never_copy | index(".codex/")) != null and
  (.sync.never_copy | index("CLAUDE.md")) != null
' "$registry" >/dev/null || fail "template registryのprofileまたは秘密除外規則が不正です"

for profile in minimal python typescript business; do
	wrapper="$root/templates/repository/wrappers/$profile/template.json"
	display_path="${wrapper#"$root"/}"
	[ -f "$wrapper" ] || fail "wrapperがありません: $display_path"
	jq -e --arg profile "$profile" '
    .schema_version == 1 and
    .profile == $profile and
    .base == "../../base" and
    (.managed_paths | index(".gitignore")) != null and
    (.post_create | index("setup_ar")) != null and
    (.post_create | index("ready")) != null
  ' "$wrapper" >/dev/null || fail "${profile} wrapperの基盤設定が不正です"
done

arttra="$root/templates/repository/base/arttra.toml"
for required_line in \
	'version = 1' \
	'[tasks]' \
	'[presence]' \
	'bypass_prefixes = ["dependabot/", "renovate/", "ar-presence/"]'; do
	grep -Fqx "$required_line" "$arttra" || fail "base/arttra.tomlに${required_line}がありません"
done

for path in \
	'.agents/' \
	'.claude/skills/arttra-git-workflow/' \
	'.claude/settings.local.json' \
	'.codex/' \
	'CLAUDE.md'; do
	grep -Fqx "$path" "$root/templates/repository/base/.templateignore" || fail ".templateignoreに${path}がありません"
	grep -Fqx "$path" "$root/templates/repository/base/.gitignore" || fail ".gitignoreに${path}がありません"
done

jq -e '
  (.managed_paths | index(".gitignore")) != null and
  (.local_paths | index(".agents")) != null and
  (.local_paths | index(".claude/skills/arttra-git-workflow")) != null and
  (.local_paths | index(".codex")) != null and
  (.local_paths | index("CLAUDE.md")) != null
' "$lock" >/dev/null || fail "template.lock.jsonのmanaged/local pathが不正です"

if find "$root/templates/repository" -type f \( \
	-path '*/.agents/*' -o \
	-path '*/.claude/*' -o \
	-path '*/.codex/*' -o \
	-name 'CLAUDE.md' \
	\) -print -quit | grep -q .; then
	fail "個人AI設定または生成済みskillをtemplateへ含めてはなりません"
fi

echo "✓ repository templateのregistry、profile、管理対象、秘密除外規則を検証しました"
