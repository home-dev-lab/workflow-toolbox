import { describe, it, expect } from 'vitest'
import {
  assertSafeMessageId,
  decisionIdFor,
  retryIdFor,
  mintQuestionId,
  mintDigestId,
  mintHintId,
  isValidDecisionId,
  fold,
  fnv1a32,
} from '../src/ids.js'
import { BASE_ID_PATTERN, DECISION_ID_PATTERN, HINT_ID_PATTERN } from '../src/schemas.js'

describe('BASE_ID_PATTERN grammar', () => {
  it('accepts a well-formed lowercase base id', () => {
    expect(BASE_ID_PATTERN.test('q-run1-step-2')).toBe(true)
    expect(BASE_ID_PATTERN.test('a')).toBe(true)
  })

  it('rejects uppercase', () => {
    expect(BASE_ID_PATTERN.test('Q-run1')).toBe(false)
  })

  it('rejects a leading dash', () => {
    expect(BASE_ID_PATTERN.test('-q-run1')).toBe(false)
  })

  it('rejects "--" anywhere in a base id', () => {
    expect(BASE_ID_PATTERN.test('q--run1')).toBe(false)
  })

  it('rejects path separators', () => {
    expect(BASE_ID_PATTERN.test('q/run1')).toBe(false)
    expect(BASE_ID_PATTERN.test('q\\run1')).toBe(false)
  })

  it('rejects ".."', () => {
    expect(BASE_ID_PATTERN.test('q..run1')).toBe(false)
  })

  it('rejects 97+ chars (over the 96 cap)', () => {
    expect(BASE_ID_PATTERN.test('a'.repeat(96))).toBe(true)
    expect(BASE_ID_PATTERN.test('a'.repeat(97))).toBe(false)
  })

  it('rejects the empty string', () => {
    expect(BASE_ID_PATTERN.test('')).toBe(false)
  })
})

describe('DECISION_ID_PATTERN + isValidDecisionId', () => {
  it('accepts a well-formed decision id', () => {
    expect(DECISION_ID_PATTERN.test('q-run1--decision')).toBe(true)
    expect(isValidDecisionId('q-run1--decision')).toBe(true)
  })

  it('rejects a decision id missing the suffix', () => {
    expect(DECISION_ID_PATTERN.test('q-run1')).toBe(false)
    expect(isValidDecisionId('q-run1')).toBe(false)
  })

  it('regex alone accepts a base containing "--" before the suffix, but isValidDecisionId rejects it (exactly-one-"--" invariant)', () => {
    expect(DECISION_ID_PATTERN.test('ab--cd--decision')).toBe(true)
    expect(isValidDecisionId('ab--cd--decision')).toBe(false)
  })
})

describe('assertSafeMessageId', () => {
  it('accepts a normal id', () => {
    expect(() => assertSafeMessageId('q-run1-step')).not.toThrow()
  })

  it('rejects empty', () => {
    expect(() => assertSafeMessageId('')).toThrow()
  })

  it('rejects a slash', () => {
    expect(() => assertSafeMessageId('a/b')).toThrow()
  })

  it('rejects a backslash', () => {
    expect(() => assertSafeMessageId('a\\b')).toThrow()
  })

  it('rejects ".."', () => {
    expect(() => assertSafeMessageId('a..b')).toThrow()
  })

  it('rejects 129 chars (over the 128 cap)', () => {
    expect(() => assertSafeMessageId('a'.repeat(129))).toThrow()
    expect(() => assertSafeMessageId('a'.repeat(128))).not.toThrow()
  })
})

describe('decisionIdFor', () => {
  it('appends the verbatim "--decision" suffix', () => {
    expect(decisionIdFor('q-run1-step')).toBe('q-run1-step--decision')
  })

  it('round-trips: decisionIdFor(qid) is always a valid decision id for a valid base qid', () => {
    const qid = 'q-abc-123'
    const did = decisionIdFor(qid)
    expect(DECISION_ID_PATTERN.test(did)).toBe(true)
    expect(isValidDecisionId(did)).toBe(true)
  })
})

describe('retryIdFor', () => {
  it('appends "-r<k>"', () => {
    expect(retryIdFor('q-run1', 1)).toBe('q-run1-r1')
    expect(retryIdFor('q-run1', 2)).toBe('q-run1-r2')
  })
})

describe('fold', () => {
  it('lowercases and folds non-alnum runs to a single dash, trimmed', () => {
    expect(fold('WF_ab-cd')).toBe('wf-ab-cd')
    expect(fold('  a   b  ')).toBe('a-b')
    expect(fold('---')).toBe('')
  })
})

describe('fnv1a32', () => {
  it('is deterministic', () => {
    expect(fnv1a32('hello')).toBe(fnv1a32('hello'))
  })

  it('differs for different inputs (not guaranteed in general, but true for these)', () => {
    expect(fnv1a32('hello')).not.toBe(fnv1a32('world'))
  })
})

describe('mintQuestionId', () => {
  it('is deterministic: same inputs -> same id', () => {
    expect(mintQuestionId('wf_run-1', 'no-test-seam')).toBe(mintQuestionId('wf_run-1', 'no-test-seam'))
  })

  it('always matches the base id pattern', () => {
    const id = mintQuestionId('WF_run.1!!', 'some step')
    expect(BASE_ID_PATTERN.test(id)).toBe(true)
  })

  it('is always <= 90 chars (leaves room for a retry suffix)', () => {
    const id = mintQuestionId('x'.repeat(500), 'y'.repeat(500))
    expect(id.length).toBeLessThanOrEqual(90)
    expect(BASE_ID_PATTERN.test(id)).toBe(true)
  })

  it('injectivity: runIds differing only by case/punctuation mint DIFFERENT ids', () => {
    const a = mintQuestionId('wf_ab-cd', 'step')
    const b = mintQuestionId('wf-ab.cd', 'step')
    expect(a).not.toBe(b)
  })

  it('handles a runId/stepKey that folds to empty without producing "--" or an invalid id', () => {
    const id = mintQuestionId('---', '///')
    expect(BASE_ID_PATTERN.test(id)).toBe(true)
    expect(id.includes('--')).toBe(false)
  })
})

describe('mintDigestId', () => {
  it('is deterministic and matches the base id pattern', () => {
    const a = mintDigestId('wf_run-1', 3)
    const b = mintDigestId('wf_run-1', 3)
    expect(a).toBe(b)
    expect(BASE_ID_PATTERN.test(a)).toBe(true)
  })

  it('differs per seq', () => {
    expect(mintDigestId('wf_run-1', 1)).not.toBe(mintDigestId('wf_run-1', 2))
  })

  it('never produces "--" even for a degenerate non-finite/negative seq', () => {
    const id = mintDigestId('wf_run-1', -5)
    expect(BASE_ID_PATTERN.test(id)).toBe(true)
    expect(id.includes('--')).toBe(false)
  })

  // TEST-LOCK (card #1821947458553382634): a seq >= 1e21 stringifies in EXPONENTIAL
  // notation ("1e+21"), injecting a '+' into the id and breaking BASE_ID_PATTERN. safeSeq
  // must clamp the upper bound to Number.MAX_SAFE_INTEGER (16 plain digits) so any extreme
  // seq stays grammar-conformant. Fails before the clamp, passes after.
  it('clamps an extreme seq (>= 1e21) to Number.MAX_SAFE_INTEGER, staying pattern-conformant', () => {
    const id = mintDigestId('wf_run-1', 1e21)
    expect(BASE_ID_PATTERN.test(id)).toBe(true)
    expect(id.endsWith(`-${Number.MAX_SAFE_INTEGER}`)).toBe(true)
    expect(mintDigestId('wf_run-1', Number.MAX_VALUE)).toBe(id)
  })

  it('is deterministic for an extreme seq (same input -> same id) — crash-rewind stability', () => {
    expect(mintDigestId('wf_run-1', 1e21)).toBe(mintDigestId('wf_run-1', 1e21))
  })

  it('leaves an in-range seq byte-identical (clamp is a no-op below MAX_SAFE_INTEGER)', () => {
    expect(mintDigestId('wf_run-1', 3)).toBe('d-wf-run-1-a96e8604-3')
  })
})

describe('mintHintId', () => {
  it('is deterministic and matches the hint id pattern', () => {
    const a = mintHintId('wf_run-1', 'obs', 3)
    expect(a).toBe(mintHintId('wf_run-1', 'obs', 3))
    expect(HINT_ID_PATTERN.test(a)).toBe(true)
  })

  // TEST-LOCK (card #1821947458553382634): assertSafeMessageId does NOT reject '+', so a
  // buggy exponential-notation seq would pass the filesystem guard yet violate
  // HINT_ID_PATTERN. Lock both the 3-arg and 4-arg (widest) forms.
  it('clamps an extreme seq to MAX_SAFE_INTEGER in the 3-arg and 4-arg forms', () => {
    const id3 = mintHintId('wf_run-1', 'obs', 1e21)
    expect(HINT_ID_PATTERN.test(id3)).toBe(true)
    expect(id3.endsWith(`-${Number.MAX_SAFE_INTEGER}`)).toBe(true)

    const id4 = mintHintId('wf_run-1', 'obs', 1e21, 'agent-x')
    expect(HINT_ID_PATTERN.test(id4)).toBe(true)
    expect(id4.endsWith(`-${Number.MAX_SAFE_INTEGER}`)).toBe(true)
  })
})
