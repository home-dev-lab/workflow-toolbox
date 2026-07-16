// review-locks.test.ts — TEST-LOCKS for the pr-review findings on the initial wt-comm
// commit (run wf_d55a5b96-b2e, verdict request-changes). One lock per accepted finding:
// each test FAILED against the reviewed code and passes after its fix — locking the fix
// against regression. Finding numbers reference the review's own ordering.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  writeMessage,
  claimSettlement,
  readSettlement,
  readSettlementFor,
  respondToQuestion,
} from '../src/fs.js'
import { consumedPath, messagePath } from '../src/paths.js'
import { decisionIdFor } from '../src/ids.js'
import { DECISION_ID_PATTERN } from '../src/schemas.js'
import type { QuestionMessage, DecisionMessage } from '../src/schemas.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wt-comm-locks-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const AT = '2026-07-16T10:00:00Z'
const AT2 = '2026-07-16T10:05:00Z'

function question(): QuestionMessage {
  return {
    schemaVersion: 1,
    id: 'q-run1-step',
    type: 'escalation.question',
    from: { role: 'agent', id: 'agent-1' },
    to: { role: 'pilot' },
    runId: 'run1',
    at: AT,
    payload: {
      kind: 'no-test-seam',
      options: [
        { id: 'opt-a', label: 'Option A here' },
        { id: 'opt-b', label: 'Option B here' },
      ],
      defaultOptionId: 'opt-a',
      question: 'Which approach should I take for this ambiguous case, exactly?',
    },
  }
}

function decisionFor(q: QuestionMessage, decision: string): DecisionMessage {
  return {
    schemaVersion: 1,
    id: decisionIdFor(q.id),
    type: 'decision.response',
    from: { role: 'pilot', id: 'pilot-1' },
    to: { role: 'agent', id: q.from.id },
    runId: q.runId as string,
    at: AT,
    inReplyTo: q.id,
    payload: { decision },
  }
}

describe('F0 (HIGH) — respondToQuestion must settle with the ADOPTED decision, never contradict it', () => {
  it('claims the settlement with the pre-existing decision message value, not args.decision', () => {
    const q = question()
    writeMessage(dir, q)
    // A prior pilot call wrote the decision (opt-a) but crashed before claiming.
    writeMessage(dir, decisionFor(q, 'opt-a'))

    // A re-run (or a second pilot process) answers with a DIFFERENT in-memory intent.
    const result = respondToQuestion(dir, q, { by: { role: 'pilot', id: 'pilot-1' }, decision: 'opt-b', at: AT2 })

    // The durable decision message is the authority the marker must reflect.
    const marker = readSettlement(dir, q.id)
    expect(marker.ok && marker.settlement.outcome).toBe('opt-a')
    expect(result.outcome === 'settled' || result.outcome === 'already-settled').toBe(true)
    if (result.outcome === 'settled' || result.outcome === 'already-settled') {
      expect(result.settlement.outcome).toBe('opt-a')
    }
  })
})

describe('F2/F5 (HIGH) — settlement coherence is re-checked on READ (readSettlementFor)', () => {
  it('rejects a hand-forged pilot-decision marker whose outcome is not among the options', () => {
    const q = question()
    writeMessage(dir, q)
    // Forged by hand (shell participant / hostile writer): shape-valid, semantically illegal.
    writeFileSync(
      consumedPath(dir, q.id),
      JSON.stringify({ id: q.id, by: { role: 'pilot', id: 'x' }, at: AT, mode: 'decision', outcome: 'not-an-option' }),
      'utf8',
    )
    const read = readSettlementFor(dir, q)
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.reason).toBe('incoherent')
  })

  it('rejects an agent-role marker claiming mode decision', () => {
    const q = question()
    writeMessage(dir, q)
    writeFileSync(
      consumedPath(dir, q.id),
      JSON.stringify({ id: q.id, by: { role: 'agent', id: 'agent-1' }, at: AT, mode: 'decision', outcome: 'opt-a' }),
      'utf8',
    )
    const read = readSettlementFor(dir, q)
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.reason).toBe('incoherent')
  })

  it('respondToQuestion surfaces an incoherent existing marker instead of accepting it', () => {
    const q = question()
    writeMessage(dir, q)
    writeFileSync(
      consumedPath(dir, q.id),
      JSON.stringify({ id: q.id, by: { role: 'agent', id: 'agent-1' }, at: AT, mode: 'decision', outcome: 'opt-a' }),
      'utf8',
    )
    const result = respondToQuestion(dir, q, { by: { role: 'pilot', id: 'pilot-1' }, decision: 'opt-a', at: AT2 })
    expect(result.outcome).toBe('incoherent-settlement')
  })

  it('accepts a coherent marker (control)', () => {
    const q = question()
    writeMessage(dir, q)
    const claimed = claimSettlement(dir, q, { by: { role: 'agent', id: 'agent-1' }, at: AT, mode: 'default-timeout', outcome: 'opt-a' })
    expect(claimed.outcome).toBe('settled')
    const read = readSettlementFor(dir, q)
    expect(read.ok).toBe(true)
  })
})

describe('F6 (MED) — a torn settlement marker is torn-settlement, never already-settled', () => {
  it('claimSettlement reports torn-settlement on an unparseable existing marker', () => {
    const q = question()
    writeMessage(dir, q)
    writeFileSync(consumedPath(dir, q.id), '{"id":"q-run1-step","by":{"ro', 'utf8') // torn write
    const result = claimSettlement(dir, q, { by: { role: 'agent', id: 'agent-1' }, at: AT, mode: 'default-timeout', outcome: 'opt-a' })
    expect(result.outcome).toBe('torn-settlement')
  })
})

describe('F7 (MED) — respondToQuestion returns invalid-claim instead of throwing on a bad option', () => {
  it('returns the typed outcome and writes NOTHING', () => {
    const q = question()
    writeMessage(dir, q)
    const before = readdirSync(dir).sort()
    const result = respondToQuestion(dir, q, { by: { role: 'pilot', id: 'pilot-1' }, decision: 'not-an-option', at: AT2 })
    expect(result.outcome).toBe('invalid-claim')
    expect(readdirSync(dir).sort()).toEqual(before)
  })
})

describe('F8 (LOW) — respondToQuestion refuses a non-pilot caller at runtime, before any write', () => {
  it('returns invalid-claim and writes nothing when by.role is agent', () => {
    const q = question()
    writeMessage(dir, q)
    const before = readdirSync(dir).sort()
    const result = respondToQuestion(dir, q, {
      by: { role: 'agent', id: 'agent-1' } as unknown as { role: 'pilot'; id: string },
      decision: 'opt-a',
      at: AT2,
    })
    expect(result.outcome).toBe('invalid-claim')
    expect(readdirSync(dir).sort()).toEqual(before)
    // And no forged pilot-authored decision message can exist.
    expect(() => readFileSync(messagePath(dir, decisionIdFor(q.id)), 'utf8')).toThrow()
  })
})

describe('F1 (MED) — DECISION_ID_PATTERN matches the README grammar (base capped at 96 chars)', () => {
  it('accepts a 96-char base and rejects a 97-char base', () => {
    const base96 = 'q' + 'a'.repeat(95)
    const base97 = 'q' + 'a'.repeat(96)
    expect(DECISION_ID_PATTERN.test(`${base96}--decision`)).toBe(true)
    expect(DECISION_ID_PATTERN.test(`${base97}--decision`)).toBe(false)
  })
})

describe('F9 (MED) — teaching pack mint guidance carries the segment caps the library enforces', () => {
  it('the pack cites the 40/32 truncation caps that match ids.ts', () => {
    const pack = readFileSync(new URL('../teaching/wt-comm-participant.md', import.meta.url), 'utf8')
    const idsSrc = readFileSync(new URL('../src/ids.ts', import.meta.url), 'utf8')
    const runMax = /RUN_SEGMENT_MAX = (\d+)/.exec(idsSrc)?.[1]
    const stepMax = /STEP_SEGMENT_MAX = (\d+)/.exec(idsSrc)?.[1]
    expect(runMax).toBe('40')
    expect(stepMax).toBe('32')
    expect(pack).toMatch(new RegExp(`${runMax}\\s*chars`))
    expect(pack).toMatch(new RegExp(`${stepMax}\\s*chars`))
  })
})
