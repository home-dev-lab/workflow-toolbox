import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { BASE_ID_PATTERN, DECISION_ID_PATTERN, OPTION_ID_PATTERN, QUESTION_MESSAGE_SCHEMA, DIGEST_MESSAGE_SCHEMA, SETTLEMENT_MARKER_SCHEMA } from '../src/schemas.js'
import { CONSUMED_PREFIX } from '../src/paths.js'

// Drift-lock: teaching/wt-comm-participant.md cites several id-grammar/bound NUMBERS
// verbatim (it teaches shell participants who have no access to the schema consts). This
// suite anchors on the doc's own backticked field names to re-extract those cited numbers
// and cross-checks them against the SAME schema consts the library enforces at runtime —
// a bound change on EITHER side (schemas.ts, or the doc's prose) must fail this suite;
// unrelated wording drift around the anchors must not.

const here = dirname(fileURLToPath(import.meta.url))
const teaching = readFileSync(join(here, '../teaching/wt-comm-participant.md'), 'utf8')

const questionPayload = QUESTION_MESSAGE_SCHEMA.properties.payload.properties
const optionProps = questionPayload.options.items.properties
const digestPayload = DIGEST_MESSAGE_SCHEMA.properties.payload.properties

describe('teaching-pack drift-lock', () => {
  it('cites the base id regex + the 96-char cap', () => {
    const m = teaching.match(/Ids match `([^`]+)`\s*\(max (\d+) chars\)/)
    expect(m).not.toBeNull()
    // Strip the cited pattern's leading "^" before the substring check: our real
    // BASE_ID_PATTERN additionally anchors on a negative lookahead (`^(?!.*--)...`), so the
    // teaching-cited "^[a-z0-9]..." is a SUFFIX of the real pattern, not a literal substring
    // starting at "^" (which occurs only once, followed by the lookahead).
    expect(BASE_ID_PATTERN.source).toContain(m![1]!.slice(1))
    expect(Number(m![2])).toBe(QUESTION_MESSAGE_SCHEMA.properties.id.maxLength)
    expect(Number(m![2])).toBe(96)
  })

  it('cites "--" (backticked) as forbidden in a base id — the decision-suffix separator', () => {
    expect(teaching.includes('`--`')).toBe(true)
  })

  it('cites the "--decision" suffix', () => {
    expect(teaching.includes('--decision')).toBe(true)
    expect(DECISION_ID_PATTERN.source).toContain('--decision')
  })

  it('cites `kind` bounds 1-64', () => {
    const m = teaching.match(/`kind`\s*(\d+)[^\d\n]+(\d+)\s*chars/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(questionPayload.kind.minLength)
    expect(Number(m![2])).toBe(questionPayload.kind.maxLength)
    expect([Number(m![1]), Number(m![2])]).toEqual([1, 64])
  })

  it('cites the options array bounds 2-8', () => {
    const m = teaching.match(/(\d+)[^\d\n]+(\d+)\s*`options`/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(questionPayload.options.minItems)
    expect(Number(m![2])).toBe(questionPayload.options.maxItems)
    expect([Number(m![1]), Number(m![2])]).toEqual([2, 8])
  })

  it('cites the option id regex verbatim', () => {
    const m = teaching.match(/`id`\s*`([^`]+)`/)
    expect(m).not.toBeNull()
    expect(m![1]).toBe(OPTION_ID_PATTERN.source)
  })

  it('cites `label` bounds 3-200', () => {
    const m = teaching.match(/`label`\s*(\d+)[^\d\n]+(\d+)/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(optionProps.label.minLength)
    expect(Number(m![2])).toBe(optionProps.label.maxLength)
    expect([Number(m![1]), Number(m![2])]).toEqual([3, 200])
  })

  it('cites `meaning` bound <=400', () => {
    const m = teaching.match(/`meaning`\s*[^\d\n]*(\d+)/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(optionProps.meaning.maxLength)
    expect(Number(m![1])).toBe(400)
  })

  it('cites `question` bounds 20-2000', () => {
    const m = teaching.match(/`question`\s*(\d+)[^\d\n]+(\d+)\s*chars/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(questionPayload.question.minLength)
    expect(Number(m![2])).toBe(questionPayload.question.maxLength)
    expect([Number(m![1]), Number(m![2])]).toEqual([20, 2000])
  })

  it('cites `evidence` bound <=2000', () => {
    const m = teaching.match(/`evidence`\s*[^\d\n]*(\d+)/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(questionPayload.evidence.maxLength)
    expect(Number(m![1])).toBe(2000)
  })

  it('cites `context` bound <=1000', () => {
    const m = teaching.match(/`context`\s*[^\d\n]*(\d+)/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(questionPayload.context.maxLength)
    expect(Number(m![1])).toBe(1000)
  })

  it('cites the digest `state` bounds 1-32', () => {
    const m = teaching.match(/"state"[^(\n]*\((\d+)[^\d\n]+(\d+)\)/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(digestPayload.state.minLength)
    expect(Number(m![2])).toBe(digestPayload.state.maxLength)
    expect([Number(m![1]), Number(m![2])]).toEqual([1, 32])
  })

  it('cites the digest `summary` bounds 10-1500', () => {
    const m = teaching.match(/"summary"[^<\n]*<(\d+)[^\d\n]+(\d+)\s*chars>/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(digestPayload.summary.minLength)
    expect(Number(m![2])).toBe(digestPayload.summary.maxLength)
    expect([Number(m![1]), Number(m![2])]).toEqual([10, 1500])
  })

  it('cites the `set -C` no-clobber recipe', () => {
    expect(teaching.includes('`set -C`')).toBe(true)
  })

  it('cites the "consumed-" settlement filename prefix', () => {
    expect(teaching.includes('consumed-')).toBe(true)
    expect(CONSUMED_PREFIX).toBe('consumed-')
  })

  it('cites the "default-timeout" settlement mode', () => {
    expect(teaching.includes('default-timeout')).toBe(true)
    expect(SETTLEMENT_MARKER_SCHEMA.properties.mode.enum).toContain('default-timeout')
  })
})
