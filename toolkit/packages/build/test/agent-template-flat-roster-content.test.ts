// agent-template-flat-roster-content.test.ts — content lock for card 1835119454938204004.
//
// The pilot/orchestrator templates describe the file-report contract but never said WHY it
// exists: the teammate roster is FLAT, so a named delegate's final message and task
// notification always route to MAIN, never to its own spawner. Without that reason stated,
// an agent that sees a spawned delegate's name fail to resolve concludes "agent gone" instead
// of "wrong channel, poll the file". Measured 3 times in one hour on 2026-08-05.
//
// This test locks the four closure points in BOTH plugin/agent-templates/pilot.md and
// pilot-orchestrator.md: (a) the roster is flat, (b) so finals route to main, (c) so the
// file-report is the real channel and gets polled, (d) an unresolving name means
// wrong-channel, never agent-gone.

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
const PILOT = collapseWhitespace(
  readFileSync(join(REPO_ROOT, 'plugin/agent-templates/pilot.md'), 'utf8'),
)
const ORCHESTRATOR = collapseWhitespace(
  readFileSync(join(REPO_ROOT, 'plugin/agent-templates/pilot-orchestrator.md'), 'utf8'),
)

describe.each([
  ['pilot.md', PILOT],
  ['pilot-orchestrator.md', ORCHESTRATOR],
])('%s states why the file-report contract exists', (_name, text) => {
  it('(a) states the teammate roster is flat', () => {
    expect(text).toMatch(/roster is flat/i)
  })

  it("(b) states a spawned/named agent's final message routes to main", () => {
    expect(text).toMatch(/final message.{0,60}(main session|routes? to.{0,15}main)/i)
  })

  it('(c) states the file is the real/actual channel that gets polled/read', () => {
    expect(text).toMatch(/poll(ed)?(\/| and )?read|read the file/i)
  })

  it('(d) states an unresolving name means wrong-channel, never agent-gone', () => {
    expect(text).toMatch(/wrong.channel/i)
    expect(text).toMatch(/never ["“]?(agent|pilot).{0,10}gone/i)
  })
})
