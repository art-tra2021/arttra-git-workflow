#!/usr/bin/env bash
set -euo pipefail

: "${GH_REPO:?GH_REPO is required}"
: "${ISSUE_NUMBER:?ISSUE_NUMBER is required}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./issue-policy-lib.sh
# The library is resolved from this script's directory at runtime.
# shellcheck disable=SC1091
source "${script_dir}/issue-policy-lib.sh"

issue_policy_validate_hierarchy "$ISSUE_NUMBER"
echo "✓ Issue #${ISSUE_NUMBER}: type・merge方針・native階層・Task末端・closing PRが有効です"
