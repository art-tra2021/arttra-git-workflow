#!/usr/bin/env bash
set -euo pipefail

ar_test_root="$(mktemp -d)"
trap 'rm -rf "${ar_test_root}"' EXIT
mkdir -p "${ar_test_root}/bin"

cat >"${ar_test_root}/bin/gcloud" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${FAKE_GCLOUD_LOG}"

ar_serving_revision="${FAKE_SERVING_REVISION}"
if grep -Eq '^run services update-traffic ' "${FAKE_GCLOUD_LOG}"; then
  ar_serving_revision="${FAKE_ROLLBACK_REVISION}"
fi

if [[ "$1 $2 $3" == "run services describe" ]]; then
  jq -cn \
    --arg revision "${ar_serving_revision}" \
    --arg latest "${FAKE_LATEST_READY_REVISION:-${FAKE_SERVING_REVISION}}" \
    '{status:{url:"https://slack.example.test",latestReadyRevisionName:$latest,traffic:[{revisionName:$revision,percent:100}]}}'
elif [[ "$1 $2 $3" == "run revisions describe" ]]; then
  ar_revision="$4"
  ar_digest="${FAKE_CURRENT_DIGEST}"
  ar_revision_commit="${FAKE_REVISION_COMMIT:-}"
  if [[ "${ar_revision}" == "${FAKE_ROLLBACK_REVISION:-}" ]]; then
    ar_digest="${FAKE_ROLLBACK_DIGEST:-${FAKE_CURRENT_DIGEST}}"
    ar_revision_commit="${FAKE_ROLLBACK_REVISION_COMMIT:-}"
  fi
  ar_image="asia-northeast1-docker.pkg.dev/bmarumado/arttra-work/slack-adapter@${ar_digest}"
  if [[ "${ar_digest}" != sha256:* ]]; then
    ar_image="asia-northeast1-docker.pkg.dev/bmarumado/arttra-work/slack-adapter:${ar_digest}"
  fi
  jq -cn \
    --arg image "${ar_image}" \
    --arg service "arttra-work-slack" \
    --arg revisionCommit "${ar_revision_commit}" \
    '{
      metadata:{labels:{"serving.knative.dev/service":$service,"ar-build-revision":$revisionCommit}},
      spec:{containers:[{image:$image}]},
      status:{imageDigest:$image}
    }'
elif [[ "$1 $2 $3" == "run services update-traffic" || "$1 $2 $3" == "run deploy arttra-work-slack" ]]; then
  exit 0
else
  printf 'unexpected gcloud invocation: %s\n' "$*" >&2
  exit 1
fi
EOF

cat >"${ar_test_root}/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2 $3" == "buildx imagetools inspect" ]]
[[ "$5" == "--format" ]]
[[ "$6" == "{{json .Manifest}}" ]]

if [[ "${FAKE_MANIFEST_MODE:-valid}" == "missing-amd64" ]]; then
  jq -cn \
    --arg indexDigest "${FAKE_INDEX_DIGEST}" \
    --arg attestationDigest "${FAKE_ATTESTATION_DIGEST}" \
    '{
      schemaVersion:2,
      mediaType:"application/vnd.oci.image.index.v1+json",
      digest:$indexDigest,
      manifests:[{
        mediaType:"application/vnd.oci.image.manifest.v1+json",
        digest:$attestationDigest,
        platform:{architecture:"unknown",os:"unknown"}
      }]
    }'
  exit 0
fi

jq -cn \
  --arg indexDigest "${FAKE_INDEX_DIGEST}" \
  --arg imageDigest "${FAKE_TARGET_DIGEST}" \
  --arg attestationDigest "${FAKE_ATTESTATION_DIGEST}" \
  '{
    schemaVersion:2,
    mediaType:"application/vnd.oci.image.index.v1+json",
    digest:$indexDigest,
    manifests:[
      {
        mediaType:"application/vnd.oci.image.manifest.v1+json",
        digest:$imageDigest,
        platform:{architecture:"amd64",os:"linux"}
      },
      {
        mediaType:"application/vnd.oci.image.manifest.v1+json",
        digest:$attestationDigest,
        annotations:{"vnd.docker.reference.type":"attestation-manifest"},
        platform:{architecture:"unknown",os:"unknown"}
      }
    ]
  }'
EOF

cat >"${ar_test_root}/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ar_commit="${FAKE_HEALTH_COMMIT}"
if grep -Eq '^run services update-traffic ' "${FAKE_GCLOUD_LOG}"; then
  ar_commit="${FAKE_ROLLBACK_HEALTH_COMMIT:-${FAKE_HEALTH_COMMIT}}"
fi
jq -cn --arg commit "${ar_commit}" '{ok:true,schemaVersion:1,commit:$commit}'
EOF

chmod +x "${ar_test_root}/bin/gcloud" "${ar_test_root}/bin/docker" "${ar_test_root}/bin/curl"

export PATH="${ar_test_root}/bin:${PATH}"
export FAKE_GCLOUD_LOG="${ar_test_root}/gcloud.log"
export FAKE_SERVING_REVISION="arttra-work-slack-00048-xv7"
export FAKE_ROLLBACK_REVISION="arttra-work-slack-00047-old"

ar_main="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
ar_old="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
ar_main_digest="sha256:1111111111111111111111111111111111111111111111111111111111111111"
ar_old_digest="sha256:2222222222222222222222222222222222222222222222222222222222222222"
ar_rollback_digest="sha256:3333333333333333333333333333333333333333333333333333333333333333"
export FAKE_INDEX_DIGEST="sha256:4444444444444444444444444444444444444444444444444444444444444444"
export FAKE_ATTESTATION_DIGEST="sha256:5555555555555555555555555555555555555555555555555555555555555555"
export FAKE_TARGET_DIGEST="${ar_main_digest}"
export FAKE_CURRENT_DIGEST="${ar_old_digest}"
export FAKE_ROLLBACK_DIGEST="${ar_rollback_digest}"
export FAKE_HEALTH_COMMIT="${ar_old}"
export FAKE_ROLLBACK_HEALTH_COMMIT="${ar_old}"
export FAKE_REVISION_COMMIT="${ar_old}"
export FAKE_ROLLBACK_REVISION_COMMIT="${ar_old}"

: >"${FAKE_GCLOUD_LOG}"
ar_preview="$(bash scripts/slack-release.sh preview --commit "${ar_main}" --main-commit "${ar_main}")"
jq -e \
	--arg commit "${ar_main}" \
	--arg digest "${ar_main_digest}" \
	'.action == "preview"
    and .target.commit == $commit
    and .target.digest == $digest
    and .target.deployImage == ("asia-northeast1-docker.pkg.dev/bmarumado/arttra-work/slack-adapter@" + $digest)
    and .changes[0].field == "imageDigest"
    and .changes[0].changed == true
    and .mutationAllowed == false' \
	<<<"${ar_preview}" >/dev/null

export FAKE_CURRENT_DIGEST="${ar_main_digest}"
export FAKE_HEALTH_COMMIT="${ar_main}"
export FAKE_REVISION_COMMIT="${ar_main}"
: >"${FAKE_GCLOUD_LOG}"
ar_status="$(bash scripts/slack-release.sh status --main-commit "${ar_main}")"
jq -e \
	'.drift.detected == false
    and .serving.imageDigest == .target.digest
    and .drift.targetImageMetadataMissing == false
    and .drift.imageMetadataMissing == false
    and .drift.imageVsTarget == false' \
	<<<"${ar_status}" >/dev/null

export FAKE_CURRENT_DIGEST="${ar_old_digest}"
: >"${FAKE_GCLOUD_LOG}"
set +e
ar_image_drift="$(bash scripts/slack-release.sh status --main-commit "${ar_main}")"
ar_image_drift_status=$?
set -e
[[ ${ar_image_drift_status} -eq 2 ]]
jq -e \
	'.drift.detected == true
    and .drift.imageMetadataMissing == false
    and .drift.imageVsTarget == true
    and .drift.mainVsHealth == false
    and .drift.revisionVsHealth == false' \
	<<<"${ar_image_drift}" >/dev/null

export FAKE_CURRENT_DIGEST="latest"
: >"${FAKE_GCLOUD_LOG}"
set +e
ar_image_missing="$(bash scripts/slack-release.sh status --main-commit "${ar_main}")"
ar_image_missing_status=$?
set -e
[[ ${ar_image_missing_status} -eq 2 ]]
jq -e \
	'.drift.detected == true
    and .serving.imageDigest == ""
    and .drift.imageMetadataMissing == true
    and .drift.imageVsTarget == true
    and .drift.mainVsHealth == false
    and .drift.revisionVsHealth == false' \
	<<<"${ar_image_missing}" >/dev/null

export FAKE_CURRENT_DIGEST="${ar_main_digest}"
export FAKE_HEALTH_COMMIT="${ar_old}"
export FAKE_REVISION_COMMIT="${ar_old}"
: >"${FAKE_GCLOUD_LOG}"
set +e
ar_drift="$(bash scripts/slack-release.sh status --main-commit "${ar_main}")"
ar_drift_status=$?
set -e
[[ ${ar_drift_status} -eq 2 ]]
jq -e \
	'.drift.detected == true
    and .drift.mainVsHealth == true
    and .drift.imageVsTarget == false
    and .drift.revisionVsHealth == false' \
	<<<"${ar_drift}" >/dev/null

export FAKE_HEALTH_COMMIT="${ar_main}"
export FAKE_REVISION_COMMIT="${ar_main}"
: >"${FAKE_GCLOUD_LOG}"
bash scripts/slack-release.sh deploy \
	--commit "${ar_main}" \
	--main-commit "${ar_main}" \
	--yes >/dev/null
grep -Eq "^run deploy arttra-work-slack --image .*@${ar_main_digest} --update-labels ar-build-revision=${ar_main} " "${FAKE_GCLOUD_LOG}"

: >"${FAKE_GCLOUD_LOG}"
if bash scripts/slack-release.sh deploy --commit "${ar_main}" --main-commit "${ar_main}" >/dev/null 2>&1; then
	printf 'deploy without --yes unexpectedly succeeded\n' >&2
	exit 1
fi
if grep -Eq '^run deploy ' "${FAKE_GCLOUD_LOG}"; then
	printf 'deploy without --yes mutated Cloud Run\n' >&2
	exit 1
fi

: >"${FAKE_GCLOUD_LOG}"
set +e
ar_rollback_preview="$(bash scripts/slack-release.sh rollback --revision "${FAKE_ROLLBACK_REVISION}" --main-commit "${ar_main}" 2>/dev/null)"
ar_rollback_preview_status=$?
set -e
[[ ${ar_rollback_preview_status} -eq 64 ]]
jq -e \
	--arg digest "${ar_rollback_digest}" \
	'.action == "rollback"
    and .target.digest == $digest
    and .mutationAllowed == false' \
	<<<"${ar_rollback_preview}" >/dev/null
if grep -Eq '^run services update-traffic ' "${FAKE_GCLOUD_LOG}"; then
	printf 'rollback without --yes mutated Cloud Run\n' >&2
	exit 1
fi

: >"${FAKE_GCLOUD_LOG}"
set +e
ar_rollback="$(bash scripts/slack-release.sh rollback \
	--revision "${FAKE_ROLLBACK_REVISION}" \
	--main-commit "${ar_main}" \
	--yes)"
ar_rollback_status=$?
set -e
[[ ${ar_rollback_status} -eq 2 ]]
jq -s -e \
	--arg digest "${ar_rollback_digest}" \
	'.[0].target.digest == $digest
    and .[1].serving.imageDigest == $digest
    and .[1].drift.imageVsTarget == true
    and .[1].drift.mainVsHealth == true
    and .[1].drift.servingVsLatestReady == true' \
	<<<"${ar_rollback}" >/dev/null
grep -Eq "^run services update-traffic arttra-work-slack --to-revisions ${FAKE_ROLLBACK_REVISION}=100 " "${FAKE_GCLOUD_LOG}"

export FAKE_MANIFEST_MODE="missing-amd64"
: >"${FAKE_GCLOUD_LOG}"
if bash scripts/slack-release.sh preview --commit "${ar_main}" --main-commit "${ar_main}" >/dev/null 2>&1; then
	printf 'preview without a unique linux/amd64 manifest unexpectedly succeeded\n' >&2
	exit 1
fi
if grep -Eq '^run deploy ' "${FAKE_GCLOUD_LOG}"; then
	printf 'invalid preview mutated Cloud Run\n' >&2
	exit 1
fi

: >"${FAKE_GCLOUD_LOG}"
set +e
ar_target_missing="$(bash scripts/slack-release.sh status --main-commit "${ar_main}" 2>/dev/null)"
ar_target_missing_status=$?
set -e
[[ ${ar_target_missing_status} -eq 2 ]]
jq -e \
	'.target.digest == ""
    and .drift.detected == true
    and .drift.targetImageMetadataMissing == true
    and .drift.imageVsTarget == true' \
	<<<"${ar_target_missing}" >/dev/null
