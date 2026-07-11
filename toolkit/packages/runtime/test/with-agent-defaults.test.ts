import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '../src/fake.js'
import { withAgentDefaults } from '../src/with-agent-defaults.js'

// ---------------------------------------------------------------------------
// withAgentDefaults — Class-A per-agent defaults via one wrapping point.
// ---------------------------------------------------------------------------
describe('withAgentDefaults', () => {
  it('applies defaults when the call omits them', async () => {
    const rt = new FakeRuntime({ responses: ['ok'] })
    const rt2 = withAgentDefaults(rt, { model: 'sonnet', effort: 'high' })
    await rt2.agent('prompt')
    expect(rt.calls[0]!.opts).toMatchObject({ model: 'sonnet', effort: 'high' })
  })

  it('lets an explicit per-call opt win over the default (defaults, not overrides)', async () => {
    const rt = new FakeRuntime({ responses: ['ok'] })
    const rt2 = withAgentDefaults(rt, { model: 'sonnet', effort: 'high' })
    await rt2.agent('prompt', { model: 'opus' })
    expect(rt.calls[0]!.opts).toMatchObject({ model: 'opus', effort: 'high' })
  })

  it('preserves per-call opts the default does not mention', async () => {
    const rt = new FakeRuntime({ responses: ['ok'] })
    const rt2 = withAgentDefaults(rt, { effort: 'low' })
    await rt2.agent('prompt', { label: 'my-agent', agentType: 'reviewer' })
    expect(rt.calls[0]!.opts).toMatchObject({ effort: 'low', label: 'my-agent', agentType: 'reviewer' })
  })

  it('propagates defaults through parallel() thunks that call the wrapped agent', async () => {
    const rt = new FakeRuntime({ responses: ['a', 'b'] })
    const rt2 = withAgentDefaults(rt, { model: 'haiku' })
    await rt2.parallel([
      () => rt2.agent('first'),
      () => rt2.agent('second', { effort: 'max' }),
    ])
    expect(rt.calls[0]!.opts).toMatchObject({ model: 'haiku' })
    expect(rt.calls[1]!.opts).toMatchObject({ model: 'haiku', effort: 'max' })
  })

  it('stacks when wrapped twice — outer (last) wins, inner fills the rest', async () => {
    const rt = new FakeRuntime({ responses: ['ok', 'ok'] })
    const inner = withAgentDefaults(rt, { model: 'sonnet' })
    const outer = withAgentDefaults(inner, { model: 'opus', effort: 'high' })
    await outer.agent('prompt')
    // outer's defaults arrive as inner's per-call opts → win on the shared key (model).
    expect(rt.calls[0]!.opts).toMatchObject({ model: 'opus', effort: 'high' })

    // A key only the inner sets survives when the outer omits it.
    const innerOnly = withAgentDefaults(rt, { model: 'sonnet' })
    const outerEffort = withAgentDefaults(innerOnly, { effort: 'low' })
    await outerEffort.agent('prompt')
    expect(rt.calls[1]!.opts).toMatchObject({ model: 'sonnet', effort: 'low' })
  })

  it('carries non-agent runtime members through unchanged', () => {
    const rt = new FakeRuntime({ responses: [] })
    const rt2 = withAgentDefaults(rt, { model: 'sonnet' })
    expect(rt2.parallel).toBe(rt.parallel)
    expect(rt2.pipeline).toBe(rt.pipeline)
    expect(rt2.budget).toBe(rt.budget)
  })

  it('keeps phase()/log() working — prototype methods survive the wrap', async () => {
    const rt = new FakeRuntime({ responses: ['ok'] })
    const rt2 = withAgentDefaults(rt, { model: 'sonnet' })
    expect(() => rt2.log('hello')).not.toThrow()
    rt2.phase('Scan')
    await rt2.agent('p')
    // phase() reaches the source rt's private state through the arrow wrapper
    // ((t) => rt.phase(t), this === rt) → the subsequent agent call records
    // 'Scan'. A naive { ...rt } spread drops phase/log (prototype methods, not
    // fields); .bind(rt) would also fail in the real sandbox (host functions
    // with no usable .bind) — the arrow wrapper sidesteps both.
    expect(rt.calls[0]!.phase).toBe('Scan')
  })
})
