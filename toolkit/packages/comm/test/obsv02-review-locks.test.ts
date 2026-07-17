// obsv02-review-locks.test.ts — TEST-LOCKS for the accepted findings of the
// consolidated wt-comm v0.2 / observer-def bundle review (run wf_9a4f25a6-1e1,
// verdict request-changes). One lock per accepted comm-side finding: each test
// FAILED against the reviewed code and passes after its fix. Finding ids
// reference the review's own ordering (F0-F2 shared one root).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { mintHintId } from '../src/ids.js'
import { parseMessage } from '../src/validate.js'
import { BASE_ID_PATTERN } from '../src/schemas.js'

const here = dirname(fileURLToPath(import.meta.url))

const AT = '2026-07-17T10:00:00Z'

describe('F0-F2 (HIGH, one root) — mintHintId observer segment carries its own injectivity hash', () => {
  it('two distinct valid observer names sharing a long common prefix mint DISTINCT ids', () => {
    // Both names satisfy ObserverDefinition's ^[a-z0-9-]{1,64}$; before the fix the
    // 20-char fold+truncate made them mint the SAME id for the same run/seq — silent
    // hint loss (duplicate-id) or cross-observer misattribution (resumed-adopt path).
    const prefix = 'observer-with-a-very-long-shared-prefix'
    const a = mintHintId('run-42', `${prefix}-alpha`, 1)
    const b = mintHintId('run-42', `${prefix}-beta`, 1)
    expect(a).not.toBe(b)
    expect(BASE_ID_PATTERN.test(a)).toBe(true)
    expect(BASE_ID_PATTERN.test(b)).toBe(true)
  })

  it('case/punctuation-only observer-name differences also disambiguate (raw-input hash, fold parity with runId)', () => {
    expect(mintHintId('run-42', 'docs-butler', 1)).not.toBe(mintHintId('run-42', 'docs.butler', 1))
  })

  it('the <=90 guarantee still holds with the hash under adversarial inputs', () => {
    const worst = mintHintId('R/'.repeat(100), 'z'.repeat(64), Number.MAX_SAFE_INTEGER)
    expect(worst.length).toBeLessThanOrEqual(90)
    expect(BASE_ID_PATTERN.test(worst)).toBe(true)
  })
})

describe("F3 (MED) — unknown message TYPE is 'unknown-type', distinguishable from corruption", () => {
  it("a structurally-sound message of a type this build does not know parses as reason 'unknown-type'", () => {
    // The version-coupling failure mode the README documents (a reader older than a
    // type) becomes DIAGNOSABLE: consumers can tell "newer protocol" from "garbage".
    const msg = {
      schemaVersion: 1,
      id: 'h-run1-x-1',
      type: 'observer.summary',
      from: { role: 'observer', id: 'x' },
      to: { role: 'agent', id: 'implementer' },
      at: AT,
      payload: {},
    }
    const r = parseMessage(JSON.stringify(msg))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('unknown-type')
  })

  it("a non-string type stays 'malformed' (corruption, not a future type)", () => {
    const r = parseMessage(JSON.stringify({ schemaVersion: 1, type: 42 }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('malformed')
  })
})

describe('F7 (MED) — the observer-consumer brief addresses hints by ROLE, coherently', () => {
  it('the brief names ROLE_ID (the wt-meta role hints are addressed to), not a bare AGENT_ID mismatch', () => {
    const brief = readFileSync(join(here, '../teaching/wt-comm-observer-consumer.md'), 'utf8')
    expect(brief.includes('ROLE_ID')).toBe(true)
    expect(brief).toMatch(/`to\.id`[^\n]*role name/)
    // The check script and the settlement claim must use the SAME variable the prose defines.
    expect(brief.includes('$ROLE_ID')).toBe(true)
    expect(brief.includes('$AGENT_ID')).toBe(false)
  })
})

describe('F8 (LOW) — README per-type id pattern list includes observer.hint in the base-id family', () => {
  it('the Base ids bullet enumerates observer.hint', () => {
    const readme = readFileSync(join(here, '../README.md'), 'utf8')
    expect(readme).toMatch(/\*\*Base ids\*\* \(`escalation\.question`, `status\.digest`, `observer\.hint`\)/)
  })
})
