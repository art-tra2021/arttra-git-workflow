#!/usr/bin/env bash
set -euo pipefail

ar_container_name="arttra-slack-smoke-${GITHUB_RUN_ID:-local}-$$"
ar_slack_image="${AR_SLACK_IMAGE:-arttra-slack-adapter:test}"
ar_expected_revision="${AR_EXPECTED_REVISION:-development}"

# shellcheck disable=SC2329 # trapから呼び出す
cleanup() {
	docker rm --force "${ar_container_name}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --detach --rm \
	--name "${ar_container_name}" \
	--publish 127.0.0.1::8080 \
	--env SLACK_BOT_TOKEN=xoxb-smoke \
	--env SLACK_SIGNING_SECRET=smoke \
	--env AR_SLACK_TOKEN_VERIFICATION=off \
	--env AR_GITHUB_REPO=example/repo \
	--env AR_GITHUB_LOGIN=smoke \
	--env GITHUB_APP_ID=1 \
	--env GITHUB_APP_INSTALLATION_ID=1 \
	--env GITHUB_APP_PRIVATE_KEY=smoke-not-used-by-healthcheck \
	--env GITHUB_OAUTH_CLIENT_ID=smoke \
	--env GITHUB_OAUTH_CLIENT_SECRET=smoke \
	--env AR_OAUTH_STATE_SECRET=smoke-state-secret-at-least-32-characters \
	--env AR_PUBLIC_BASE_URL=http://localhost:8080 \
	--env GITHUB_WEBHOOK_SECRET=smoke-webhook-secret-at-least-32-characters \
	--env AR_JOB_SECRET=smoke-job-secret-at-least-32-characters \
	--env AR_JOB_QUEUE=local \
	--env AR_GCP_PROJECT_ID=smoke \
	--env AR_CLOUD_TASKS_LOCATION=asia-northeast1 \
	--env AR_CLOUD_TASKS_QUEUE=smoke \
	--env AR_SLACK_TEAM_ID=T123 \
	--env AR_SLACK_REVIEW_CHANNEL_ID=C123 \
	--env AR_STATE_BACKEND=local \
	"${ar_slack_image}" >/dev/null

ar_host_port="$(docker port "${ar_container_name}" 8080/tcp | sed -E 's/.*:([0-9]+)$/\1/')"
ar_ready=false
for _ in {1..30}; do
	if curl --fail --silent "http://127.0.0.1:${ar_host_port}/health" |
		jq -e --arg commit "${ar_expected_revision}" \
			'.ok == true and .schemaVersion == 1 and .commit == $commit' >/dev/null; then
		ar_ready=true
		break
	fi
	sleep 1
done

if [[ "${ar_ready}" != "true" ]]; then
	docker logs "${ar_container_name}"
	exit 1
fi

curl --fail --silent \
	--request POST \
	--header "content-type: application/json" \
	--header "x-hub-signature-256: sha256=4f81f3d922b57a89f4d64e58b8ee9dc28d78618426cc37e3d5d359e187e43569" \
	--header "x-github-delivery: smoke-delivery" \
	--header "x-github-event: ping" \
	--data-binary '{"zen":"smoke"}' \
	"http://127.0.0.1:${ar_host_port}/github/events" |
	jq -e '.ok == true and .queued == true and .schemaVersion == 1' >/dev/null

exit 0
