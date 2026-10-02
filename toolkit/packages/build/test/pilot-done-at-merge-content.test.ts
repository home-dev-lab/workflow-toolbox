// pilot-done-at-merge-content.test.ts — content lock for the board convention "a card moves
// to Done ONLY at its merge, by whoever merges".
//
// A pilot's branch is READY when its Report step ends; the merge happens later, by the
// merging session. A template that tells the pilot (or the orchestrator that relays its
// result) to move the card to Done at that moment closes the card on work that is not on the
// integration branch. Measured twice in one day before this lock existed.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Markdown prose wraps at ~80-100 cols; collapse whitespace so assertions survive reflow.
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ')
}

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const read = (rel: string): string => collapseWhitespace(readFileSync(join(REPO_ROOT, rel), 'utf8'))

const PILOT = read('plugin/agent-templates/pilot.md')
const ORCHESTRATOR = read('plugin/agent-templates/pilot-orchestrator.md')

// The Report step is step 7 of the loop, ending where the environment brief begins.
const REPORT_STEP = PILOT.slice(PILOT.indexOf('7. **Report**'), PILOT.indexOf('## Environment brief'))

// An instruction to move/mark a card Done: an arrow, "move(s) it to", "mark ... Done", etc.
const MOVE_TO_DONE = /(?:→|->|\bmoves?\s+(?:it|the card|card)?\s*to|\bmark(?:s|ed)?\s+(?:it|the card|card)?)\s*`?Done\b/gi

describe.each([
  ['pilot.md', PILOT],
  ['pilot-orchestrator.md', ORCHESTRATOR],
])('%s never instructs moving a card to Done before the merge', (_name, text) => {
  it('every instruction to move a card to Done names the merge within the same sentence', () => {
    const offenders = [...text.matchAll(MOVE_TO_DONE)]
      .map((m) => text.slice(m.index, m.index + 160).split(/(?<=[.;])\s/)[0] ?? '')
      .filter((sentence) => !/merg/i.test(sentence))
    expect(offenders).toEqual([])
  })

  it('does not tie Done to the pilot reaching its own definition of done', () => {
    expect(text).not.toMatch(/Done only at DoD/i)
    expect(text).not.toMatch(/card Done\)/)
    expect(text).not.toMatch(/\(Done, or/)
  })
})

describe('pilot.md Report step', () => {
  it('has a Report step to inspect', () => {
    expect(REPORT_STEP.length).toBeGreaterThan(0)
  })

  it('leaves the card In Progress and records READY with the branch and the tip', () => {
    expect(REPORT_STEP).toMatch(/stays In Progress/)
    expect(REPORT_STEP).toMatch(/READY/)
    expect(REPORT_STEP).toMatch(/branch/i)
    expect(REPORT_STEP).toMatch(/tip/i)
  })

  it('hands Done to the merging session, at the merge', () => {
    expect(REPORT_STEP).toMatch(/Done[^.]{0,80}\bat the merge\b[^.]{0,80}(merg(es|ing|er)|whoever merges)/i)
    expect(REPORT_STEP).toMatch(/never by you/i)
  })
})

describe('pilot-orchestrator.md', () => {
  it('states Done happens at the merge and a READY card is delivered, not open work', () => {
    expect(ORCHESTRATOR).toMatch(/Done[^.]{0,80}\bat the merge\b/i)
    expect(ORCHESTRATOR).toMatch(/READY/)
  })
})
