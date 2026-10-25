#!/usr/bin/env node
import { handleHelpFlag } from './lib/cli-help.mjs'
import { dispatch } from './lib/crossos-dispatch.mjs'
import { isInvokedDirectly } from './lib/host/entry-guard.mjs'

const HELP = `wt-crossos-dispatch — dispatch host-layer develop merges to the public cross-OS matrix.
Usage: node plugin/bin/wt-crossos-dispatch.mjs <decide|run|collect|release-check> [options]
  decide --merge <commit> [--paths-file <file>]
  run --merge <commit> [--dry-run] [--timeout-min <minutes>] [--evidence-dir <dir>]
  collect --merge <commit>
  release-check [--ref <commit>] [--base <remote>/main]
  Common: --repo <checkout> --remote public --repo-slug <owner/repo> --workflow cross-os.yml
  decide/run require --merge to contain the current local develop tip (refs/heads/develop).
  Pushing (run/collect) accepts only --remote public; the public pre-push hook guards that name.
 Exit codes: 0 run/skip (decide), green/dry-run/unchecked · 1 red · 2 precondition · 3 mismatch · 4 timeout · 5 pending.
`

if (isInvokedDirectly(import.meta.url)) {
  // `release-check --ref --help` is a guard whose exit 0 means "released": --help is help only in
  // flag position, and --dry-run is the one option of this CLI that takes no value.
  handleHelpFlag(process.argv.slice(2), HELP, {
    valueFlags: ['--merge', '--repo', '--paths-file', '--remote', '--workflow', '--repo-slug', '--timeout-min', '--evidence-dir', '--ref', '--base'],
    booleanFlags: ['--dry-run'],
  })
  process.exitCode = await dispatch(process.argv.slice(2))
}
