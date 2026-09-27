#!/usr/bin/env node
import { dispatch } from './lib/crossos-dispatch.mjs'
import { isInvokedDirectly } from './lib/host/entry-guard.mjs'

const HELP = `wt-crossos-dispatch — dispatch host-layer develop merges to the public cross-OS matrix.
Usage: node plugin/bin/wt-crossos-dispatch.mjs <decide|run|collect|release-check> [options]
  decide --merge <commit> [--paths-file <file>]
  run --merge <commit> [--dry-run] [--timeout-min <minutes>] [--evidence-dir <dir>]
  collect --merge <commit>
  release-check [--ref <commit>] [--base <remote>/main]
  Common: --repo <checkout> --remote public --repo-slug <owner/repo> --workflow cross-os.yml
 Exit codes: 0 run/skip (decide), green/dry-run/unchecked · 1 red · 2 precondition · 3 mismatch · 4 timeout · 5 pending.
`

if (isInvokedDirectly(import.meta.url)) {
  process.exitCode = process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')
    ? (console.log(HELP), 0)
    : await dispatch(process.argv.slice(2))
}
