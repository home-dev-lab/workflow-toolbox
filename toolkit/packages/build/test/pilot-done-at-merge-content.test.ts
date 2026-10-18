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

// A sentence that moves a card to Done is allowed only when it ties the move to the merge
// ("at the merge") or forbids it ("never"/"not" right before the verb). Mentioning the merge
// elsewhere in the sentence ("to Done before the merge") is not enough.
function moveToDoneOffenders(text: string): string[] {
  return [...text.matchAll(MOVE_TO_DONE)]
    .filter((m) => !/\b(?:never|not)\s+$/i.test(text.slice(Math.max(0, m.index - 12), m.index)))
    .map((m) => text.slice(m.index, m.index + 160).split(/(?<=[.;])\s/)[0] ?? '')
    .filter((sentence) => !/\bat the merge\b/i.test(sentence))
}

describe('moveToDoneOffenders', () => {
  it('flags a premature Done that only mentions the merge', () => {
    expect(moveToDoneOffenders('Move the card to Done before the merge.')).toHaveLength(1)
  })

  it('accepts Done tied to the merge and a prohibition', () => {
    expect(moveToDoneOffenders('Whoever merges will move it to Done at the merge.')).toEqual([])
    expect(moveToDoneOffenders('You do not move it to Done yourself.')).toEqual([])
  })
})

describe.each([
  ['pilot.md', PILOT],
  ['pilot-orchestrator.md', ORCHESTRATOR],
])('%s never instructs moving a card to Done before the merge', (_name, text) => {
  it('every instruction to move a card to Done names the merge within the same sentence', () => {
    expect(moveToDoneOffenders(text)).toEqual([])
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

  it('lets a static mission complete or stall on READY cards', () => {
    expect(ORCHESTRATOR).toMatch(/every listed id is Done or READY" for COMPLETE/)
    expect(ORCHESTRATOR).toMatch(/every listed id is Done, READY or Blocked, ≥1 Blocked"/)
  })

  it('recognizes READY where the pilot may record it, comment fallback included', () => {
    expect(ORCHESTRATOR).toMatch(/metadata block \(or, where the tracker has none, in the pilot's report comment\)/)
    expect(PILOT).toMatch(/metadata block \(or, where the tracker has none, in that comment\)/)
  })
})
