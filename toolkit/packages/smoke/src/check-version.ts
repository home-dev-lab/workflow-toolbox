// check-version.ts — the READ-ONLY version gate for the upgrade canary. Gathers
// the current cheap signals (the `claude` CLI version + the installed Agent SDK
// version), compares them to the per-machine marker, and decides whether the
// canary needs to run. It does NOT write the marker — `pnpm canary` (canary-all)
// is the sole writer, recording the real verdict after the matrix runs.
//
//     pnpm canary:version            # decide: exit 0 = skip, 3 = run (any other exit = the gate itself crashed)
//     pnpm canary:version --force    # always decide "run"
//
// The bundled runtime ships with the SDK, so a sdkVersion change is its proxy at
// gate time; the system runtime is the `claude` CLI version. Either moving (or a
// prior FAIL, or no marker) forces a run.

import { readFileSync } from 'node:fs'
import { getClaudeVersion, getSdkVersion, MARKER_PATH } from './runtimes.js'
import {
  type CanaryMarker,
  compareSignals,
  decideRun,
  parseMarker,
  type VersionSignals,
} from './version.js'

function readMarker(): CanaryMarker | null {
  try {
    return parseMarker(readFileSync(MARKER_PATH, 'utf8'))
  } catch {
    return null
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const current: VersionSignals = { claudeVersion: getClaudeVersion(), sdkVersion: getSdkVersion() }
  const last = readMarker()
  const comparison = compareSignals(last, current)
  const decision = decideRun(comparison, last, force)

  console.log(`[canary] current: claude ${current.claudeVersion ?? '?'} · sdk ${current.sdkVersion ?? '?'}`)
  console.log(`[canary] ${decision.run ? 'RUN' : 'SKIP'} — ${decision.reason}`)
  process.exit(decision.run ? 3 : 0)
}

main()
