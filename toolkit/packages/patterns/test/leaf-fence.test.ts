import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import { withLeafFence, LEAF_AGENT_TYPE } from '../src/leaf-fence.js'

describe('withLeafFence — available (probe answers)', () => {
  it('probes the default LEAF_AGENT_TYPE and reports it resolved', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    const { report } = await withLeafFence(rt)
    expect(report).toEqual({
      resolvedAgentType: LEAF_AGENT_TYPE,
      probe: { requested: LEAF_AGENT_TYPE, available: true, reason: null },
    })
  })

  it('applies the fence as a DEFAULT — a call with no explicit agentType gets it', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    const { rt: fenced } = await withLeafFence(rt)
    await fenced.agent('do the task')
    const call = rt.calls[rt.calls.length - 1]!
    expect(call.opts?.agentType).toBe(LEAF_AGENT_TYPE)
  })

  it('an explicit per-call agentType always overrides the fence', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    const { rt: fenced } = await withLeafFence(rt)
    await fenced.agent('do the task', { agentType: 'workflow-toolbox:opencode-verifier' })
    const call = rt.calls[rt.calls.length - 1]!
    expect(call.opts?.agentType).toBe('workflow-toolbox:opencode-verifier')
  })

  it('an OUTER withAgentDefaults blanket agentType (a workflow author’s own perAgent override) wins over the fence', async () => {
    // Precedence contract this whole design depends on: withLeafFence must be
    // the INNERMOST wrap so a workflow's own blanket perAgent.agentType (applied
    // by an OUTER withAgentDefaults, exactly as pr-review/independent-analysis
    // do at the top of run()) is never silently clobbered by the fence default.
    const { withAgentDefaults } = await import('@workflow-toolbox/runtime')
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    const { rt: fenced } = await withLeafFence(rt)
    const outer = withAgentDefaults(fenced, { agentType: 'my-custom-judge-type' })
    await outer.agent('do the task')
    const call = rt.calls[rt.calls.length - 1]!
    expect(call.opts?.agentType).toBe('my-custom-judge-type')
  })

  it('accepts an agentType override to probe/apply a different fenced type', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    const { rt: fenced, report } = await withLeafFence(rt, { agentType: 'my-plugin:leaf' })
    expect(report.resolvedAgentType).toBe('my-plugin:leaf')
    await fenced.agent('do the task')
    const call = rt.calls[rt.calls.length - 1]!
    expect(call.opts?.agentType).toBe('my-plugin:leaf')
  })
})

describe('withLeafFence — graceful fallback (agentType not installed/registered)', () => {
  it('degrades to the standard subagent when the probe cannot answer, without throwing', async () => {
    // Only a call actually routed through the fenced agentType fails — mirrors the
    // real runtime's "unregistered agentType" throw; a call with no agentType (the
    // fallback path) must succeed normally.
    const rt = new FakeRuntime({
      onAgent: (call) => {
        if (call.opts?.agentType === LEAF_AGENT_TYPE) {
          throw new Error("agentType 'workflow-toolbox:leaf' not found")
        }
        return 'ok'
      },
    })
    const { rt: fenced, report } = await withLeafFence(rt)
    expect(report.resolvedAgentType).toBeNull()
    expect(report.probe?.available).toBe(false)

    await fenced.agent('do the task')
    const call = rt.calls[rt.calls.length - 1]!
    expect(call.opts?.agentType).toBeUndefined()
  })
})

describe('withLeafFence — disabled (messaging: true opt-out)', () => {
  it('returns rt unchanged and spends no probe call', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    const { rt: fenced, report } = await withLeafFence(rt, { disabled: true })
    expect(report).toEqual({ resolvedAgentType: null, probe: null })
    expect(rt.calls.length).toBe(0)

    await fenced.agent('do the task')
    const call = rt.calls[rt.calls.length - 1]!
    expect(call.opts?.agentType).toBeUndefined()
  })
})
