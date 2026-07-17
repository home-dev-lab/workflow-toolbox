import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { HINT_MESSAGE_SCHEMA, WT_COMM_SCHEMAS, SETTLEMENT_MARKER_SCHEMA } from '../src/schemas.js'
import { MSG_PREFIX, CONSUMED_PREFIX } from '../src/paths.js'

// Drift-lock: teaching/wt-comm-observer-consumer.md (the OBSERVED-role brief, v0.2)
// cites protocol literals and one bound verbatim — it teaches shell-level consumers who
// have no access to the schema consts. Same posture as teaching-drift-lock.test.ts: a
// change on EITHER side (schemas.ts/paths.ts, or the brief's prose) must fail here;
// unrelated wording drift around the anchors must not.

const here = dirname(fileURLToPath(import.meta.url))
const brief = readFileSync(join(here, '../teaching/wt-comm-observer-consumer.md'), 'utf8')

describe('observer-consumer teaching drift-lock', () => {
  it('cites the observer.hint type string, which the schema map registers', () => {
    expect(brief.includes('observer.hint')).toBe(true)
    expect(Object.keys(WT_COMM_SCHEMAS)).toContain('observer.hint')
  })

  it('cites the hint bounds 20-2000 matching the schema const', () => {
    const m = brief.match(/`hint`\s*field is\s*(\d+)[^\d\n]+(\d+)\s*chars/)
    expect(m).not.toBeNull()
    const props = HINT_MESSAGE_SCHEMA.properties.payload.properties
    expect(Number(m![1])).toBe(props.hint.minLength)
    expect(Number(m![2])).toBe(props.hint.maxLength)
    expect([Number(m![1]), Number(m![2])]).toEqual([20, 2000])
  })

  it('cites the msg- and consumed- filename families', () => {
    expect(brief.includes('msg-')).toBe(true)
    expect(MSG_PREFIX).toBe('msg-')
    expect(brief.includes('consumed-')).toBe(true)
    expect(CONSUMED_PREFIX).toBe('consumed-')
  })

  it('cites the "read" settlement mode the marker schema accepts', () => {
    expect(brief.includes('"mode":"read"')).toBe(true)
    expect(SETTLEMENT_MARKER_SCHEMA.properties.mode.enum).toContain('read')
  })

  it('cites the provenance field the hint schema REQUIRES', () => {
    expect(brief.includes('provenance')).toBe(true)
    expect(HINT_MESSAGE_SCHEMA.properties.payload.required).toContain('provenance')
  })

  it('carries the hint-is-data conduct rule and the no-clobber recipe', () => {
    expect(brief).toMatch(/INFORMS; it never instructs/)
    expect(brief.includes('`set -C`') || brief.includes('set -C;')).toBe(true)
  })
})
