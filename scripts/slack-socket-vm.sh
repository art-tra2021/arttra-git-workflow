#!/usr/bin/env bash
set -euo pipefail

# Slack操作を受けるSocket Modeの常駐VMを、Cloud Runと同じimage・設定で配備する。
# GitHub webhookはCloud Runに残す。秘密の値はこのscriptでは読まない。
# VMだけに足す環境変数（定期処理のAR_SCHEDULERなど）は、vm-overrides.confと--envで渡す。

ar_project="bmarumado"
ar_run_region="asia-northeast1"
ar_service="arttra-work-slack"
ar_vm="arttra-work-slack-socket"
ar_zone="us-west1-b"
ar_machine_type="e2-micro"
ar_service_account="arttra-work-runtime@bmarumado.iam.gserviceaccount.com"
ar_app_token_secret="arttra-work-slack-app-token"
ar_image_repository="asia-northeast1-docker.pkg.dev/bmarumado/arttra-work/slack-adapter"
ar_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ar_cloud_init="${ar_script_dir}/../apps/slack-adapter/deploy/socket-vm/cloud-init.yaml"
ar_vm_env_file="${AR_SOCKET_VM_OVERRIDES_FILE:-${ar_script_dir}/../apps/slack-adapter/deploy/socket-vm/vm-overrides.conf}"
ar_image=""
ar_confirmed=false
ar_vm_env_flags=()
ar_vm_env_json="{}"

usage() {
	cat <<'EOF'
Usage:
  scripts/slack-socket-vm.sh preview [--image <repository@sha256:digest>] [--env NAME=VALUE]...
  scripts/slack-socket-vm.sh status
  scripts/slack-socket-vm.sh deploy [--image <repository@sha256:digest>] [--env NAME=VALUE]... --yes
  scripts/slack-socket-vm.sh stop --yes

preview and status print deterministic JSON without mutating resources.
deploy creates or updates the Socket Mode VM from the Cloud Run template.
Without --image, deploy uses the digest pinned in the Cloud Run template.
VM-only plain environment variables come from apps/slack-adapter/deploy/socket-vm/vm-overrides.conf,
then from --env, which overrides the file for this deploy only. They replace the same
names inherited from Cloud Run and are never applied to Cloud Run.
EOF
}

fail() {
	printf 'slack-socket-vm: %s\n' "$*" >&2
	exit 64
}

# VMだけに渡す非secretの環境変数を1件足す。transport、PORT、secretは上書きさせない。
add_vm_env() {
	local ar_entry="$1" ar_origin="$2" ar_name ar_value
	if [[ ! "${ar_entry}" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
		fail "${ar_origin}: VM env must be NAME=VALUE with an upper-case name"
	fi
	ar_name="${BASH_REMATCH[1]}"
	ar_value="${BASH_REMATCH[2]}"
	case "${ar_name}" in
	PORT | AR_SLACK_TRANSPORT | SLACK_APP_TOKEN | SLACK_SIGNING_SECRET)
		fail "${ar_origin}: ${ar_name} cannot be overridden for the VM"
		;;
	esac
	ar_vm_env_json="$(jq -c --arg name "${ar_name}" --arg value "${ar_value}" \
		'. + {($name): $value}' <<<"${ar_vm_env_json}")"
}

# vm-overrides.confを読み、その後に--envを重ねる。空行と#で始まる行は読み飛ばす。
load_vm_env() {
	local ar_line ar_entry
	if [[ -f "${ar_vm_env_file}" ]]; then
		while IFS= read -r ar_line || [[ -n "${ar_line}" ]]; do
			[[ "${ar_line}" =~ ^[[:space:]]*(#.*)?$ ]] && continue
			add_vm_env "${ar_line}" "vm-overrides.conf"
		done <"${ar_vm_env_file}"
	fi
	for ar_entry in "${ar_vm_env_flags[@]+"${ar_vm_env_flags[@]}"}"; do
		add_vm_env "${ar_entry}" "--env"
	done
}

validate_image() {
	local ar_value="$1"
	if [[ ! "${ar_value}" =~ ^${ar_image_repository}@sha256:[0-9a-f]{64}$ ]]; then
		fail "image must be ${ar_image_repository}@sha256:<64 lowercase hex>"
	fi
}

describe_service() {
	gcloud run services describe "${ar_service}" \
		--region "${ar_run_region}" \
		--project "${ar_project}" \
		--format=json
}

# Cloud Runのtemplateから、Socket Mode用の非secret環境変数とsecret参照を作る。
socket_config() {
	local ar_service_json="$1"
	jq -ec --arg appTokenSecret "${ar_app_token_secret}" --argjson vmEnv "${ar_vm_env_json}" '
    (.spec.template.spec.containers[0] // error("Cloud Run container is missing")) as $container
    | ($container.env // []) as $env
    | ([$env[] | select(.valueFrom.secretKeyRef != null) | .name]) as $secretNames
    | if ([$vmEnv | keys[] | select(. as $name | $secretNames | index($name))] | length) > 0 then
        error("VM env must not override secret references")
      else . end
    | {
        image: ($container.image // ""),
        env: (
          [ $env[]
            | select(has("valueFrom") | not)
            | select(.name != "PORT" and .name != "AR_SLACK_TRANSPORT")
            | select(.name as $name | $vmEnv | has($name) | not)
            | {name, value: (.value // "")} ]
          + ($vmEnv | to_entries | map({name: .key, value: .value}))
          + [{name: "AR_SLACK_TRANSPORT", value: "socket"}]
        ),
        vmEnv: $vmEnv,
        secrets: (
          [ $env[]
            | select(.valueFrom.secretKeyRef != null)
            | select(.name != "SLACK_SIGNING_SECRET")
            | {name, secret: .valueFrom.secretKeyRef.name, version: (.valueFrom.secretKeyRef.key // "latest")} ]
          + [{name: "SLACK_APP_TOKEN", secret: $appTokenSecret, version: "latest"}]
        )
      }
    | if ([.secrets[] | select(.version != "latest")] | length) > 0 then
        error("only latest secret versions are supported")
      elif ([.env[] | select(.value | test("\n"))] | length) > 0 then
        error("plain environment values must be single-line")
      else . end
  ' <<<"${ar_service_json}"
}

describe_vm() {
	gcloud compute instances list \
		--project "${ar_project}" \
		--zones "${ar_zone}" \
		--filter "name=(${ar_vm})" \
		--verbosity error \
		--format=json
}

app_token_ready() {
	local ar_versions
	if ! ar_versions="$(gcloud secrets versions list "${ar_app_token_secret}" \
		--project "${ar_project}" \
		--filter "state=ENABLED" \
		--limit 1 \
		--format=json 2>/dev/null)"; then
		printf 'false\n'
		return
	fi
	jq -r 'if length > 0 then "true" else "false" end' <<<"${ar_versions}"
}

plan_json() {
	local ar_service_json ar_config ar_vm_json ar_ready ar_target_image
	ar_service_json="$(describe_service)" || fail "Cloud Run service could not be described"
	ar_config="$(socket_config "${ar_service_json}")" || fail "Cloud Run template is not usable for Socket Mode"
	ar_target_image="${ar_image}"
	if [[ -z "${ar_target_image}" ]]; then
		ar_target_image="$(jq -r '.image' <<<"${ar_config}")"
	fi
	validate_image "${ar_target_image}"
	ar_vm_json="$(describe_vm)" || fail "Compute Engine instances could not be listed"
	ar_ready="$(app_token_ready)"
	jq -cn \
		--argjson config "${ar_config}" \
		--argjson vms "${ar_vm_json}" \
		--argjson appTokenReady "${ar_ready}" \
		--arg image "${ar_target_image}" \
		--arg name "${ar_vm}" \
		--arg zone "${ar_zone}" \
		--arg machineType "${ar_machine_type}" \
		--arg appTokenSecret "${ar_app_token_secret}" \
		'($vms[0] // null) as $vm
    | ($vm.metadata.items // [] | map({key, value}) | from_entries) as $metadata
    | {
        schemaVersion: 1,
        vm: {
          name: $name,
          zone: $zone,
          machineType: $machineType,
          exists: ($vm != null),
          status: ($vm.status // null),
          currentImage: ($metadata["arttra-slack-image"] // null)
        },
        target: {
          image: $image,
          envNames: [$config.env[].name] | sort,
          vmEnv: $config.vmEnv,
          secrets: ($config.secrets | map({key: .name, value: .secret}) | from_entries)
        },
        appToken: {secret: $appTokenSecret, ready: $appTokenReady},
        operation: (
          if $vm == null then "create"
          elif ($vm.status // "") == "TERMINATED" then "update-and-start"
          else "update-and-reset" end
        ),
        config: $config
      }'
}

public_plan() {
	jq -c 'del(.config)' <<<"$1"
}

preview_release() {
	local ar_plan
	ar_plan="$(plan_json)"
	public_plan "${ar_plan}" | jq -c '{action: "preview"} + . + {mutationAllowed: false}'
}

deploy_release() {
	local ar_plan ar_operation ar_target_image ar_work ar_metadata_files
	ar_plan="$(plan_json)"
	public_plan "${ar_plan}" | jq -c '{action: "preview"} + . + {mutationAllowed: false}'
	if [[ "${ar_confirmed}" != "true" ]]; then
		fail "deploy requires the explicit --yes flag after reviewing preview"
	fi
	if [[ "$(jq -r '.appToken.ready' <<<"${ar_plan}")" != "true" ]]; then
		fail "secret ${ar_app_token_secret} has no enabled version; add the Slack app-level token first"
	fi
	[[ -f "${ar_cloud_init}" ]] || fail "cloud-init file is missing: ${ar_cloud_init}"
	ar_operation="$(jq -r '.operation' <<<"${ar_plan}")"
	ar_target_image="$(jq -r '.target.image' <<<"${ar_plan}")"
	ar_work="$(mktemp -d)"
	# shellcheck disable=SC2064
	trap "rm -rf '${ar_work}'" EXIT
	jq -r '.config.env[] | "\(.name)=\(.value)"' <<<"${ar_plan}" >"${ar_work}/env"
	jq -r '.config.secrets[] | "\(.name)=\(.secret)"' <<<"${ar_plan}" >"${ar_work}/secrets"
	ar_metadata_files="user-data=${ar_cloud_init},arttra-slack-env=${ar_work}/env,arttra-slack-secrets=${ar_work}/secrets"

	case "${ar_operation}" in
	create)
		gcloud compute instances create "${ar_vm}" \
			--project "${ar_project}" \
			--zone "${ar_zone}" \
			--machine-type "${ar_machine_type}" \
			--image-family cos-stable \
			--image-project cos-cloud \
			--boot-disk-size 10GB \
			--boot-disk-type pd-standard \
			--shielded-secure-boot \
			--service-account "${ar_service_account}" \
			--scopes cloud-platform \
			--labels app=arttra-work-slack,role=socket-mode \
			--metadata "arttra-slack-image=${ar_target_image}" \
			--metadata-from-file "${ar_metadata_files}" \
			--quiet >/dev/null
		;;
	update-and-start | update-and-reset)
		gcloud compute instances add-metadata "${ar_vm}" \
			--project "${ar_project}" \
			--zone "${ar_zone}" \
			--metadata "arttra-slack-image=${ar_target_image}" \
			--metadata-from-file "${ar_metadata_files}" \
			--quiet >/dev/null
		if [[ "${ar_operation}" == "update-and-start" ]]; then
			gcloud compute instances start "${ar_vm}" --project "${ar_project}" --zone "${ar_zone}" --quiet >/dev/null
		else
			gcloud compute instances reset "${ar_vm}" --project "${ar_project}" --zone "${ar_zone}" --quiet >/dev/null
		fi
		;;
	*)
		fail "unknown operation: ${ar_operation}"
		;;
	esac
	jq -cn --arg operation "${ar_operation}" --arg image "${ar_target_image}" \
		'{action: "deploy", operation: $operation, image: $image, next: "scripts/slack-socket-vm.sh status"}'
}

stop_release() {
	if [[ "${ar_confirmed}" != "true" ]]; then
		fail "stop requires the explicit --yes flag"
	fi
	gcloud compute instances stop "${ar_vm}" --project "${ar_project}" --zone "${ar_zone}" --quiet >/dev/null
	jq -cn --arg name "${ar_vm}" '{action: "stop", vm: $name}'
}

status_release() {
	local ar_vm_json ar_logs ar_status
	ar_vm_json="$(describe_vm)" || fail "Compute Engine instances could not be listed"
	ar_logs="[]"
	if [[ "$(jq 'length' <<<"${ar_vm_json}")" -gt 0 ]]; then
		ar_logs="$(gcloud logging read \
			"resource.type=\"gce_instance\" AND resource.labels.instance_id=\"$(jq -r '.[0].id' <<<"${ar_vm_json}")\" AND (\"Socket Modeを起動しました\" OR \"Socket Mode is not turned on\")" \
			--project "${ar_project}" \
			--freshness 7d \
			--limit 10 \
			--format=json)" || fail "Cloud Logging could not be read"
	fi
	ar_status="$(jq -cn \
		--argjson vms "${ar_vm_json}" \
		--argjson logs "${ar_logs}" \
		--arg name "${ar_vm}" \
		'($vms[0] // null) as $vm
    | ($vm.metadata.items // [] | map({key, value}) | from_entries) as $metadata
    | def message: ((.jsonPayload.message // .textPayload // "") | tostring);
      def epoch: (.timestamp | sub("\\.[0-9]+"; "") | fromdateiso8601);
      ([$logs[] | select(message | contains("Socket Modeを起動しました"))] | sort_by(.timestamp) | last) as $start
    | ($start.timestamp // null) as $started
    | (if $start == null then false else
        [$logs[]
          | select(message | contains("Socket Mode is not turned on"))
          | select(epoch <= ($start | epoch) and epoch >= (($start | epoch) - 60))]
        | length > 0
      end) as $socketModeDisabled
    | {
        schemaVersion: 1,
        action: "status",
        vm: {
          name: $name,
          exists: ($vm != null),
          status: ($vm.status // null),
          image: ($metadata["arttra-slack-image"] // null)
        },
        lastSocketModeStart: $started,
        slackSocketModeDisabled: $socketModeDisabled,
        healthy: (($vm.status // "") == "RUNNING" and $started != null and ($socketModeDisabled | not))
      }')"
	printf '%s\n' "${ar_status}"
	[[ "$(jq -r '.healthy' <<<"${ar_status}")" == "true" ]] || exit 2
}

ar_action="${1:-}"
[[ -n "${ar_action}" ]] || {
	usage >&2
	exit 64
}
shift
while [[ $# -gt 0 ]]; do
	case "$1" in
	--image)
		[[ $# -ge 2 ]] || fail "--image requires a value"
		ar_image="$2"
		shift 2
		;;
	--env)
		[[ $# -ge 2 ]] || fail "--env requires NAME=VALUE"
		ar_vm_env_flags+=("$2")
		shift 2
		;;
	--yes)
		ar_confirmed=true
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		fail "unknown argument: $1"
		;;
	esac
done

command -v gcloud >/dev/null || fail "gcloud is required"
command -v jq >/dev/null || fail "jq is required"
load_vm_env

case "${ar_action}" in
preview) preview_release ;;
status) status_release ;;
deploy) deploy_release ;;
stop) stop_release ;;
-h | --help)
	usage
	;;
*)
	usage >&2
	exit 64
	;;
esac
