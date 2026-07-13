import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import { withLeafFence, LEAF_AGENT_TYPE } from '../src/leaf-fence.js'
import { LOCAL_AGENT_PROBE_PROMPT } from '../src/probe-agent-type.js'

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

describe('withLeafFence — options.perAgent (probe inherits the workflow blanket default)', () => {
  it('the probe call itself carries perAgent.model/effort, not the raw session default', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    await withLeafFence(rt, { perAgent: { model: 'sonnet', effort: 'low' } })
    // Exactly one call was made — the probe itself.
    expect(rt.calls.length).toBe(1)
    const probeCall = rt.calls[0]!
    expect(probeCall.opts?.label).toBe('probeAgentType:probe')
    expect(probeCall.opts?.model).toBe('sonnet')
    expect(probeCall.opts?.effort).toBe('low')
    // The probe's OWN explicit agentType (the type being probed) still wins over
    // whatever agentType perAgent might also carry.
    expect(probeCall.opts?.agentType).toBe(LEAF_AGENT_TYPE)
  })

  it('an agentType inside perAgent does NOT redirect the probe away from the fenced type', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    await withLeafFence(rt, { perAgent: { agentType: 'some-other-type', model: 'haiku' } })
    const probeCall = rt.calls[0]!
    expect(probeCall.opts?.agentType).toBe(LEAF_AGENT_TYPE)
    expect(probeCall.opts?.model).toBe('haiku')
  })

  it('without perAgent, the probe carries no model/effort override (unchanged prior behavior)', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    await withLeafFence(rt)
    const probeCall = rt.calls[0]!
    expect(probeCall.opts?.model).toBeUndefined()
    expect(probeCall.opts?.effort).toBeUndefined()
  })

  it('perAgent does not change the RETURNED wrapper’s precedence — a per-role override still wins', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    const { rt: fenced } = await withLeafFence(rt, { perAgent: { model: 'sonnet' } })
    await fenced.agent('do the task', { agentType: 'workflow-toolbox:opencode-verifier' })
    const call = rt.calls[rt.calls.length - 1]!
    expect(call.opts?.agentType).toBe('workflow-toolbox:opencode-verifier')
  })
})

describe('withLeafFence — fail-open is LOUD (unmissable journal log)', () => {
  it('logs an unmissable warning when the fence is unavailable', async () => {
    const rt = new FakeRuntime({
      onAgent: () => 'OPENCODE_UNAVAILABLE: plugin not installed',
    })
    await withLeafFence(rt)
    const warning = rt.logs.find((l) => l.includes('fence UNAVAILABLE'))
    expect(warning).toBeDefined()
    expect(warning).toContain('leaves run with SendMessage enabled this run')
    expect(warning).toContain(LEAF_AGENT_TYPE)
  })

  it('does NOT log the fence-unavailable warning when the probe succeeds', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    await withLeafFence(rt)
    expect(rt.logs.some((l) => l.includes('fence UNAVAILABLE'))).toBe(false)
  })

  it('does NOT log the fence-unavailable warning when the fence is disabled (intentional opt-out)', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    await withLeafFence(rt, { disabled: true })
    expect(rt.logs.some((l) => l.includes('fence UNAVAILABLE'))).toBe(false)
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

describe('withLeafFence — probe prompt is the LOCAL variant (same class as the lean regression)', () => {
  // The leaf is a locally-registered agentType — there is no availability gate
  // or CLI chain to exercise. Under the bridge default prompt the fence passed
  // only by charitable interpretation ("your external CLI" — the leaf has
  // none); a strict reader refusing like lean did (live run wf_19cdcdcb-4b7)
  // would have silently dropped the fence.
  it('sends the LOCAL self-contained probe prompt, not the bridge default', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    await withLeafFence(rt)
    const probeCall = rt.calls[0]!
    expect(probeCall.prompt).toBe(LOCAL_AGENT_PROBE_PROMPT)
  })
})
