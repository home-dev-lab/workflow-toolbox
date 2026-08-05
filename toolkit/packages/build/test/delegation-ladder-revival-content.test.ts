// delegation-ladder-revival-content.test.ts — content lock for card 1835166417075308428.
//
// plugin/rules/wt-delegation-ladder.md used to call cross-restart agent revival by raw id a
// "single dated, unreproduced observation". Read as written, that pushed a session toward
// RE-SPAWNING a delegate after a restart instead of probing it — throwing away a delegate's
// whole accumulated context. It was reproduced twice on 2026-08-05 (a ~290k-token wave
// orchestrator, then its own subordinate, both revived by raw id with full context intact).
//
// This test locks the four closure points: (a) raw-id revival is reproduced, not a one-off,
// and the short name may still fail; (b) the raw id is recoverable from the `subagents/`
// directory's filenames; (c) a revived agent does NOT appear in the interactive agent list, so
// absence from that list is never evidence of death; (d) the operative order is probe by raw id
// BEFORE re-spawning. Plus the honest-scope caveat is retained (reachability-with-context on
// this harness version, not a permanent guarantee).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Markdown prose wraps at ~80-100 cols, so a phrase we assert on can straddle a line break
// (a literal space in the assertion, a newline in the file). Collapse all whitespace runs to
// a single space before matching so the assertions are robust to reflow.
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ')
}

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const RULE = collapseWhitespace(
  readFileSync(join(REPO_ROOT, 'plugin/rules/wt-delegation-ladder.md'), 'utf8'),
)

describe('wt-delegation-ladder.md states cross-restart revival is reproduced', () => {
  it('never calls the observation "unreproduced" as a live claim', () => {
    // The word may still appear inside a corrective aside ("no longer calls this
    // unreproduced") — what must NOT exist is the retired claim asserting it as current fact.
    expect(RULE).not.toMatch(/single[, ]+dated[, ]+unreproduced/i)
    expect(RULE).not.toMatch(/single observation, not a confirmed behavior/i)
  })

  it('(a) states raw-id revival is reproduced and the short name may still fail', () => {
    expect(RULE).toMatch(/reproduced/i)
    expect(RULE).toMatch(
      /short name.{0,20}(may|can) still fail|fail.{0,30}while the same agent's raw id/i,
    )
  })

  it('(b) states the raw id is recoverable from the subagents/ directory filenames', () => {
    expect(RULE).toMatch(/subagents\//)
    expect(RULE).toMatch(/filenames.{0,20}ARE the ids|are the ids/i)
  })

  it('(c) states a revived agent does not appear in the interactive agent list', () => {
    expect(RULE).toMatch(/does not appear.{0,20}in the.{0,5}interactive agent list/i)
  })

  it('(d) states the operative order is probe before re-spawning', () => {
    expect(RULE).toMatch(/probe before re-spawning/i)
  })

  it('keeps the honest-scope caveat (reachability-with-context, not a permanent guarantee)', () => {
    expect(RULE).toMatch(/REACHABILITY-WITH-CONTEXT/)
    expect(RULE).toMatch(/not as a permanent guarantee/i)
  })

  it('has exactly one TUI-does-not-show-a-resumed-agent paragraph (no leftover duplicate)', () => {
    const matches = RULE.match(/does not appear.{0,20}in the.{0,5}interactive agent list/gi) ?? []
    expect(matches.length).toBe(1)
  })
})
