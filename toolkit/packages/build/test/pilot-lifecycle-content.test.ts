import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PILOT = readFileSync(join(REPO_ROOT, 'plugin/agent-templates/pilot.md'), 'utf8')

describe('pilot lifecycle template', () => {
  // This source-text lock is intentional: the template is the normative deliverable.
  it('puts discovery before grounding and defines its cross-phase card block', () => {
    const discovery = PILOT.indexOf('**Discovery**')
    const grounding = PILOT.indexOf('**Grounding**')

    expect(discovery).toBeGreaterThan(-1)
    expect(discovery).toBeLessThan(grounding)
    for (const field of ['Impact:', 'Seams:', 'Callers:', 'Risk:', 'Proof expected:', 'Language:', 'Phase:', 'Next:']) {
      expect(PILOT).toContain(field)
    }
    expect(PILOT).toContain('rewritten at every phase exit')
  })

  it('makes LITE/FULL routing mechanical before a bounded judgment call', () => {
    expect(PILOT).toContain('| Signal | LITE | FULL |')
    for (const signal of ['files expected', 'lines expected', 'untested callers', 'any risk category', 'P0', 'bug', 'effort:L']) {
      expect(PILOT).toContain(signal)
    }
    expect(PILOT).toContain('Any risk category → FULL')
    expect(PILOT).toContain('Unsure → FULL')
    expect(PILOT).toMatch(/one\s+strong-tier judgment/)
    expect(PILOT).toContain('LITE skips plan ↔ critic')
  })

  it('writes loop bounds, exits, dispositions, and escalation', () => {
    expect(PILOT).toMatch(/Plan ↔ critic[\s\S]{0,120}≤ 3\s+cycles/)
    expect(PILOT).toContain('no blocking finding')
    expect(PILOT).toContain('while blocking findings remain')
    expect(PILOT).toMatch(/fixed\s+with red lock/)
    expect(PILOT).toMatch(/out-of-scope card #/)
    expect(PILOT).toMatch(/rejected\s+with evidence/)
    expect(PILOT).toContain('escalate, never loop silently')
  })

  it('returns review fixes to TDD until mechanical non-convergence', () => {
    expect(PILOT).toContain('review → TDD fix → verify → review')
    expect(PILOT).toContain('same anchored finding returns')
    expect(PILOT).toMatch(/blocking count does not drop for two\s+consecutive rounds/)
    expect(PILOT).toContain('There is no fixed round cap')
    expect(PILOT).toContain('targeted tests, typecheck, and lint')
    expect(PILOT).not.toContain('review → harden')
  })
})
