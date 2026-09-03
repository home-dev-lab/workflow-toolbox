import { describe, expect, it } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import { withEnvelopeContract } from '../src/envelope-contract.js'
import { runEnvelopeContract } from '../src/envelope-contract.js'
import { loopUntilDone } from '../src/loop-until-done.js'

const schema = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['yes', 'no'] } },
  required: ['verdict'],
  additionalProperties: false,
}

describe('withEnvelopeContract', () => {
  it('TEST-LOCK — composes direct envelope calls, strips the harness schema, and returns the validated value', async () => {
    const rt = new FakeRuntime({ responses: [`MANIFEST: /tmp/x.manifest.json ANSWER: ${JSON.stringify('{"verdict":"yes"}')}\n`] })
    const value = await withEnvelopeContract(rt).agent('OPENCODE_WORKDIR: /work\n\nanswer', {
      agentType: 'workflow-toolbox:opencode-envelope', schema,
    })
    expect(value).toEqual({ verdict: 'yes' })
    expect(rt.calls[0]?.opts?.schema).toBeUndefined()
    expect(rt.calls[0]?.prompt).toContain('Pass no --model flag unless an OPENCODE_MODEL line is present.')
    expect(rt.calls[0]?.prompt).toContain('--- BEGIN OPENCODE ENVELOPE TASK ---')
  })

  it('returns a discriminated lane error from the single result line', async () => {
    const rt = new FakeRuntime({ responses: [`MANIFEST: /tmp/x.manifest.json ERROR: ${JSON.stringify('opencode exited 1 (model missing)')}\n`] })
    const out = await runEnvelopeContract(rt, 'answer', {
      agentType: 'workflow-toolbox:opencode-envelope', schema, label: 'worker',
    })
    expect(out.value).toBeNull()
    expect(out.envelopeFailure).toBe('lane-error')
    expect(out.warnings.join(' ')).toContain('opencode exited 1 (model missing)')
  })

  it('TEST-LOCK — a schema-less call keeps the bare MANIFEST line as its value (a multi-task batch has no ANSWER suffix)', async () => {
    const rt = new FakeRuntime({ responses: ['MANIFEST: /tmp/batch/envelope.manifest.json\n'] })
    const value = await withEnvelopeContract(rt).agent('OPENCODE_EACH_JSON: /tmp/src.json\nOPENCODE_PROMPT_TEMPLATE: capital of {{item}}\n\nrun it', {
      agentType: 'workflow-toolbox:opencode-envelope',
    })
    expect(value).toBe('MANIFEST: /tmp/batch/envelope.manifest.json\n')
    expect(rt.calls[0]?.prompt).toContain('EACH mode')
    expect(rt.calls[0]?.prompt).not.toContain('Write ONE task')
  })

  it('TEST-LOCK — with a schema, a bare MANIFEST line is still the no-answer failure', async () => {
    const rt = new FakeRuntime({ responses: ['MANIFEST: /tmp/one/envelope.manifest.json\n'] })
    const out = await runEnvelopeContract(rt, 'answer', { agentType: 'workflow-toolbox:opencode-envelope', schema, label: 'w' })
    expect(out.value).toBeNull()
    expect(out.envelopeFailure).toBe('no-answer')
  })

  it('passes non-envelope calls through unchanged', async () => {
    const rt = new FakeRuntime({ responses: ['plain'] })
    const opts = { agentType: 'workflow-toolbox:leaf', label: 'plain' }
    await withEnvelopeContract(rt).agent('unchanged', opts)
    expect(rt.calls[0]).toMatchObject({ prompt: 'unchanged', opts })
  })

  it('TEST-LOCK — gives loop bodies the envelope-composing runtime', async () => {
    const rt = new FakeRuntime({ responses: [`MANIFEST: /tmp/x.manifest.json ANSWER: ${JSON.stringify('complete')}\n`] })
    const result = await loopUntilDone(rt, {
      initial: '', maxIterations: 1,
      body: async (bodyRt) => ({ state: await bodyRt.agent('answer', { agentType: 'opencode-envelope' }) ?? '', done: true }),
    })
    expect(result.value.state).toBe('complete')
    expect(rt.calls[0]?.prompt).toContain('--- BEGIN OPENCODE ENVELOPE TASK ---')
  })
})
