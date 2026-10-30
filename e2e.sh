#!/usr/bin/env bash
set -u
ROOT="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
node "${ROOT}/toolkit/packages/build/test/fixtures/lane-admission-e2e.mjs" refuse
status=$?
printf 'wt-lane exit=%s\n' "${status}"
if [ "${status}" -ne 1 ]; then exit 1; fi
node "${ROOT}/toolkit/packages/build/test/fixtures/lane-admission-e2e.mjs" concurrent
