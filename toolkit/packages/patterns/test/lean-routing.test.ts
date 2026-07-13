import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import { withLeanRouting, LEAN_AGENT_TYPE } from '../src/lean-routing.js'
import { LOCAL_AGENT_PROBE_PROMPT } from '../src/probe-agent-type.js'

describe('withLeanRouting — available (probe answers)', () => {
  it('probes the default LEAN_AGENT_TYPE and reports it resolved', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    const { report } = await withLeanRouting(rt)
    expect(report).toEqual({
      resolvedAgentType: LEAN_AGENT_TYPE,
      probe: { requested: LEAN_AGENT_TYPE, available: true, reason: null },
    })
  })

  it('applies lean routing as a DEFAULT — a call with no explicit agentType gets it', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    const { rt: leanRt } = await withLeanRouting(rt)
    await leanRt.agent('synthesize the verdict')
    const call = rt.calls[rt.calls.length - 1]!
    expect(call.opts?.agentType).toBe(LEAN_AGENT_TYPE)
  })

  it('an explicit per-call agentType always overrides lean routing', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    const { rt: leanRt } = await withLeanRouting(rt)
    await leanRt.agent('synthesize the verdict', { agentType: 'workflow-toolbox:opencode-verifier' })
    const call = rt.calls[rt.calls.length - 1]!
    expect(call.opts?.agentType).toBe('workflow-toolbox:opencode-verifier')
  })

  it('an OUTER withAgentDefaults blanket agentType (a workflow author’s own perAgent override) wins over lean routing', async () => {
    const { withAgentDefaults } = await import('@workflow-toolbox/runtime')
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    const { rt: leanRt } = await withLeanRouting(rt)
    const outer = withAgentDefaults(leanRt, { agentType: 'my-custom-judge-type' })
    await outer.agent('synthesize the verdict')
    const call = rt.calls[rt.calls.length - 1]!
    expect(call.opts?.agentType).toBe('my-custom-judge-type')
  })

  it('accepts an agentType override to probe/apply a different lean type', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    const { rt: leanRt, report } = await withLeanRouting(rt, { agentType: 'my-plugin:lean' })
    expect(report.resolvedAgentType).toBe('my-plugin:lean')
    await leanRt.agent('synthesize the verdict')
    const call = rt.calls[rt.calls.length - 1]!
    expect(call.opts?.agentType).toBe('my-plugin:lean')
  })

  it('is SELECTIVE — a call made through the ORIGINAL rt (not the returned leanRt) is unaffected', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    const { rt: leanRt } = await withLeanRouting(rt)
    void leanRt
    await rt.agent('a stage that still needs real tools')
    const call = rt.calls[rt.calls.length - 1]!
    expect(call.opts?.agentType).toBeUndefined()
  })
})

describe('withLeanRouting — options.perAgent (probe inherits the workflow blanket default)', () => {
  it('the probe call itself carries perAgent.model/effort, not the raw session default', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    await withLeanRouting(rt, { perAgent: { model: 'sonnet', effort: 'low' } })
    expect(rt.calls.length).toBe(1)
    const probeCall = rt.calls[0]!
    expect(probeCall.opts?.label).toBe('probeAgentType:probe')
    expect(probeCall.opts?.model).toBe('sonnet')
    expect(probeCall.opts?.effort).toBe('low')
    expect(probeCall.opts?.agentType).toBe(LEAN_AGENT_TYPE)
  })

  it('an agentType inside perAgent does NOT redirect the probe away from the lean type', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    await withLeanRouting(rt, { perAgent: { agentType: 'some-other-type', model: 'haiku' } })
    const probeCall = rt.calls[0]!
    expect(probeCall.opts?.agentType).toBe(LEAN_AGENT_TYPE)
    expect(probeCall.opts?.model).toBe('haiku')
  })

  it('without perAgent, the probe carries no model/effort override (unchanged prior behavior)', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    await withLeanRouting(rt)
    const probeCall = rt.calls[0]!
    expect(probeCall.opts?.model).toBeUndefined()
    expect(probeCall.opts?.effort).toBeUndefined()
  })

  it('perAgent does not change the RETURNED wrapper’s precedence — a per-call override still wins', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    const { rt: leanRt } = await withLeanRouting(rt, { perAgent: { model: 'sonnet' } })
    await leanRt.agent('synthesize the verdict', { agentType: 'workflow-toolbox:opencode-verifier' })
    const call = rt.calls[rt.calls.length - 1]!
    expect(call.opts?.agentType).toBe('workflow-toolbox:opencode-verifier')
  })
})

describe('withLeanRouting — fail-open is LOUD (unmissable journal log)', () => {
  it('logs an unmissable warning when lean routing is unavailable', async () => {
    const rt = new FakeRuntime({
      onAgent: () => 'OPENCODE_UNAVAILABLE: plugin not installed',
    })
    await withLeanRouting(rt)
    const warning = rt.logs.find((l) => l.includes('routing UNAVAILABLE'))
    expect(warning).toBeDefined()
    expect(warning).toContain('no lean savings')
    expect(warning).toContain(LEAN_AGENT_TYPE)
  })

  it('does NOT log the unavailable warning when the probe succeeds', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    await withLeanRouting(rt)
    expect(rt.logs.some((l) => l.includes('routing UNAVAILABLE'))).toBe(false)
  })

  it('does NOT log the unavailable warning when lean routing is disabled (intentional opt-out)', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    await withLeanRouting(rt, { disabled: true })
    expect(rt.logs.some((l) => l.includes('routing UNAVAILABLE'))).toBe(false)
  })
})

describe('withLeanRouting — graceful fallback (agentType not installed/registered)', () => {
  it('degrades to whatever default the wrapped runtime already carried, without throwing', async () => {
    const rt = new FakeRuntime({
      onAgent: (call) => {
        if (call.opts?.agentType === LEAN_AGENT_TYPE) {
          throw new Error("agentType 'workflow-toolbox:lean' not found")
        }
        return 'ok'
      },
    })
    const { rt: leanRt, report } = await withLeanRouting(rt)
    expect(report.resolvedAgentType).toBeNull()
    expect(report.probe?.available).toBe(false)

    await leanRt.agent('synthesize the verdict')
    const call = rt.calls[rt.calls.length - 1]!
    expect(call.opts?.agentType).toBeUndefined()
  })
})

describe('withLeanRouting — disabled', () => {
  it('returns rt unchanged and spends no probe call', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    const { rt: leanRt, report } = await withLeanRouting(rt, { disabled: true })
    expect(report).toEqual({ resolvedAgentType: null, probe: null })
    expect(rt.calls.length).toBe(0)

    await leanRt.agent('synthesize the verdict')
    const call = rt.calls[rt.calls.length - 1]!
    expect(call.opts?.agentType).toBeUndefined()
  })
})

describe('withLeanRouting — probe prompt fits a TOOL-LESS agent (regression, live run wf_19cdcdcb-4b7)', () => {
  // Live failure 2026-07-13: the probe's bridge DEFAULT prompt demands "run
  // the task through your external CLI — do NOT answer from your own
  // knowledge". A lean agent has no tools and its preamble tells it to say so
  // instead of fabricating compliance — the probe read that honest refusal as
  // UNAVAILABLE, and every routed call silently kept the full ambient context
  // lean exists to strip.
  const honestToolLessAgent = ({ prompt }: { prompt: string }) =>
    /external CLI|do NOT answer from your own knowledge/i.test(prompt)
      ? 'I cannot execute this task as specified: I have no tools at all — no shell, no external CLI.'
      : 'PROBE_OK'

  it('resolves AVAILABLE against an honest tool-less agent (the live-failure reproduction)', async () => {
    const rt = new FakeRuntime({ onAgent: honestToolLessAgent })
    const { report } = await withLeanRouting(rt)
    expect(report.resolvedAgentType).toBe(LEAN_AGENT_TYPE)
    expect(report.probe).toEqual({ requested: LEAN_AGENT_TYPE, available: true, reason: null })
  })

  it('sends the LOCAL self-contained probe prompt, not the bridge default', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    await withLeanRouting(rt)
    const probeCall = rt.calls[0]!
    expect(probeCall.prompt).toBe(LOCAL_AGENT_PROBE_PROMPT)
  })
})
