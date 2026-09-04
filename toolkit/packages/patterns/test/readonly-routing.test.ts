import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import { withReadOnlyRouting, READONLY_AGENT_TYPE } from '../src/readonly-routing.js'
import { LOCAL_AGENT_PROBE_PROMPT } from '../src/probe-agent-type.js'

describe('withReadOnlyRouting', () => {
  // ⚠ This asserts the LITERAL name on purpose. Every other test compares against
  // READONLY_AGENT_TYPE, so a typo in the constant moves the code and the expectation
  // together and the whole file stays green — proven by mutation 2026-08-18: pointing the
  // constant at a non-existent type left all five tests passing. This is the only
  // assertion here that can fail for that reason.
  it('pins the published agent-type name, which nothing else in this file locks', () => {
    expect(READONLY_AGENT_TYPE).toBe('workflow-toolbox:leaf-readonly')
  })

  it('probes and applies the read-only type as a selective agent() default', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    const { rt: readOnlyRt, report } = await withReadOnlyRouting(rt)

    expect(report).toEqual({
      resolvedAgentType: READONLY_AGENT_TYPE,
      probe: { requested: READONLY_AGENT_TYPE, available: true, reason: null },
    })
    await readOnlyRt.agent('survey the repository')
    expect(rt.calls[rt.calls.length - 1]?.opts?.agentType).toBe(READONLY_AGENT_TYPE)

    await rt.agent('implement the change')
    expect(rt.calls[rt.calls.length - 1]?.opts?.agentType).toBeUndefined()
  })

  it('preserves explicit and outer agentType overrides', async () => {
    const { withAgentDefaults } = await import('@workflow-toolbox/runtime')
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    const { rt: readOnlyRt } = await withReadOnlyRouting(rt)
    const outer = withAgentDefaults(readOnlyRt, { agentType: 'my-custom-reader' })

    await outer.agent('audit')
    expect(rt.calls[rt.calls.length - 1]?.opts?.agentType).toBe('my-custom-reader')
    await readOnlyRt.agent('locate', { agentType: 'my-explicit-reader' })
    expect(rt.calls[rt.calls.length - 1]?.opts?.agentType).toBe('my-explicit-reader')
  })

  it('uses the local probe prompt and passes perAgent defaults only to the probe', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    await withReadOnlyRouting(rt, { perAgent: { agentType: 'other', model: 'sonnet', effort: 'low' } })

    expect(rt.calls[0]?.prompt).toBe(LOCAL_AGENT_PROBE_PROMPT)
    expect(rt.calls[0]?.opts).toMatchObject({
      agentType: READONLY_AGENT_TYPE,
      model: 'sonnet',
      effort: 'low',
    })
  })

  it('fails open loudly when the type is unavailable', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'OPENCODE_UNAVAILABLE: plugin not installed' })
    const { rt: readOnlyRt, report } = await withReadOnlyRouting(rt)

    expect(report.resolvedAgentType).toBeNull()
    expect(rt.logs.find((line) => line.includes('routing UNAVAILABLE'))).toContain('no read-only protection')
    await readOnlyRt.agent('verify by reading')
    expect(rt.calls[rt.calls.length - 1]?.opts?.agentType).toBeUndefined()
  })

  it('returns rt unchanged without probing when disabled', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    const { rt: readOnlyRt, report } = await withReadOnlyRouting(rt, { disabled: true })

    expect(report).toEqual({ resolvedAgentType: null, probe: null })
    expect(rt.calls).toHaveLength(0)
    expect(readOnlyRt).toBe(rt)
  })
})
