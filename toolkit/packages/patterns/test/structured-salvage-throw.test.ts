// structured-salvage-throw.test.ts — TEST-LOCK for the THROW-shaped twin of
// the null-degrade failure: when a schema-bearing subagent NEVER calls
// StructuredOutput (e.g. a bridge agentType that degraded to plain text), the
// harness makes rt.agent() THROW `agent({schema}): subagent completed without
// calling StructuredOutput`. Before the fix that throw propagated and killed
// the run; now agentWithSchemaSalvage catches it on the NATIVE call and routes
// it into the same salvage path as a null return — while every other throw
// (budget, abort) still propagates.

import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import { agentWithSchemaSalvage, isNoStructuredOutputError } from '../src/structured-salvage.js'

const SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string', maxLength: 10 } },
  required: ['verdict'],
  additionalProperties: false,
}

const NO_SO_ERROR = () =>
  new Error(
    'agent({schema}): subagent completed without calling StructuredOutput (after in-conversation nudge)',
  )

describe('agentWithSchemaSalvage — no-StructuredOutput throw routing', () => {
  it('catches the no-StructuredOutput throw on the native call and salvages a valid raw answer', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ index }) => {
        // Native (schema-bearing) call: throw the no-SO error.
        if (index === 1) throw NO_SO_ERROR()
        // Salvage respawn (schema-less): answer a valid JSON object.
        return JSON.stringify({ verdict: 'confirmed' })
      },
    })
    const out = await agentWithSchemaSalvage<{ verdict: string }>(rt, 'decide', {
      schema: SCHEMA,
      label: 'test:soThrow',
    })
    expect(rt.calls).toHaveLength(2) // native threw → salvage respawn fired
    expect(out.value).toEqual({ verdict: 'confirmed' })
    expect(out.salvaged).toBe(true)
    expect(out.salvageAttempted).toBe(true)
    expect(out.spawns).toBe(2)
    // The salvage respawn carries no harness schema, a :salvage label, and the
    // schema-derived constraints in prose.
    expect(rt.calls[1]?.opts?.schema).toBeUndefined()
    expect(rt.calls[1]?.opts?.label).toBe('test:soThrow:salvage')
    expect(rt.calls[1]?.prompt).toContain('STRUCTURED-OUTPUT SALVAGE')
  })

  it('routes the no-StructuredOutput throw through repair when the salvage answer is over-bound', async () => {
    // Same shape as the null-degrade repair test, reached via THROW: salvage
    // answer over maxLength → deterministic truncation saves the item.
    const rt = new FakeRuntime({
      onAgent: ({ index }) => {
        if (index === 1) throw NO_SO_ERROR()
        return JSON.stringify({ verdict: 'y'.repeat(20) })
      },
    })
    const out = await agentWithSchemaSalvage<{ verdict: string }>(rt, 'decide', {
      schema: SCHEMA,
    })
    expect(out.salvaged).toBe(true)
    expect(out.value?.verdict).toHaveLength(10)
    expect(out.warnings.join(' ')).toContain('$.verdict: truncated from 20 to maxLength 10 chars')
  })

  it('propagates a DIFFERENT throw (budget exceeded) unchanged — no salvage respawn', async () => {
    const rt = new FakeRuntime({
      onAgent: () => {
        throw new Error('WorkflowBudgetExceededError: budget exhausted')
      },
    })
    await expect(
      agentWithSchemaSalvage<{ verdict: string }>(rt, 'decide', { schema: SCHEMA }),
    ).rejects.toThrow(/budget exhausted/)
    expect(rt.calls).toHaveLength(1) // native call only — no salvage respawn
  })

  it('does not swallow a no-StructuredOutput throw from the salvage respawn (schema-less → cannot recur)', async () => {
    // Belt-and-braces: the salvage respawn is schema-less so the harness will
    // not emit this throw from it. If a future change re-introduces a schema
    // there, the throw must propagate (not loop silently) — the respawn has no
    // matching catch.
    const rt = new FakeRuntime({ onAgent: () => { throw NO_SO_ERROR() } })
    await expect(
      agentWithSchemaSalvage<{ verdict: string }>(rt, 'decide', { schema: SCHEMA }),
    ).rejects.toThrow(/without calling StructuredOutput/)
    expect(rt.calls).toHaveLength(2) // native caught → salvage respawn threw & propagated
  })

  it('leaves a plain (schema-less) call unaffected — unrelated throws propagate as before', async () => {
    const rt = new FakeRuntime({
      onAgent: () => { throw new Error('any other error') },
    })
    await expect(
      agentWithSchemaSalvage<{ verdict: string }>(rt, 'decide', { label: 'x' }),
    ).rejects.toThrow(/any other error/)
  })
})

describe('isNoStructuredOutputError', () => {
  it('matches the harness no-StructuredOutput throw', () => {
    expect(isNoStructuredOutputError(NO_SO_ERROR())).toBe(true)
  })

  it('rejects budget errors, unrelated errors, and non-Error throws', () => {
    expect(isNoStructuredOutputError(new Error('budget exceeded'))).toBe(false)
    expect(isNoStructuredOutputError(new Error('some other failure'))).toBe(false)
    expect(isNoStructuredOutputError('without calling StructuredOutput')).toBe(false)
    expect(isNoStructuredOutputError(null)).toBe(false)
    expect(isNoStructuredOutputError(undefined)).toBe(false)
    expect(isNoStructuredOutputError({ message: 'without calling StructuredOutput' })).toBe(false)
  })
})
