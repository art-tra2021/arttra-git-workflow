#!/usr/bin/env bash
set -euo pipefail

ar_project="bmarumado"
ar_region="asia-northeast1"
ar_service="arttra-work-slack"
ar_artifact_repository="arttra-work"
ar_github_repository="art-tra2021/arttra-git-workflow"
ar_commit=""
ar_main_commit=""
ar_revision=""
ar_confirmed=false

usage() {
	cat <<'EOF'
Usage:
  scripts/slack-release.sh preview --commit <40-character-main-sha>
  scripts/slack-release.sh status
  scripts/slack-release.sh deploy --commit <40-character-main-sha> --yes
  scripts/slack-release.sh rollback --revision <cloud-run-revision> --yes

Read-only actions print deterministic JSON. deploy and rollback refuse to mutate Cloud Run
unless --yes is present. --main-commit is available for offline tests only.
EOF
}

fail() {
	printf 'slack-release: %s\n' "$*" >&2
	exit 64
}

validate_resource() {
	local ar_name="$1"
	local ar_value="$2"
	if [[ ! "${ar_value}" =~ ^[a-z][a-z0-9-]*$ ]]; then
		fail "${ar_name} contains unsupported characters"
	fi
}

validate_commit() {
	local ar_value="$1"
	if [[ ! "${ar_value}" =~ ^[0-9a-f]{40}$ ]]; then
		fail "commit must be a full lowercase 40-character SHA"
	fi
}

resolve_main_commit() {
	if [[ -n "${ar_main_commit}" ]]; then
		validate_commit "${ar_main_commit}"
		printf '%s\n' "${ar_main_commit}"
		return
	fi
	command -v gh >/dev/null || fail "gh is required to resolve the current main commit"
	local ar_resolved
	ar_resolved="$(gh api "repos/${ar_github_repository}/commits/main" --jq .sha)"
	validate_commit "${ar_resolved}"
	printf '%s\n' "${ar_resolved}"
}

target_image() {
	local ar_target_commit="$1"
	printf '%s-docker.pkg.dev/%s/%s/slack-adapter:%s-amd64\n' \
		"${ar_region}" "${ar_project}" "${ar_artifact_repository}" "${ar_target_commit}"
}

validate_digest() {
	local ar_name="$1"
	local ar_value="$2"
	if [[ ! "${ar_value}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
		fail "${ar_name} must be a lowercase sha256 digest"
	fi
}

linux_amd64_digest() {
	local ar_image="$1"
	command -v docker >/dev/null || fail "docker is required to inspect the target image"
	local ar_manifest ar_digest
	if ! ar_manifest="$(docker buildx imagetools inspect "${ar_image}" --format '{{json .Manifest}}')"; then
		fail "target image manifest could not be inspected"
	fi
	if ! ar_digest="$(jq -er '
    [.manifests[]?
      | select(
          (.platform.os // "") == "linux"
          and (.platform.architecture // "") == "amd64"
          and (.platform.variant // "") == ""
        )
      | .digest]
    | unique
    | if length == 1 then .[0] else error("expected exactly one linux/amd64 manifest") end
  ' <<<"${ar_manifest}")"; then
		fail "target image must contain exactly one linux/amd64 manifest"
	fi
	validate_digest "target image digest" "${ar_digest}"
	printf '%s\n' "${ar_digest}"
}

target_release() {
	local ar_target_commit="$1"
	local ar_image ar_digest ar_repository ar_deploy_image
	ar_image="$(target_image "${ar_target_commit}")"
	if ! ar_digest="$(linux_amd64_digest "${ar_image}")"; then
		fail "target linux/amd64 digest could not be resolved"
	fi
	ar_repository="${ar_image%:*}"
	ar_deploy_image="${ar_repository}@${ar_digest}"
	jq -cn \
		--arg commit "${ar_target_commit}" \
		--arg image "${ar_image}" \
		--arg digest "${ar_digest}" \
		--arg deployImage "${ar_deploy_image}" \
		'{commit:$commit,image:$image,digest:$digest,deployImage:$deployImage}'
}

describe_service() {
	command -v gcloud >/dev/null || fail "gcloud is required to inspect Cloud Run"
	gcloud run services describe "${ar_service}" \
		--region "${ar_region}" \
		--project "${ar_project}" \
		--platform managed \
		--format=json
}

serving_revision_from_service() {
	jq -er '
    [.status.traffic[]? | select((.percent // 0) == 100 and (.revisionName // "") != "")]
    | if length == 1 then .[0].revisionName else error("expected exactly one 100% revision") end
  '
}

describe_revision() {
	local ar_revision_name="$1"
	gcloud run revisions describe "${ar_revision_name}" \
		--region "${ar_region}" \
		--project "${ar_project}" \
		--format=json
}

revision_image() {
	jq -er '.status.imageDigest // .spec.containers[0].image // error("revision image is missing")'
}

digest_from_image() {
	local ar_image="$1"
	local ar_digest="${ar_image##*@}"
	if [[ "${ar_digest}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
		printf '%s\n' "${ar_digest}"
	fi
}

health_commit() {
	local ar_service_json="$1"
	local ar_url
	ar_url="$(jq -er '.status.url // error("service URL is missing")' <<<"${ar_service_json}")"
	curl --fail --silent --show-error "${ar_url}/health" |
		jq -r 'if .ok == true and .schemaVersion == 1 and (.commit | type) == "string" then .commit else "" end'
}

inspect_serving_release() {
	local ar_service_json ar_serving_revision ar_latest_ready_revision ar_revision_json ar_image ar_image_digest ar_revision_commit ar_health_commit
	ar_service_json="$(describe_service)"
	ar_serving_revision="$(serving_revision_from_service <<<"${ar_service_json}")"
	ar_latest_ready_revision="$(jq -r '.status.latestReadyRevisionName // ""' <<<"${ar_service_json}")"
	ar_revision_json="$(describe_revision "${ar_serving_revision}")"
	ar_image="$(revision_image <<<"${ar_revision_json}")"
	ar_image_digest="$(digest_from_image "${ar_image}")"
	ar_revision_commit="$(jq -r '.metadata.labels["ar-build-revision"] // ""' <<<"${ar_revision_json}")"
	ar_health_commit="$(health_commit "${ar_service_json}")"

	jq -cn \
		--arg revision "${ar_serving_revision}" \
		--arg latestReadyRevision "${ar_latest_ready_revision}" \
		--arg image "${ar_image}" \
		--arg imageDigest "${ar_image_digest}" \
		--arg revisionCommit "${ar_revision_commit}" \
		--arg healthCommit "${ar_health_commit}" \
		'{revision:$revision,latestReadyRevision:$latestReadyRevision,image:$image,imageDigest:$imageDigest,revisionCommit:$revisionCommit,healthCommit:$healthCommit}'
}

require_main_target() {
	[[ -n "${ar_commit}" ]] || fail "--commit is required"
	validate_commit "${ar_commit}"
	local ar_current_main
	ar_current_main="$(resolve_main_commit)"
	if [[ "${ar_commit}" != "${ar_current_main}" ]]; then
		fail "target commit is not the current main commit (${ar_current_main})"
	fi
	printf '%s\n' "${ar_current_main}"
}

preview_json() {
	local ar_current_main ar_target ar_current
	ar_current_main="$(require_main_target)"
	if ! ar_target="$(target_release "${ar_commit}")"; then
		fail "target release could not be resolved"
	fi
	ar_current="$(inspect_serving_release)"
	jq -cn \
		--arg action preview \
		--arg mainCommit "${ar_current_main}" \
		--argjson target "${ar_target}" \
		--argjson current "${ar_current}" \
		'{
      schemaVersion:1,
      action:$action,
      mainCommit:$mainCommit,
      target:$target,
      current:$current,
      changes:[
        {field:"imageDigest",from:$current.imageDigest,to:$target.digest,changed:($current.imageDigest != $target.digest)},
        {field:"commit",from:$current.healthCommit,to:$target.commit,changed:($current.healthCommit != $target.commit)},
        {field:"revisionLabel",from:$current.revisionCommit,to:$target.commit,changed:($current.revisionCommit != $target.commit)}
      ],
      mutationAllowed:false
    }'
}

preview_release() {
	preview_json
}

release_status() {
	local ar_expected_target="${1:-}"
	local ar_current_main ar_current ar_drift ar_target_image
	ar_current_main="$(resolve_main_commit)"
	if [[ -z "${ar_expected_target}" ]]; then
		if ! ar_expected_target="$(target_release "${ar_current_main}")"; then
			ar_target_image="$(target_image "${ar_current_main}")"
			ar_expected_target="$(jq -cn \
				--arg commit "${ar_current_main}" \
				--arg image "${ar_target_image}" \
				'{commit:$commit,image:$image,digest:"",deployImage:""}')"
		fi
	fi
	if [[ "$(jq -r '.commit // ""' <<<"${ar_expected_target}")" != "${ar_current_main}" ]]; then
		fail "read-back target is not the current main commit"
	fi
	ar_current="$(inspect_serving_release)"
	ar_drift="$(jq -n \
		--arg main "${ar_current_main}" \
		--argjson target "${ar_expected_target}" \
		--argjson current "${ar_current}" \
		'$current.healthCommit != $main or $target.digest == "" or $current.imageDigest == "" or $current.imageDigest != $target.digest or $current.revisionCommit != $current.healthCommit or ($current.latestReadyRevision != "" and $current.revision != $current.latestReadyRevision)')"

	jq -cn \
		--arg action status \
		--arg mainCommit "${ar_current_main}" \
		--argjson target "${ar_expected_target}" \
		--argjson current "${ar_current}" \
		--argjson drift "${ar_drift}" \
		'{
      schemaVersion:1,
      action:$action,
      mainCommit:$mainCommit,
      target:$target,
      serving:$current,
	      drift:{
	        detected:$drift,
	        mainVsHealth:($mainCommit != $current.healthCommit),
	        targetImageMetadataMissing:($target.digest == ""),
	        imageMetadataMissing:($current.imageDigest == ""),
	        imageVsTarget:($target.digest == "" or $current.imageDigest == "" or $current.imageDigest != $target.digest),
	        revisionVsHealth:($current.revisionCommit != $current.healthCommit),
	        servingVsLatestReady:($current.latestReadyRevision != "" and $current.revision != $current.latestReadyRevision)
      }
    }'

	if [[ "${ar_drift}" == "true" ]]; then
		exit 2
	fi
}

deploy_release() {
	local ar_plan ar_deploy_image ar_target
	ar_plan="$(preview_json)"
	printf '%s\n' "${ar_plan}"
	if [[ "${ar_confirmed}" != "true" ]]; then
		fail "deploy requires the explicit --yes flag after reviewing preview"
	fi
	ar_target="$(jq -c '.target' <<<"${ar_plan}")"
	ar_deploy_image="$(jq -r '.deployImage' <<<"${ar_target}")"
	gcloud run deploy "${ar_service}" \
		--image "${ar_deploy_image}" \
		--update-labels "ar-build-revision=${ar_commit}" \
		--region "${ar_region}" \
		--project "${ar_project}" \
		--platform managed \
		--quiet >/dev/null
	release_status "${ar_target}"
}

rollback_release() {
	[[ -n "${ar_revision}" ]] || fail "--revision is required"
	if [[ ! "${ar_revision}" =~ ^${ar_service}-[0-9]{5}-[a-z0-9]{3}$ ]]; then
		fail "revision must be an exact revision of ${ar_service}"
	fi
	local ar_current ar_target_revision_json ar_target_service ar_target_image ar_target_digest ar_target_commit ar_plan
	ar_current="$(inspect_serving_release)"
	ar_target_revision_json="$(describe_revision "${ar_revision}")"
	ar_target_service="$(jq -er '.metadata.labels["serving.knative.dev/service"] // error("revision service label is missing")' <<<"${ar_target_revision_json}")"
	[[ "${ar_target_service}" == "${ar_service}" ]] || fail "revision belongs to another service"
	ar_target_image="$(revision_image <<<"${ar_target_revision_json}")"
	ar_target_digest="$(digest_from_image "${ar_target_image}")"
	[[ -n "${ar_target_digest}" ]] || fail "rollback revision image must use a sha256 digest"
	ar_target_commit="$(jq -r '.metadata.labels["ar-build-revision"] // ""' <<<"${ar_target_revision_json}")"
	ar_plan="$(jq -cn \
		--arg action rollback \
		--arg targetRevision "${ar_revision}" \
		--arg targetImage "${ar_target_image}" \
		--arg targetDigest "${ar_target_digest}" \
		--arg targetCommit "${ar_target_commit}" \
		--argjson current "${ar_current}" \
		'{schemaVersion:1,action:$action,current:$current,target:{revision:$targetRevision,image:$targetImage,digest:$targetDigest,commit:$targetCommit},mutationAllowed:false}')"
	printf '%s\n' "${ar_plan}"
	if [[ "${ar_confirmed}" != "true" ]]; then
		fail "rollback requires the explicit --yes flag after reviewing the target revision"
	fi
	gcloud run services update-traffic "${ar_service}" \
		--to-revisions "${ar_revision}=100" \
		--region "${ar_region}" \
		--project "${ar_project}" \
		--platform managed \
		--quiet >/dev/null
	release_status
}

ar_action="${1:-}"
if [[ -z "${ar_action}" ]]; then
	usage >&2
	exit 64
fi
shift

while (($# > 0)); do
	case "$1" in
	--project)
		ar_project="${2:-}"
		shift 2
		;;
	--region)
		ar_region="${2:-}"
		shift 2
		;;
	--service)
		ar_service="${2:-}"
		shift 2
		;;
	--artifact-repository)
		ar_artifact_repository="${2:-}"
		shift 2
		;;
	--github-repository)
		ar_github_repository="${2:-}"
		shift 2
		;;
	--commit)
		ar_commit="${2:-}"
		shift 2
		;;
	--main-commit)
		ar_main_commit="${2:-}"
		shift 2
		;;
	--revision)
		ar_revision="${2:-}"
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

validate_resource "project" "${ar_project}"
validate_resource "region" "${ar_region}"
validate_resource "service" "${ar_service}"
validate_resource "artifact repository" "${ar_artifact_repository}"

case "${ar_action}" in
preview)
	preview_release
	;;
status)
	release_status
	;;
deploy)
	deploy_release
	;;
rollback)
	rollback_release
	;;
*)
	fail "action must be preview, status, deploy, or rollback"
	;;
esac
