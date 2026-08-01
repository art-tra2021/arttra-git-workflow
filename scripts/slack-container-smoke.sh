#!/usr/bin/env bash
set -euo pipefail

ar_container_name="arttra-slack-smoke-${GITHUB_RUN_ID:-local}-$$"

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
	--env AR_STATE_BACKEND=local \
	arttra-slack-adapter:test >/dev/null

ar_host_port="$(docker port "${ar_container_name}" 8080/tcp | sed -E 's/.*:([0-9]+)$/\1/')"
for _ in {1..30}; do
	if curl --fail --silent "http://127.0.0.1:${ar_host_port}/healthz" | jq -e '.ok == true and .schemaVersion == 1' >/dev/null; then
		exit 0
	fi
	sleep 1
done

docker logs "${ar_container_name}"
exit 1
