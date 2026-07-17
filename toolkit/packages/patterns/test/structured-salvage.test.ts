// structured-salvage.test.ts — TEST-LOCK for card #1820561035728258107: the
// harness's StructuredOutput retry loop exhausts without forcing schema
// conformity (lived on pr-review: 5 identical failures — summary over its
// bound + required riskAreas omitted — then a bare null). These tests lock the
// toolkit-side answer: schema-derived constraint prose, a subset validator
// whose violations are SPECIFIC (field + bound + received), deterministic
// repair that never fabricates, and the salvage wrapper that turns the
// silent null into either a validated value or actionable diagnostics.

import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import {
  describeSchemaConstraints,
  extractJsonObject,
  validateAgainstSchema,
  repairToSchema,
  agentWithSchemaSalvage,
} from '../src/structured-salvage.js'

// The exact shape that failed live (pr-review's change-summary schema, reduced).
const CHANGE_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', minLength: 12, maxLength: 100 },
    riskAreas: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 5 },
  },
  required: ['summary', 'riskAreas'],
  additionalProperties: false,
}

// ---------------------------------------------------------------------------
// describeSchemaConstraints
// ---------------------------------------------------------------------------

describe('describeSchemaConstraints', () => {
  it('states every property with requiredness and exact bounds', () => {
    const text = describeSchemaConstraints(CHANGE_SUMMARY_SCHEMA)
    expect(text).toContain('"summary" (REQUIRED): string, 12-100 chars')
    expect(text).toContain('"riskAreas" (REQUIRED): array, at most 5 items, each item: string, at most 40 chars')
    expect(text).toContain('No other properties are allowed.')
  })

  it('states enums verbatim', () => {
    const text = describeSchemaConstraints({
      type: 'object',
      properties: { verdict: { type: 'string', enum: ['confirmed', 'refuted'] } },
      required: ['verdict'],
    })
    expect(text).toContain('"verdict" (REQUIRED): one of: "confirmed" | "refuted"')
  })

  it('returns empty for an unconstrained schema', () => {
    expect(describeSchemaConstraints({})).toBe('')
  })

  it('recurses into array-of-object items — inner fields and bounds are stated (bundle review, medium)', () => {
    const text = describeSchemaConstraints({
      type: 'object',
      properties: {
        scores: {
          type: 'array',
          maxItems: 200,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', maxLength: 120 },
              score: { type: 'integer' },
            },
            required: ['id', 'score'],
            additionalProperties: false,
          },
        },
      },
      required: ['scores'],
    })
    expect(text).toContain('at most 200 items')
    expect(text).toContain('"id" (REQUIRED): string, at most 120 chars')
    expect(text).toContain('"score" (REQUIRED): integer')
  })
})

// ---------------------------------------------------------------------------
// extractJsonObject
// ---------------------------------------------------------------------------

describe('extractJsonObject', () => {
  it('parses a bare object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 })
  })

  it('parses a fenced object', () => {
    expect(extractJsonObject('Here you go:\n```json\n{"a":1}\n```\nthanks')).toEqual({ a: 1 })
  })

  it('parses an object embedded in prose', () => {
    expect(extractJsonObject('Sure! {"a": {"b": 2}} — done.')).toEqual({ a: { b: 2 } })
  })

  it('rejects arrays, scalars, and junk', () => {
    expect(extractJsonObject('[1,2]')).toBeUndefined()
    expect(extractJsonObject('42')).toBeUndefined()
    expect(extractJsonObject('no json here')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// validateAgainstSchema — violations are SPECIFIC (field + bound + received)
// ---------------------------------------------------------------------------

describe('validateAgainstSchema', () => {
  it('accepts a conforming value', () => {
    expect(
      validateAgainstSchema({ summary: 'a real, long-enough summary', riskAreas: ['x'] }, CHANGE_SUMMARY_SCHEMA),
    ).toEqual([])
  })

  it('names the field, the bound, and the received length on maxLength', () => {
    const v = validateAgainstSchema({ summary: 'y'.repeat(140), riskAreas: [] }, CHANGE_SUMMARY_SCHEMA)
    expect(v).toEqual([{ path: '$.summary', message: '140 chars exceeds maxLength 100' }])
  })

  it('flags a missing required property by path — the lived riskAreas omission', () => {
    const v = validateAgainstSchema({ summary: 'a real, long-enough summary' }, CHANGE_SUMMARY_SCHEMA)
    expect(v).toEqual([{ path: '$.riskAreas', message: 'required property missing' }])
  })

  it('flags unexpected properties, wrong types, enum misses, and nested item bounds', () => {
    expect(validateAgainstSchema({ summary: 'a real, long-enough summary', riskAreas: ['x'], extra: 1 }, CHANGE_SUMMARY_SCHEMA))
      .toEqual([{ path: '$.extra', message: 'unexpected property (additionalProperties: false)' }])
    expect(validateAgainstSchema({ summary: 7, riskAreas: [] }, CHANGE_SUMMARY_SCHEMA))
      .toEqual([{ path: '$.summary', message: 'expected string, got number' }])
    expect(validateAgainstSchema({ v: 'maybe' }, { type: 'object', properties: { v: { enum: ['yes', 'no'] } } }))
      .toEqual([{ path: '$.v', message: '"maybe" is not one of "yes" | "no"' }])
    expect(validateAgainstSchema(
      { summary: 'a real, long-enough summary', riskAreas: ['z'.repeat(50)] }, CHANGE_SUMMARY_SCHEMA))
      .toEqual([{ path: '$.riskAreas[0]', message: '50 chars exceeds maxLength 40' }])
  })

  it('flags minLength — junk one-word capitulations do not validate', () => {
    const v = validateAgainstSchema({ summary: 'test', riskAreas: ['a', 'b'] }, CHANGE_SUMMARY_SCHEMA)
    expect(v).toEqual([{ path: '$.summary', message: '4 chars under minLength 12' }])
  })
})

// ---------------------------------------------------------------------------
// repairToSchema — deterministic, never fabricates
// ---------------------------------------------------------------------------

describe('repairToSchema', () => {
  it('truncates over-maxLength strings and reports the exact repair', () => {
    const { value, repairs } = repairToSchema(
      { summary: 'y'.repeat(140), riskAreas: [] }, CHANGE_SUMMARY_SCHEMA)
    expect((value as { summary: string }).summary).toHaveLength(100)
    expect(repairs).toEqual(['$.summary: truncated from 140 to maxLength 100 chars'])
  })

  it('slices over-maxItems arrays and repairs nested items', () => {
    const { value, repairs } = repairToSchema(
      { summary: 'a real, long-enough summary', riskAreas: ['a'.repeat(60), 'b', 'c', 'd', 'e', 'f', 'g'] },
      CHANGE_SUMMARY_SCHEMA)
    const areas = (value as { riskAreas: string[] }).riskAreas
    expect(areas).toHaveLength(5)
    expect(areas[0]).toHaveLength(40)
    expect(repairs).toContain('$.riskAreas: sliced from 7 to maxItems 5 items')
    expect(repairs).toContain('$.riskAreas[0]: truncated from 60 to maxLength 40 chars')
  })

  it('drops unexpected properties under additionalProperties:false', () => {
    const { value, repairs } = repairToSchema(
      { summary: 'a real, long-enough summary', riskAreas: [], bogus: true }, CHANGE_SUMMARY_SCHEMA)
    expect(value).not.toHaveProperty('bogus')
    expect(repairs).toEqual(['$.bogus: dropped unexpected property'])
  })

  it('NEVER fabricates a missing required property or fixes a wrong type', () => {
    const { value, repairs } = repairToSchema({ summary: 42 }, CHANGE_SUMMARY_SCHEMA)
    expect(value).toEqual({ summary: 42 })
    expect(repairs).toEqual([])
  })

  it('drops prototype-polluting keys from salvage-parsed candidates (bundle review, hygiene)', () => {
    const candidate: Record<string, unknown> = JSON.parse(
      '{"summary": "a real, long-enough summary", "riskAreas": [], "__proto__": {"polluted": true}}',
    ) as Record<string, unknown>
    const { value, repairs } = repairToSchema(candidate, CHANGE_SUMMARY_SCHEMA)
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect(value).not.toHaveProperty('polluted')
    expect(repairs).toEqual(['$.__proto__: dropped prototype-polluting key'])
  })
})

// ---------------------------------------------------------------------------
// agentWithSchemaSalvage — the wrapper (TEST-LOCK for the lived capitulation)
// ---------------------------------------------------------------------------

describe('agentWithSchemaSalvage', () => {
  const opts = { schema: CHANGE_SUMMARY_SCHEMA, label: 'classifyAndAct:act:feature:0' }

  it('passes through untouched when the native schema call succeeds', async () => {
    const rt = new FakeRuntime({ responses: [{ summary: 'a real, long-enough summary', riskAreas: [] }] })
    const out = await agentWithSchemaSalvage(rt, 'task', opts)
    expect(out).toEqual({
      value: { summary: 'a real, long-enough summary', riskAreas: [] },
      warnings: [], spawns: 1, salvageAttempted: false, salvaged: false,
    })
    expect(rt.calls).toHaveLength(1)
    expect(rt.calls[0]?.opts?.schema).toBe(CHANGE_SUMMARY_SCHEMA)
  })

  it('passes through plain calls when no schema is given (no salvage on null)', async () => {
    const rt = new FakeRuntime({ responses: [null] })
    const out = await agentWithSchemaSalvage(rt, 'task', { label: 'x' })
    expect(out).toEqual({ value: null, warnings: [], spawns: 1, salvageAttempted: false, salvaged: false })
    expect(rt.calls).toHaveLength(1)
  })

  it('TEST-LOCK — the lived exhaustion: native null, salvage answer over-long, repair saves the item', async () => {
    // Native schema call exhausts (null); the salvage respawn answers with the
    // SAME failure shape the harness loop could never fix: summary over its
    // bound. The wrapper truncates deterministically instead of re-failing.
    const rt = new FakeRuntime({
      responses: [null, JSON.stringify({ summary: 'y'.repeat(140), riskAreas: ['long target'] })],
    })
    const out = await agentWithSchemaSalvage<{ summary: string; riskAreas: string[] }>(rt, 'summarize the change', opts)
    expect(out.salvaged).toBe(true)
    expect(out.spawns).toBe(2)
    expect(out.value?.summary).toHaveLength(100)
    expect(out.value?.riskAreas).toEqual(['long target'])
    expect(out.warnings.join(' ')).toContain('$.summary: truncated from 140 to maxLength 100 chars')
    // The salvage respawn carries NO harness schema, a :salvage label, and the
    // schema-derived constraints in prose.
    const salvageCall = rt.calls[1]
    expect(salvageCall?.opts?.schema).toBeUndefined()
    expect(salvageCall?.opts?.label).toBe('classifyAndAct:act:feature:0:salvage')
    expect(salvageCall?.prompt).toContain('STRUCTURED-OUTPUT SALVAGE')
    expect(salvageCall?.prompt).toContain('"summary" (REQUIRED): string, 12-100 chars')
  })

  it('TEST-LOCK — unrepairable salvage (required property still missing) degrades to null with SPECIFIC diagnostics', async () => {
    // The other half of the lived failure: riskAreas omitted. Repair never
    // fabricates it — but the warning finally NAMES the violation instead of
    // the silent null the pattern used to see.
    const rt = new FakeRuntime({
      responses: [null, JSON.stringify({ summary: 'y'.repeat(140) })],
    })
    const out = await agentWithSchemaSalvage(rt, 'summarize the change', opts)
    expect(out.value).toBeNull()
    expect(out.salvaged).toBe(false)
    expect(out.spawns).toBe(2)
    expect(out.warnings.join(' ')).toContain('$.riskAreas: required property missing')
    expect(out.warnings.join(' ')).toContain('repairs attempted: $.summary: truncated from 140 to maxLength 100 chars')
  })

  it('degrades to null with diagnostics when the salvage answer is not JSON', async () => {
    const rt = new FakeRuntime({ responses: [null, 'I cannot produce JSON for this.'] })
    const out = await agentWithSchemaSalvage(rt, 'task', opts)
    expect(out.value).toBeNull()
    expect(out.warnings.join(' ')).toContain('salvage output is not a JSON object')
  })

  it('degrades to null when the salvage respawn also returns null', async () => {
    const rt = new FakeRuntime({ responses: [null, null] })
    const out = await agentWithSchemaSalvage(rt, 'task', opts)
    expect(out).toEqual({
      value: null,
      warnings: ['classifyAndAct:act:feature:0: structured-output salvage respawn also returned null'],
      spawns: 2, salvageAttempted: true, salvaged: false,
    })
  })

  it('accepts a fenced, prose-wrapped salvage answer and validates enums strictly', async () => {
    const control = { type: 'object', properties: { category: { type: 'string', enum: ['docs', 'bug'] } }, required: ['category'], additionalProperties: false }
    const okRt = new FakeRuntime({ responses: [null, 'Sure:\n```json\n{"category":"docs"}\n```'] })
    const ok = await agentWithSchemaSalvage<{ category: string }>(okRt, 'classify', { schema: control })
    expect(ok.value).toEqual({ category: 'docs' })
    expect(ok.salvaged).toBe(true)

    const badRt = new FakeRuntime({ responses: [null, '{"category":"feature"}'] })
    const bad = await agentWithSchemaSalvage(badRt, 'classify', { schema: control })
    expect(bad.value).toBeNull()
    expect(bad.warnings.join(' ')).toContain('"feature" is not one of "docs" | "bug"')
  })
})
