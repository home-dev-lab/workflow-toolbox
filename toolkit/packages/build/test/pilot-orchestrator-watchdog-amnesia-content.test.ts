// pilot-orchestrator-watchdog-amnesia-content.test.ts — content lock for card 1835195635519719361.
//
// A pilot-orchestrator-watchdog, spawned fresh after its paired orchestrator was revived
// across a session restart, sent a report accusing an earlier watchdog instance's messages
// of being "fabricated" — the messages genuinely existed, sent by a predecessor watchdog
// this fresh instance simply had no memory of, because watchdog identity/memory does not
// survive a restart either. This is a severe inversion: an observer whose whole job is
// catching fabrication became the source of a false fabrication accusation, because it read
// its own absence of memory as an absence of the event.
//
// This test locks the required constraint in plugin/agent-templates/pilot-orchestrator-watchdog.md:
// the watchdog must state absence of its own trace as "no record", never escalate that
// absence into a fabrication accusation, and — where it can — flag that it may be watching a
// revived (not freshly-spawned) orchestrator as an observation rather than a conclusion about
// the orchestrator's honesty.

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
const WATCHDOG = collapseWhitespace(
  readFileSync(join(REPO_ROOT, 'plugin/agent-templates/pilot-orchestrator-watchdog.md'), 'utf8'),
)

describe('pilot-orchestrator-watchdog.md never lets its own amnesia become a fabrication claim', () => {
  it('(a) states the correct wording for an untraceable message: "no record", not "fabricated"', () => {
    expect(WATCHDOG).toMatch(/no record of this/i)
  })

  it('(a) explicitly bans escalating that absence into a fabrication accusation', () => {
    expect(WATCHDOG).toMatch(/never escalate that absence into ["“]?this was fabricated/i)
  })

  it('(a) states its own missing trace proves only that it did not observe, not that the event did not happen', () => {
    expect(WATCHDOG).toMatch(/proves only that YOU did not observe it/i)
  })

  it('(b) tells it to flag a suspected revival as an observation, never a conclusion about honesty', () => {
    expect(WATCHDOG).toMatch(/never a conclusion about the orchestrator's honesty/i)
  })

  it('(b) honestly allows that detecting a revival may not be possible from inside its own context', () => {
    expect(WATCHDOG).toMatch(/no reliable way to detect a restart at all/i)
  })

  it('(b) states the fabrication ban holds regardless of whether a restart can be detected', () => {
    expect(WATCHDOG).toMatch(/ban above on\s*fabrication accusations holds regardless/i)
  })
})
