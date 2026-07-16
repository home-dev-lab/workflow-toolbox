import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  writeMessage,
  writeOrReadMessage,
  writeAck,
  claimSettlement,
  readSettlement,
  readMessage,
  listMessages,
  respondToQuestion,
} from '../src/fs.js'
import { messagePath, consumedPath } from '../src/paths.js'
import { decisionIdFor } from '../src/ids.js'
import type { QuestionMessage, DecisionMessage, DigestMessage } from '../src/schemas.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wt-comm-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const AT = '2026-07-16T10:00:00Z'
const AT2 = '2026-07-16T10:05:00Z'

function question(overrides: Record<string, unknown> = {}): QuestionMessage {
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
    ...overrides,
  } as QuestionMessage
}

function digest(overrides: Record<string, unknown> = {}): DigestMessage {
  return {
    schemaVersion: 1,
    id: 'd-run1-1',
    type: 'status.digest',
    from: { role: 'agent', id: 'agent-1' },
    to: { role: 'pilot' },
    runId: 'run1',
    at: AT,
    payload: { seq: 1, state: 'working', summary: 'Working through the increment fine.' },
    ...overrides,
  } as DigestMessage
}

describe('writeMessage', () => {
  it('writes a new message', () => {
    const r = writeMessage(dir, question())
    expect(r.outcome).toBe('written')
  })

  it('duplicate-id: leaves the original bytes on disk intact', () => {
    writeMessage(dir, question())
    const originalBytes = readFileSync(messagePath(dir, 'q-run1-step'), 'utf8')

    const r = writeMessage(dir, question({ payload: { ...question().payload, question: 'A totally different re-worded question, twenty-plus chars.' } }))
    expect(r.outcome).toBe('duplicate-id')

    const afterBytes = readFileSync(messagePath(dir, 'q-run1-step'), 'utf8')
    expect(afterBytes).toBe(originalBytes)
  })

  it('throws for a message that fails its own schema (caller/programmer error)', () => {
    expect(() => writeMessage(dir, question({ payload: { ...question().payload, question: 'short' } }))).toThrow()
  })
})

describe('writeOrReadMessage', () => {
  it('adopt-existing: same type+runId, DIFFERENT payload wording -> adopted, EXISTING returned', () => {
    const first = question()
    writeMessage(dir, first)

    const resumed = question({ payload: { ...first.payload, question: 'A differently worded question but same id/type/runId, 20+ chars.' } })
    const r = writeOrReadMessage(dir, resumed)
    expect(r.outcome).toBe('resumed-adopt-existing')
    if (r.outcome === 'resumed-adopt-existing' || r.outcome === 'written') {
      expect((r.message as QuestionMessage).payload.question).toBe(first.payload.question)
    }
  })

  it('id-collision: existing message at the id has a DIFFERENT runId', () => {
    writeMessage(dir, question({ runId: 'run-A' }))
    const r = writeOrReadMessage(dir, question({ runId: 'run-B' }))
    expect(r.outcome).toBe('id-collision')
  })

  it('id-collision: existing message at the id has a DIFFERENT type', () => {
    // Force a digest and a question to share an id by writing the digest's file directly
    // under the question's id.
    writeFileSync(messagePath(dir, 'q-run1-step'), JSON.stringify(digest({ id: 'q-run1-step' })), { flag: 'wx', mode: 0o600 })
    const r = writeOrReadMessage(dir, question())
    expect(r.outcome).toBe('id-collision')
  })

  it('torn-existing: pre-written garbage bytes at the path', () => {
    writeFileSync(messagePath(dir, 'q-run1-step'), 'not json at all {{{', { flag: 'wx', mode: 0o600 })
    const r = writeOrReadMessage(dir, question())
    expect(r.outcome).toBe('torn-existing')
  })

  it('written: no prior file at the id', () => {
    const r = writeOrReadMessage(dir, question())
    expect(r.outcome).toBe('written')
  })
})

describe('writeAck', () => {
  it('is idempotent: second write reports already-acked, never throws', () => {
    const ack = { id: 'q-run1-step', by: { role: 'pilot' as const, id: 'p1' }, at: AT }
    expect(writeAck(dir, ack).outcome).toBe('written')
    expect(writeAck(dir, ack).outcome).toBe('already-acked')
  })
})

describe('claimSettlement', () => {
  it('exactly-once: second claim on the same message reports already-settled', () => {
    const q = question()
    writeMessage(dir, q)
    const first = claimSettlement(dir, q, { by: { role: 'agent', id: 'agent-1' }, at: AT, mode: 'default-timeout', outcome: 'opt-a' })
    expect(first.outcome).toBe('settled')
    const second = claimSettlement(dir, q, { by: { role: 'agent', id: 'agent-1' }, at: AT2, mode: 'default-timeout', outcome: 'opt-a' })
    expect(second.outcome).toBe('already-settled')
  })

  it('invalid-claim: wrong role for mode "decision" (agent instead of pilot) -> writes NOTHING', () => {
    const q = question()
    writeMessage(dir, q)
    const r = claimSettlement(dir, q, { by: { role: 'agent', id: 'agent-1' }, at: AT, mode: 'decision', outcome: 'opt-a' })
    expect(r.outcome).toBe('invalid-claim')
    expect(readSettlement(dir, q.id).ok).toBe(false)
  })

  it('invalid-claim: outcome not among the question\'s options -> writes NOTHING', () => {
    const q = question()
    writeMessage(dir, q)
    const r = claimSettlement(dir, q, { by: { role: 'pilot', id: 'p1' }, at: AT, mode: 'decision', outcome: 'opt-z' })
    expect(r.outcome).toBe('invalid-claim')
    expect(readSettlement(dir, q.id).ok).toBe(false)
  })

  it('invalid-claim: default-timeout outcome differs from defaultOptionId -> writes NOTHING', () => {
    const q = question()
    writeMessage(dir, q)
    const r = claimSettlement(dir, q, { by: { role: 'agent', id: 'agent-1' }, at: AT, mode: 'default-timeout', outcome: 'opt-b' })
    expect(r.outcome).toBe('invalid-claim')
    expect(readSettlement(dir, q.id).ok).toBe(false)
  })
})

describe('readSettlement (tolerant)', () => {
  it('not-found for a missing marker', () => {
    const r = readSettlement(dir, 'q-nope')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not-found')
  })

  it('malformed for garbage bytes at the marker path', () => {
    writeFileSync(consumedPath(dir, 'q-run1-step'), 'not json {{{', { flag: 'wx', mode: 0o600 })
    const r = readSettlement(dir, 'q-run1-step')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('malformed')
  })

  it('reads back a genuinely written settlement', () => {
    const q = question()
    writeMessage(dir, q)
    claimSettlement(dir, q, { by: { role: 'pilot', id: 'p1' }, at: AT, mode: 'decision', outcome: 'opt-a' })
    const r = readSettlement(dir, q.id)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.settlement.outcome).toBe('opt-a')
  })
})

describe('readMessage', () => {
  it('not-found for a missing message', () => {
    const r = readMessage(dir, 'q-nope')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not-found')
  })

  it('reads back a written message', () => {
    writeMessage(dir, question())
    const r = readMessage(dir, 'q-run1-step')
    expect(r.ok).toBe(true)
  })

  it('malformed for garbage bytes', () => {
    writeFileSync(messagePath(dir, 'q-run1-step'), 'garbage {{{', { flag: 'wx', mode: 0o600 })
    const r = readMessage(dir, 'q-run1-step')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('malformed')
  })
})

describe('listMessages', () => {
  it('skips dotfiles, foreign families, and garbage; filters by type/to', () => {
    writeMessage(dir, question({ id: 'q-run1-a' }))
    writeMessage(dir, question({ id: 'q-run1-b', to: { role: 'agent', id: 'agent-9' } }))
    writeMessage(dir, digest({ id: 'd-run1-1' }))
    writeAck(dir, { id: 'q-run1-a', by: { role: 'pilot', id: 'p1' }, at: AT }) // foreign family (ack-)
    writeFileSync(join(dir, '.hidden.json'), '{"not":"a message"}') // dotfile
    writeFileSync(messagePath(dir, 'q-garbage'), 'not json {{{', { flag: 'wx', mode: 0o600 }) // garbage
    writeFileSync(join(dir, 'random.txt'), 'hello') // foreign extension

    const all = listMessages(dir)
    expect(all.length).toBe(3)

    const questions = listMessages(dir, { type: 'escalation.question' })
    expect(questions.length).toBe(2)

    const toPilot = listMessages(dir, { to: { role: 'pilot' } })
    expect(toPilot.length).toBe(2) // q-run1-a (to pilot) + d-run1-1 (to pilot)
  })

  it('returns [] for a directory that does not exist', () => {
    expect(listMessages(join(dir, 'does-not-exist'))).toEqual([])
  })
})

describe('respondToQuestion', () => {
  it('happy path: writes the decision and settles it', async () => {
    const q = question()
    writeMessage(dir, q)
    const r = respondToQuestion(dir, q, { by: { role: 'pilot', id: 'p1' }, decision: 'opt-a', at: AT })
    expect(r.outcome).toBe('settled')
    if ('settlement' in r) expect(r.settlement.outcome).toBe('opt-a')

    const decisionRead = readMessage(dir, decisionIdFor(q.id))
    expect(decisionRead.ok).toBe(true)
    if (decisionRead.ok) expect((decisionRead.message as DecisionMessage).payload.decision).toBe('opt-a')
  })

  it('already-settled short-circuit: does NOT write a decision when the marker already exists', () => {
    const q = question()
    writeMessage(dir, q)
    claimSettlement(dir, q, { by: { role: 'agent', id: 'agent-1' }, at: AT, mode: 'default-timeout', outcome: 'opt-a' })

    const r = respondToQuestion(dir, q, { by: { role: 'pilot', id: 'p1' }, decision: 'opt-b', at: AT2 })
    expect(r.outcome).toBe('already-settled')
    if ('settlement' in r) expect(r.settlement.mode).toBe('default-timeout')

    const decisionRead = readMessage(dir, decisionIdFor(q.id))
    expect(decisionRead.ok).toBe(false) // never written — the short-circuit happened before the write
  })

  it('crash-window: a decision is written, then a default-timeout claim wins the race -> decision stays readable, settlement outcome is the racer\'s', () => {
    const q = question()
    writeMessage(dir, q)

    // Simulate respondToQuestion's own internal decision write (step 2)...
    const decisionMessage: DecisionMessage = {
      schemaVersion: 1,
      id: decisionIdFor(q.id),
      type: 'decision.response',
      from: { role: 'pilot', id: 'p1' },
      to: { role: 'agent', id: 'agent-1' },
      runId: 'run1',
      at: AT,
      inReplyTo: q.id,
      payload: { decision: 'opt-b' },
    }
    const writeResult = writeOrReadMessage(dir, decisionMessage)
    expect(writeResult.outcome).toBe('written')

    // ...then, BEFORE the claim (step 3), a racing asker's default-timeout wins. A
    // default-timeout claim's outcome MUST equal the question's own defaultOptionId
    // ('opt-a') — it is not an arbitrary value.
    const racer = claimSettlement(dir, q, { by: { role: 'agent', id: 'agent-1' }, at: AT2, mode: 'default-timeout', outcome: 'opt-a' })
    expect(racer.outcome).toBe('settled')

    // The pilot's own claim attempt (for its 'opt-b' decision) now loses the race.
    const pilotClaim = claimSettlement(dir, q, { by: { role: 'pilot', id: 'p1' }, at: AT, mode: 'decision', outcome: 'opt-b' })
    expect(pilotClaim.outcome).toBe('already-settled')

    // The decision stays readable (advisory)...
    const decisionRead = readMessage(dir, decisionIdFor(q.id))
    expect(decisionRead.ok).toBe(true)

    // ...but the AUTHORITATIVE outcome is the racer's, not the pilot's decision.
    const settlement = readSettlement(dir, q.id)
    expect(settlement.ok).toBe(true)
    if (settlement.ok) {
      expect(settlement.settlement.mode).toBe('default-timeout')
      expect(settlement.settlement.outcome).toBe('opt-a')
    }

    // A later respondToQuestion call (e.g. a resumed pilot) short-circuits to the SAME outcome.
    const resumed = respondToQuestion(dir, q, { by: { role: 'pilot', id: 'p1' }, decision: 'opt-b', at: AT2 })
    expect(resumed.outcome).toBe('already-settled')
    if ('settlement' in resumed) expect(resumed.settlement.outcome).toBe('opt-a')
  })
})

describe('resume convergence', () => {
  it('two independent "runs" of the asker flow converge on the same settlement outcome', () => {
    const qRunA = question()
    const runA = writeOrReadMessage(dir, qRunA)
    expect(runA.outcome).toBe('written')
    const claimA = claimSettlement(dir, qRunA, { by: { role: 'agent', id: 'agent-1' }, at: AT, mode: 'default-timeout', outcome: 'opt-a' })
    expect(claimA.outcome).toBe('settled')

    // Run B: an independent "resumed" execution re-mints the SAME question (different
    // prose wording, as an LLM re-run would produce) and re-attempts the same flow.
    const qRunB = question({ payload: { ...qRunA.payload, question: 'A re-worded resumed-run question, twenty-plus chars long.' } })
    const runB = writeOrReadMessage(dir, qRunB)
    expect(runB.outcome).toBe('resumed-adopt-existing')
    const adopted = (runB as { message: QuestionMessage }).message
    const claimB = claimSettlement(dir, adopted, { by: { role: 'agent', id: 'agent-1' }, at: AT2, mode: 'default-timeout', outcome: 'opt-a' })
    expect(claimB.outcome).toBe('already-settled')

    const finalA = readSettlement(dir, qRunA.id)
    const finalB = readSettlement(dir, qRunB.id)
    expect(finalA.ok && finalB.ok).toBe(true)
    if (finalA.ok && finalB.ok) {
      expect(finalA.settlement.outcome).toBe(finalB.settlement.outcome)
      expect(finalA.settlement.at).toBe(finalB.settlement.at) // same marker, read twice
    }
  })
})
