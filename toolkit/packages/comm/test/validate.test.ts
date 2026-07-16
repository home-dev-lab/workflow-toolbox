import { describe, it, expect } from 'vitest'
import {
  parseMessage,
  validateDecisionAgainstQuestion,
  validateSettlement,
  parseAckMarker,
  parseSettlementMarker,
} from '../src/validate.js'
import { decisionIdFor } from '../src/ids.js'
import type { QuestionMessage, DecisionMessage, DigestMessage } from '../src/schemas.js'

const AT = '2026-07-16T10:00:00Z'
const AT_MS = '2026-07-16T10:00:00.123Z'

function baseQuestion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
  }
}

function baseDecision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'q-run1-step--decision',
    type: 'decision.response',
    from: { role: 'pilot', id: 'pilot-1' },
    to: { role: 'agent', id: 'agent-1' },
    runId: 'run1',
    at: AT,
    inReplyTo: 'q-run1-step',
    payload: { decision: 'opt-a' },
    ...overrides,
  }
}

function baseDigest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
  }
}

describe('parseMessage — escalation.question', () => {
  it('accepts a complete valid fixture', () => {
    const r = parseMessage(JSON.stringify(baseQuestion()))
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.message as QuestionMessage).payload.kind).toBe('no-test-seam')
  })

  it('accepts "at" with milliseconds', () => {
    const r = parseMessage(JSON.stringify(baseQuestion({ at: AT_MS })))
    expect(r.ok).toBe(true)
  })

  it.each(['kind', 'options', 'defaultOptionId', 'question'])('rejects missing required payload field %s', (field) => {
    const q = baseQuestion()
    const payload = { ...(q['payload'] as Record<string, unknown>) }
    delete payload[field]
    const r = parseMessage(JSON.stringify({ ...q, payload }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('malformed')
  })

  it.each(['schemaVersion', 'id', 'type', 'from', 'to', 'at', 'payload'])('rejects missing required envelope field %s', (field) => {
    const q = baseQuestion()
    delete q[field]
    const r = parseMessage(JSON.stringify(q))
    expect(r.ok).toBe(false)
  })

  it('rejects minLength junk (question too short)', () => {
    const q = baseQuestion()
    const payload = { ...(q['payload'] as Record<string, unknown>), question: 'too short' }
    const r = parseMessage(JSON.stringify({ ...q, payload }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('malformed')
  })

  it('rejects overlong question (over 2000 chars)', () => {
    const q = baseQuestion()
    const payload = { ...(q['payload'] as Record<string, unknown>), question: 'x'.repeat(2001) }
    const r = parseMessage(JSON.stringify({ ...q, payload }))
    expect(r.ok).toBe(false)
  })

  it('accepts unknown top-level and payload keys, DROPPING them from the typed result (reader posture)', () => {
    const q = baseQuestion()
    const withExtra = {
      ...q,
      futureTopLevelField: 'ignore-me',
      payload: { ...(q['payload'] as Record<string, unknown>), futurePayloadField: 'ignore-me-too' },
    }
    const r = parseMessage(JSON.stringify(withExtra))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.message).not.toHaveProperty('futureTopLevelField')
      expect((r.message as QuestionMessage).payload).not.toHaveProperty('futurePayloadField')
    }
  })

  it('schemaVersion 2 -> unsupported-version', () => {
    const r = parseMessage(JSON.stringify(baseQuestion({ schemaVersion: 2 })))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('unsupported-version')
  })

  it('schemaVersion "1" (string) -> malformed', () => {
    const r = parseMessage(JSON.stringify(baseQuestion({ schemaVersion: '1' })))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('malformed')
  })

  it('schemaVersion absent -> malformed', () => {
    const q = baseQuestion()
    delete q['schemaVersion']
    const r = parseMessage(JSON.stringify(q))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('malformed')
  })

  it('inReplyTo present on a question -> reject (forbidden on this type)', () => {
    const r = parseMessage(JSON.stringify(baseQuestion({ inReplyTo: 'q-run1-step' })))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('malformed')
  })

  it('defaultOptionId not among options -> invalid', () => {
    const q = baseQuestion()
    const payload = { ...(q['payload'] as Record<string, unknown>), defaultOptionId: 'not-an-option' }
    const r = parseMessage(JSON.stringify({ ...q, payload }))
    expect(r.ok).toBe(false)
  })

  it('"at" with a non-Zulu offset is rejected', () => {
    const r = parseMessage(JSON.stringify(baseQuestion({ at: '2026-07-16T10:00:00+02:00' })))
    expect(r.ok).toBe(false)
  })

  it('"at" date-only is rejected', () => {
    const r = parseMessage(JSON.stringify(baseQuestion({ at: '2026-07-16' })))
    expect(r.ok).toBe(false)
  })
})

describe('parseMessage — decision.response', () => {
  it('accepts a complete valid fixture', () => {
    const r = parseMessage(JSON.stringify(baseDecision()))
    expect(r.ok).toBe(true)
  })

  it('missing inReplyTo on a decision -> reject', () => {
    const d = baseDecision()
    delete d['inReplyTo']
    const r = parseMessage(JSON.stringify(d))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('malformed')
  })

  it('rejects a decision id with two "--" occurrences (exactly-one invariant, not just the regex)', () => {
    const r = parseMessage(JSON.stringify(baseDecision({ id: 'q-run1--step--decision', inReplyTo: 'q-run1--step' })))
    expect(r.ok).toBe(false)
  })
})

describe('parseMessage — status.digest', () => {
  it('accepts a complete valid fixture', () => {
    const r = parseMessage(JSON.stringify(baseDigest()))
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.message as DigestMessage).payload.seq).toBe(1)
  })

  it('rejects a summary under the 10-char floor', () => {
    const d = baseDigest()
    const payload = { ...(d['payload'] as Record<string, unknown>), summary: 'short' }
    const r = parseMessage(JSON.stringify({ ...d, payload }))
    expect(r.ok).toBe(false)
  })

  it('inReplyTo present on a digest -> reject', () => {
    const r = parseMessage(JSON.stringify(baseDigest({ inReplyTo: 'q-run1-step' })))
    expect(r.ok).toBe(false)
  })
})

describe('provenance matrix (role x type)', () => {
  it('agent may write escalation.question', () => {
    expect(parseMessage(JSON.stringify(baseQuestion())).ok).toBe(true)
  })
  it('agent may write status.digest', () => {
    expect(parseMessage(JSON.stringify(baseDigest())).ok).toBe(true)
  })
  it('agent may NOT write decision.response', () => {
    const r = parseMessage(JSON.stringify(baseDecision({ from: { role: 'agent', id: 'agent-1' } })))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('provenance')
  })
  it('pilot may write decision.response', () => {
    expect(parseMessage(JSON.stringify(baseDecision())).ok).toBe(true)
  })
  it('pilot may NOT write escalation.question', () => {
    const r = parseMessage(JSON.stringify(baseQuestion({ from: { role: 'pilot', id: 'pilot-1' } })))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('provenance')
  })
  it('pilot may NOT write status.digest', () => {
    const r = parseMessage(JSON.stringify(baseDigest({ from: { role: 'pilot', id: 'pilot-1' } })))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('provenance')
  })
})

describe('validateDecisionAgainstQuestion', () => {
  it('accepts a well-formed decision for its question', () => {
    const qr = parseMessage(JSON.stringify(baseQuestion()))
    const dr = parseMessage(JSON.stringify(baseDecision()))
    expect(qr.ok && dr.ok).toBe(true)
    if (qr.ok && dr.ok) {
      expect(validateDecisionAgainstQuestion(qr.message as QuestionMessage, dr.message as DecisionMessage)).toBe(true)
    }
  })

  it('rejects a decision whose id does not equal decisionIdFor(question.id)', () => {
    const qr = parseMessage(JSON.stringify(baseQuestion()))
    const dr = parseMessage(JSON.stringify(baseDecision({ id: decisionIdFor('some-other-qid'), inReplyTo: 'some-other-qid' })))
    expect(qr.ok && dr.ok).toBe(true)
    if (qr.ok && dr.ok) {
      expect(validateDecisionAgainstQuestion(qr.message as QuestionMessage, dr.message as DecisionMessage)).toBe(false)
    }
  })

  it('rejects a decision whose option id is not among the question options (byte equality)', () => {
    const qr = parseMessage(JSON.stringify(baseQuestion()))
    const dr = parseMessage(JSON.stringify(baseDecision({ payload: { decision: 'opt-z' } })))
    expect(qr.ok).toBe(true)
    // opt-z would already fail schema (pattern ok, but semantic membership not checked at
    // parse-time for a decision — this is exactly validateDecisionAgainstQuestion's job).
    expect(dr.ok).toBe(true)
    if (qr.ok && dr.ok) {
      expect(validateDecisionAgainstQuestion(qr.message as QuestionMessage, dr.message as DecisionMessage)).toBe(false)
    }
  })
})

describe('validateSettlement (coherence matrix — mirrors claimSettlement preconditions)', () => {
  it('mode "decision" by pilot with outcome in options -> coherent', () => {
    const qr = parseMessage(JSON.stringify(baseQuestion()))
    expect(qr.ok).toBe(true)
    if (qr.ok) {
      expect(validateSettlement(qr.message, { by: { role: 'pilot', id: 'p1' }, at: AT, mode: 'decision', outcome: 'opt-a' })).toBe(true)
    }
  })

  it('mode "decision" by agent -> incoherent (wrong role)', () => {
    const qr = parseMessage(JSON.stringify(baseQuestion()))
    if (qr.ok) {
      expect(validateSettlement(qr.message, { by: { role: 'agent', id: 'a1' }, at: AT, mode: 'decision', outcome: 'opt-a' })).toBe(false)
    }
  })

  it('mode "decision" with outcome not in options -> incoherent', () => {
    const qr = parseMessage(JSON.stringify(baseQuestion()))
    if (qr.ok) {
      expect(validateSettlement(qr.message, { by: { role: 'pilot', id: 'p1' }, at: AT, mode: 'decision', outcome: 'opt-z' })).toBe(false)
    }
  })

  it('mode "default-timeout" by agent with outcome === defaultOptionId -> coherent', () => {
    const qr = parseMessage(JSON.stringify(baseQuestion()))
    if (qr.ok) {
      expect(validateSettlement(qr.message, { by: { role: 'agent', id: 'a1' }, at: AT, mode: 'default-timeout', outcome: 'opt-a' })).toBe(true)
    }
  })

  it('mode "default-timeout" by pilot -> incoherent (wrong role)', () => {
    const qr = parseMessage(JSON.stringify(baseQuestion()))
    if (qr.ok) {
      expect(validateSettlement(qr.message, { by: { role: 'pilot', id: 'p1' }, at: AT, mode: 'default-timeout', outcome: 'opt-a' })).toBe(false)
    }
  })

  it('mode "default-timeout" with outcome != defaultOptionId -> incoherent', () => {
    const qr = parseMessage(JSON.stringify(baseQuestion()))
    if (qr.ok) {
      expect(validateSettlement(qr.message, { by: { role: 'agent', id: 'a1' }, at: AT, mode: 'default-timeout', outcome: 'opt-b' })).toBe(false)
    }
  })

  it('mode "read" by the message recipient role -> coherent', () => {
    const dgr = parseMessage(JSON.stringify(baseDigest()))
    if (dgr.ok) {
      expect(validateSettlement(dgr.message, { by: { role: 'pilot', id: 'p1' }, at: AT, mode: 'read' })).toBe(true)
    }
  })

  it('mode "read" by a role other than the recipient -> incoherent', () => {
    const dgr = parseMessage(JSON.stringify(baseDigest()))
    if (dgr.ok) {
      expect(validateSettlement(dgr.message, { by: { role: 'agent', id: 'a1' }, at: AT, mode: 'read' })).toBe(false)
    }
  })

  it('mode "decision"/"default-timeout" against a digest (not a question) -> incoherent', () => {
    const dgr = parseMessage(JSON.stringify(baseDigest()))
    if (dgr.ok) {
      expect(validateSettlement(dgr.message, { by: { role: 'pilot', id: 'p1' }, at: AT, mode: 'decision', outcome: 'opt-a' })).toBe(false)
    }
  })
})

describe('parseAckMarker / parseSettlementMarker (tolerant)', () => {
  it('parses a valid ack marker', () => {
    const ack = parseAckMarker(JSON.stringify({ id: 'q-run1-step', by: { role: 'pilot', id: 'p1' }, at: AT }))
    expect(ack).not.toBeNull()
  })

  it('returns null for garbage', () => {
    expect(parseAckMarker('not json')).toBeNull()
    expect(parseAckMarker('{}')).toBeNull()
  })

  it('parses a valid settlement marker', () => {
    const s = parseSettlementMarker(JSON.stringify({ id: 'q-run1-step', by: { role: 'agent', id: 'a1' }, at: AT, mode: 'default-timeout', outcome: 'opt-a' }))
    expect(s).not.toBeNull()
  })

  it('returns null for an invalid mode', () => {
    const s = parseSettlementMarker(JSON.stringify({ id: 'q-run1-step', by: { role: 'agent', id: 'a1' }, at: AT, mode: 'bogus' }))
    expect(s).toBeNull()
  })
})
