#!/usr/bin/env bash
set -u
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ ${1:-} != --leased ]]; then
  exec node "$ROOT/plugin/bin/wt-suite-lock.mjs" run --light -- bash "$ROOT/e2e.sh" --leased
fi
T=$(mktemp -d)
trap 'rm -rf "${T:?}"' EXIT
cd "$ROOT/toolkit" || exit 2
node -e 'console.log(`Containment-host SIMULATION on ${process.platform}; native macOS proof requires the integration remote run.`)'
worst=0
for mode in darwin native; do
  for name in opencode-admission admission-snapshot second-opinion-admission; do
    file="packages/build/test/$name.test.ts"
    if [[ $mode == native ]]; then
      env -u WT_ADMISSION_TEST_PLATFORM node node_modules/vitest/vitest.mjs run "$file" --reporter=json --outputFile="$T/result.json" > "$T/run.log" 2>&1
    else
      WT_ADMISSION_TEST_PLATFORM=darwin node node_modules/vitest/vitest.mjs run "$file" --reporter=json --outputFile="$T/result.json" > "$T/run.log" 2>&1
    fi
    code=$?
    node --input-type=module - "$T/result.json" "$T/run.log" "$mode" "$name" "$code" <<'NODE'
import { existsSync, readFileSync } from 'node:fs'
const [result, log, mode, name, code] = process.argv.slice(2)
if (existsSync(result)) {
  const data = JSON.parse(readFileSync(result, 'utf8'))
  console.log(`${mode === 'darwin' ? 'darwin (SIMULATED)' : `${process.platform} (REAL HOST)`} ${name}.test.ts: ${data.numPassedTests} passed, ${data.numFailedTests} failed, ${data.numPendingTests} skipped, ${data.numTotalTests} total; EXIT=${code}`)
  if (!data.success || data.numTotalTests === 0) process.exitCode = 1
} else {
  console.log(`${mode} ${name}.test.ts: no test result; EXIT=${code}`)
  process.exitCode = 1
}
if (code !== '0') process.stdout.write(readFileSync(log, 'utf8'))
NODE
    summary=$?
    if (( summary > code )); then code=$summary; fi
    if (( code > worst )); then worst=$code; fi
    rm -f "$T/result.json"
  done
done
exit "$worst"
