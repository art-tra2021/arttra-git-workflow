#!/usr/bin/env bash
set -euo pipefail

ar_test_root="$(mktemp -d)"
trap 'rm -rf "${ar_test_root}"' EXIT
mkdir -p "${ar_test_root}/bin"

cat >"${ar_test_root}/bin/gcloud" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${FAKE_GCLOUD_LOG}"

for ar_argument in "$@"; do
  if [[ "${ar_argument}" == --metadata-from-file ]]; then
    ar_capture=true
    continue
  fi
  if [[ "${ar_capture:-false}" == true ]]; then
    IFS=',' read -ra ar_pairs <<<"${ar_argument}"
    for ar_pair in "${ar_pairs[@]}"; do
      cp "${ar_pair#*=}" "${FAKE_METADATA_DIR}/${ar_pair%%=*}"
    done
    ar_capture=false
  fi
done

if [[ "$1 $2 $3" == "run services describe" ]]; then
  jq -cn --arg image "${FAKE_SERVICE_IMAGE}" '{
    spec: {template: {spec: {containers: [{
      image: $image,
      env: [
        {name: "AR_SLACK_TRANSPORT", value: "http"},
        {name: "AR_STATE_BACKEND", value: "firestore"},
        {name: "PORT", value: "8080"},
        {name: "AR_GITHUB_CAPABILITY_GRANTS_JSON", value: "{\"octocat\":[\"x\"]}"},
        {name: "SLACK_BOT_TOKEN", valueFrom: {secretKeyRef: {name: "bot-token", key: "latest"}}},
        {name: "SLACK_SIGNING_SECRET", valueFrom: {secretKeyRef: {name: "signing", key: "latest"}}},
        {name: "GITHUB_APP_PRIVATE_KEY", valueFrom: {secretKeyRef: {name: "private-key", key: "latest"}}}
      ]
    }]}}}
  }'
elif [[ "$1 $2 $3" == "compute instances list" ]]; then
  if [[ "${FAKE_VM_STATUS:-}" == "" ]]; then
    printf '[]\n'
  else
    jq -cn --arg status "${FAKE_VM_STATUS}" \
      '[{id: "123", name: "arttra-work-slack-socket", status: $status,
         metadata: {items: [{key: "arttra-slack-image", value: "old-image"}]}}]'
  fi
elif [[ "$1 $2 $3" == "secrets versions list" ]]; then
  if [[ "${FAKE_APP_TOKEN_READY:-false}" == true ]]; then
    printf '[{"name":"1","state":"ENABLED"}]\n'
  else
    printf '[]\n'
  fi
elif [[ "$1 $2" == "logging read" ]]; then
  if [[ "${FAKE_SOCKET_LOG:-false}" == disabled ]]; then
    printf '%s\n' '[{"timestamp":"2026-11-14T00:00:00.300Z","jsonPayload":{"message":"⚡ Slack adapter Socket Modeを起動しました: x"}},{"timestamp":"2026-11-14T00:00:00.100Z","jsonPayload":{"message":"[WARN]  bolt-app Socket Mode is not turned on."}}]'
  elif [[ "${FAKE_SOCKET_LOG:-false}" == true ]]; then
    printf '%s\n' '[{"timestamp":"2026-11-14T00:05:00.300Z","jsonPayload":{"message":"⚡ Slack adapter Socket Modeを起動しました: x"}},{"timestamp":"2026-11-14T00:00:00.100Z","jsonPayload":{"message":"[WARN]  bolt-app Socket Mode is not turned on."}}]'
  else
    printf '[]\n'
  fi
elif [[ "$1 $2" == "compute instances" ]]; then
  :
else
  printf 'unexpected gcloud call: %s\n' "$*" >&2
  exit 1
fi
EOF
chmod +x "${ar_test_root}/bin/gcloud"

export PATH="${ar_test_root}/bin:${PATH}"
export FAKE_GCLOUD_LOG="${ar_test_root}/gcloud.log"
export FAKE_METADATA_DIR="${ar_test_root}/metadata"
mkdir -p "${FAKE_METADATA_DIR}"
ar_repository="asia-northeast1-docker.pkg.dev/bmarumado/arttra-work/slack-adapter"
ar_digest="sha256:1111111111111111111111111111111111111111111111111111111111111111"
ar_rollback_digest="sha256:2222222222222222222222222222222222222222222222222222222222222222"
export FAKE_SERVICE_IMAGE="${ar_repository}@${ar_digest}"

# previewは秘密の値を読まず、socket用の設定だけを示す。
: >"${FAKE_GCLOUD_LOG}"
ar_preview="$(bash scripts/slack-socket-vm.sh preview)"
jq -e \
	--arg image "${FAKE_SERVICE_IMAGE}" \
	'.action == "preview"
    and .mutationAllowed == false
    and .operation == "create"
    and .target.image == $image
    and (.target.envNames | index("PORT")) == null
    and (.target.envNames | index("AR_SLACK_TRANSPORT")) != null
    and .target.secrets.SLACK_BOT_TOKEN == "bot-token"
    and .target.secrets.SLACK_APP_TOKEN == "arttra-work-slack-app-token"
    and (.target.secrets | has("SLACK_SIGNING_SECRET")) == false
    and .appToken.ready == false
    and has("config") == false' \
	<<<"${ar_preview}" >/dev/null
if grep -Eq 'secrets versions access' "${FAKE_GCLOUD_LOG}"; then
	printf 'preview must not read secret values\n' >&2
	exit 1
fi

# --yesがなければ変更しない。
: >"${FAKE_GCLOUD_LOG}"
if bash scripts/slack-socket-vm.sh deploy >/dev/null 2>&1; then
	printf 'deploy without --yes must fail\n' >&2
	exit 1
fi
if grep -Eq '^compute instances (create|add-metadata|reset|start)' "${FAKE_GCLOUD_LOG}"; then
	printf 'deploy without --yes must not mutate\n' >&2
	exit 1
fi

# app-level tokenが未登録なら作成しない。
: >"${FAKE_GCLOUD_LOG}"
if bash scripts/slack-socket-vm.sh deploy --yes >/dev/null 2>&1; then
	printf 'deploy without app token must fail\n' >&2
	exit 1
fi
if grep -Eq '^compute instances create' "${FAKE_GCLOUD_LOG}"; then
	printf 'deploy without app token must not create the VM\n' >&2
	exit 1
fi

# VMがなければ作成し、transportをsocketへ置き換えたmetadataを渡す。
export FAKE_APP_TOKEN_READY=true
: >"${FAKE_GCLOUD_LOG}"
ar_deploy="$(bash scripts/slack-socket-vm.sh deploy --yes | tail -n 1)"
jq -e '.action == "deploy" and .operation == "create"' <<<"${ar_deploy}" >/dev/null
grep -Eq '^compute instances create arttra-work-slack-socket .*--machine-type e2-micro' "${FAKE_GCLOUD_LOG}"
grep -Eq -- "--metadata arttra-slack-image=${ar_repository}@${ar_digest}" "${FAKE_GCLOUD_LOG}"
grep -Fqx 'AR_SLACK_TRANSPORT=socket' "${FAKE_METADATA_DIR}/arttra-slack-env"
grep -Fqx 'AR_STATE_BACKEND=firestore' "${FAKE_METADATA_DIR}/arttra-slack-env"
grep -Fqx 'AR_GITHUB_CAPABILITY_GRANTS_JSON={"octocat":["x"]}' "${FAKE_METADATA_DIR}/arttra-slack-env"
if grep -Eq '^(PORT|AR_SLACK_TRANSPORT=http)' "${FAKE_METADATA_DIR}/arttra-slack-env"; then
	printf 'socket env must drop PORT and the http transport\n' >&2
	exit 1
fi
grep -Fqx 'SLACK_APP_TOKEN=arttra-work-slack-app-token' "${FAKE_METADATA_DIR}/arttra-slack-secrets"
grep -Fqx 'GITHUB_APP_PRIVATE_KEY=private-key' "${FAKE_METADATA_DIR}/arttra-slack-secrets"
if grep -q 'SLACK_SIGNING_SECRET' "${FAKE_METADATA_DIR}/arttra-slack-secrets"; then
	printf 'socket secrets must not include the signing secret\n' >&2
	exit 1
fi
cmp -s apps/slack-adapter/deploy/socket-vm/cloud-init.yaml "${FAKE_METADATA_DIR}/user-data"

# 既存VMはmetadataを更新してresetし、--imageで戻し先を指定できる。
export FAKE_VM_STATUS=RUNNING
: >"${FAKE_GCLOUD_LOG}"
ar_update="$(bash scripts/slack-socket-vm.sh deploy --image "${ar_repository}@${ar_rollback_digest}" --yes | tail -n 1)"
jq -e --arg image "${ar_repository}@${ar_rollback_digest}" \
	'.operation == "update-and-reset" and .image == $image' <<<"${ar_update}" >/dev/null
grep -Eq '^compute instances add-metadata arttra-work-slack-socket ' "${FAKE_GCLOUD_LOG}"
grep -Eq '^compute instances reset arttra-work-slack-socket ' "${FAKE_GCLOUD_LOG}"
if grep -Eq '^compute instances create' "${FAKE_GCLOUD_LOG}"; then
	printf 'existing VM must not be recreated\n' >&2
	exit 1
fi

# 停止中のVMはresetではなくstartする。
export FAKE_VM_STATUS=TERMINATED
: >"${FAKE_GCLOUD_LOG}"
bash scripts/slack-socket-vm.sh deploy --yes >/dev/null
grep -Eq '^compute instances start arttra-work-slack-socket ' "${FAKE_GCLOUD_LOG}"

# 別repositoryやtag指定のimageは受け付けない。
if bash scripts/slack-socket-vm.sh preview --image "${ar_repository}:latest" >/dev/null 2>&1; then
	printf 'tag image must be rejected\n' >&2
	exit 1
fi

# statusはSocket Modeの起動ログがあるRUNNINGのVMだけを健全とする。
export FAKE_VM_STATUS=RUNNING
set +e
bash scripts/slack-socket-vm.sh status >/dev/null
ar_unhealthy=$?
set -e
[[ ${ar_unhealthy} -eq 2 ]]
# Slack側でSocket Modeが無効のまま起動した場合は健全としない。
export FAKE_SOCKET_LOG=disabled
set +e
ar_disabled="$(bash scripts/slack-socket-vm.sh status)"
ar_disabled_status=$?
set -e
[[ ${ar_disabled_status} -eq 2 ]]
jq -e '.healthy == false and .slackSocketModeDisabled == true' <<<"${ar_disabled}" >/dev/null
# 有効化後に起動し直した場合は、以前の警告があっても健全とする。
export FAKE_SOCKET_LOG=true
ar_status="$(bash scripts/slack-socket-vm.sh status)"
jq -e '.healthy == true
    and .slackSocketModeDisabled == false
    and .lastSocketModeStart == "2026-11-14T00:05:00.300Z"' <<<"${ar_status}" >/dev/null

# stopも--yesを要求する。
if bash scripts/slack-socket-vm.sh stop >/dev/null 2>&1; then
	printf 'stop without --yes must fail\n' >&2
	exit 1
fi

printf 'slack-socket-vm tests passed\n'
