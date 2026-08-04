#!/usr/bin/env bash
set -euo pipefail

ar_test_root="$(mktemp -d)"
trap 'rm -rf "${ar_test_root}"' EXIT
mkdir -p "${ar_test_root}/bin"

cat >"${ar_test_root}/bin/gcloud" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${FAKE_GCLOUD_LOG}"

if [[ "$1 $2 $3" == "run services describe" ]]; then
  jq -cn \
    --arg revision "${FAKE_SERVING_REVISION}" \
    --arg latest "${FAKE_LATEST_READY_REVISION:-${FAKE_SERVING_REVISION}}" \
    '{status:{url:"https://slack.example.test",latestReadyRevisionName:$latest,traffic:[{revisionName:$revision,percent:100}]}}'
elif [[ "$1 $2 $3" == "run revisions describe" ]]; then
  ar_revision="$4"
  ar_image="${FAKE_CURRENT_IMAGE}"
  if [[ "${ar_revision}" == "${FAKE_ROLLBACK_REVISION:-}" ]]; then
    ar_image="${FAKE_ROLLBACK_IMAGE:-${FAKE_CURRENT_IMAGE}}"
  fi
  jq -cn \
    --arg image "${ar_image}" \
    --arg service "arttra-work-slack" \
    --arg revisionCommit "${FAKE_REVISION_COMMIT:-}" \
    '{metadata:{labels:{"serving.knative.dev/service":$service,"ar-build-revision":$revisionCommit}},spec:{containers:[{image:$image}]}}'
elif [[ "$1 $2 $3" == "run services update-traffic" || "$1 $2 $3" == "run deploy arttra-work-slack" ]]; then
  exit 0
else
  printf 'unexpected gcloud invocation: %s\n' "$*" >&2
  exit 1
fi
EOF

cat >"${ar_test_root}/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
jq -cn --arg commit "${FAKE_HEALTH_COMMIT}" '{ok:true,schemaVersion:1,commit:$commit}'
EOF

chmod +x "${ar_test_root}/bin/gcloud" "${ar_test_root}/bin/curl"

export PATH="${ar_test_root}/bin:${PATH}"
export FAKE_GCLOUD_LOG="${ar_test_root}/gcloud.log"
export FAKE_SERVING_REVISION="arttra-work-slack-00048-xv7"
export FAKE_ROLLBACK_REVISION="arttra-work-slack-00047-old"

ar_main="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
ar_old="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
export FAKE_CURRENT_IMAGE="asia-northeast1-docker.pkg.dev/bmarumado/arttra-work/slack-adapter:${ar_old}-amd64"
export FAKE_ROLLBACK_IMAGE="asia-northeast1-docker.pkg.dev/bmarumado/arttra-work/slack-adapter:cccccccccccccccccccccccccccccccccccccccc-amd64"
export FAKE_HEALTH_COMMIT="${ar_old}"
export FAKE_REVISION_COMMIT="${ar_old}"

ar_preview="$(bash scripts/slack-release.sh preview --commit "${ar_main}" --main-commit "${ar_main}")"
jq -e \
	--arg commit "${ar_main}" \
	'.action == "preview" and .target.commit == $commit and .changes[0].changed == true and .mutationAllowed == false' \
	<<<"${ar_preview}" >/dev/null

export FAKE_CURRENT_IMAGE="asia-northeast1-docker.pkg.dev/bmarumado/arttra-work/slack-adapter:${ar_main}-amd64"
export FAKE_HEALTH_COMMIT="${ar_main}"
export FAKE_REVISION_COMMIT="${ar_main}"
ar_status="$(bash scripts/slack-release.sh status --main-commit "${ar_main}")"
jq -e \
	'.drift.detected == false and .serving.imageCommit == .mainCommit and .drift.imageMetadataMissing == false and .drift.imageVsHealth == false' \
	<<<"${ar_status}" >/dev/null

export FAKE_CURRENT_IMAGE="asia-northeast1-docker.pkg.dev/bmarumado/arttra-work/slack-adapter:${ar_old}-amd64"
set +e
ar_image_drift="$(bash scripts/slack-release.sh status --main-commit "${ar_main}")"
ar_image_drift_status=$?
set -e
[[ ${ar_image_drift_status} -eq 2 ]]
jq -e \
	'.drift.detected == true and .drift.imageMetadataMissing == false and .drift.imageVsHealth == true and .drift.mainVsHealth == false and .drift.revisionVsHealth == false' \
	<<<"${ar_image_drift}" >/dev/null

export FAKE_CURRENT_IMAGE="asia-northeast1-docker.pkg.dev/bmarumado/arttra-work/slack-adapter:latest"
set +e
ar_image_missing="$(bash scripts/slack-release.sh status --main-commit "${ar_main}")"
ar_image_missing_status=$?
set -e
[[ ${ar_image_missing_status} -eq 2 ]]
jq -e \
	'.drift.detected == true and .serving.imageCommit == "" and .drift.imageMetadataMissing == true and .drift.imageVsHealth == true and .drift.mainVsHealth == false and .drift.revisionVsHealth == false' \
	<<<"${ar_image_missing}" >/dev/null

export FAKE_CURRENT_IMAGE="asia-northeast1-docker.pkg.dev/bmarumado/arttra-work/slack-adapter:${ar_old}-amd64"
export FAKE_HEALTH_COMMIT="${ar_old}"
export FAKE_REVISION_COMMIT="${ar_old}"
set +e
ar_drift="$(bash scripts/slack-release.sh status --main-commit "${ar_main}")"
ar_drift_status=$?
set -e
[[ ${ar_drift_status} -eq 2 ]]
jq -e '.drift.detected == true and .drift.mainVsHealth == true' <<<"${ar_drift}" >/dev/null

export FAKE_CURRENT_IMAGE="asia-northeast1-docker.pkg.dev/bmarumado/arttra-work/slack-adapter:${ar_main}-amd64"
export FAKE_HEALTH_COMMIT="${ar_main}"
export FAKE_REVISION_COMMIT="${ar_main}"
: >"${FAKE_GCLOUD_LOG}"
bash scripts/slack-release.sh deploy \
	--commit "${ar_main}" \
	--main-commit "${ar_main}" \
	--yes >/dev/null
grep -Eq "^run deploy arttra-work-slack --image .*:${ar_main}-amd64 --update-labels ar-build-revision=${ar_main} " "${FAKE_GCLOUD_LOG}"

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
if bash scripts/slack-release.sh rollback --revision "${FAKE_ROLLBACK_REVISION}" --main-commit "${ar_main}" >/dev/null 2>&1; then
	printf 'rollback without --yes unexpectedly succeeded\n' >&2
	exit 1
fi
if grep -Eq '^run services update-traffic ' "${FAKE_GCLOUD_LOG}"; then
	printf 'rollback without --yes mutated Cloud Run\n' >&2
	exit 1
fi
