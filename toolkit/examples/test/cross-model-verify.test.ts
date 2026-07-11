// cross-model-verify.test.ts — composition test for the cross-model-verify
// workflow: the agentTypes.verify config routing, the entry probe, and the
// graceful fallback branch (review-flagged coverage gap).
//
// Uses FakeRuntime with onAgent routing on prompt content:
//   1. Probe:    "availability probe" (probeAgentType's default prompt)
//   2. Verifier: "adversarially verify" / refute-first (pattern-owned prompt)

import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import wf from '../cross-model-verify.workflow.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RuntimeOpts {
  /** What the probe agent replies (default: the affirmative token). */
  probeReply?: string | null
}

function makeRuntime(opts: RuntimeOpts = {}): FakeRuntime {
  return new FakeRuntime({
    onAgent: ({ prompt }: { prompt: string; index: number }) => {
      const p = prompt.toLowerCase()
      if (p.includes('availability probe')) {
        return opts.probeReply === undefined ? 'PROBE_OK' : opts.probeReply
      }
      // Refute-first verifier (adversarialVerification owns this prompt)
      return { verdict: 'confirmed', reason: 'claim re-derived from source' }
    },
  })
}

const BASE_ARGS = {
  claims: ['envelope.ts exports assertAgentTypeOption'],
  votes: 2,
}

interface WfResult {
  verifierType: string | null
  probe: { requested: string; available: boolean; reason: string | null } | null
  confirmed: Array<{ claim: string; verdict: string }>
  claimCount: number
}

// ---------------------------------------------------------------------------
// Input contract — agentTypes.verify is THE routing channel
// ---------------------------------------------------------------------------

describe('cross-model-verify — input contract', () => {
  it('rejects a blank agentTypes.verify via the shared parseConfig validation', async () => {
    const rt = makeRuntime()
    await expect(
      wf.run(rt, { ...BASE_ARGS, agentTypes: { verify: '  ' } }),
    ).rejects.toThrow(/agentTypes\.verify/)
  })

  it('ignores a legacy top-level verifierType arg (removed contract — no bespoke arg)', async () => {
    const rt = makeRuntime()
    const result = (await wf.run(rt, {
      ...BASE_ARGS,
      verifierType: 'codex:codex-rescue',
    })) as WfResult
    // No probe spawned, nothing routed — the legacy arg is dead.
    expect(rt.calls.some((c) => c.opts?.label === 'probeAgentType:probe')).toBe(false)
    expect(result.verifierType).toBeNull()
    expect(result.probe).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Same-model default — no probe spawned at all
// ---------------------------------------------------------------------------

describe('cross-model-verify — same-model default', () => {
  it('runs without any probe agent and reports verifierType null / probe null', async () => {
    const rt = makeRuntime()
    const result = (await wf.run(rt, BASE_ARGS)) as WfResult

    expect(result.verifierType).toBeNull()
    expect(result.probe).toBeNull()
    expect(result.confirmed.length).toBe(1)
    expect(rt.calls.some((c) => c.opts?.label === 'probeAgentType:probe')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Routed — probe passes, verifiers carry the agentType
// ---------------------------------------------------------------------------

describe('cross-model-verify — routed (probe available)', () => {
  it('probes once, then threads the type to EVERY verifier; result reports the pure id', async () => {
    const rt = makeRuntime()
    const result = (await wf.run(rt, {
      ...BASE_ARGS,
      agentTypes: { verify: 'workflow-toolbox:opencode-verifier' },
    })) as WfResult

    const probeCalls = rt.calls.filter((c) => c.opts?.label === 'probeAgentType:probe')
    const verifierCalls = rt.calls.filter((c) =>
      c.opts?.label?.startsWith('adversarialVerification:'),
    )
    expect(probeCalls.length).toBe(1)
    expect(probeCalls[0]!.opts?.agentType).toBe('workflow-toolbox:opencode-verifier')
    expect(verifierCalls.length).toBeGreaterThan(0)
    expect(
      verifierCalls.every((c) => c.opts?.agentType === 'workflow-toolbox:opencode-verifier'),
    ).toBe(true)

    expect(result.verifierType).toBe('workflow-toolbox:opencode-verifier')
    expect(result.probe).toEqual({
      requested: 'workflow-toolbox:opencode-verifier',
      available: true,
      reason: null,
    })
  })
})

// ---------------------------------------------------------------------------
// Fallback — probe fails, run COMPLETES on the standard verifier
// ---------------------------------------------------------------------------

describe('cross-model-verify — graceful fallback (probe unavailable)', () => {
  it('falls back to the standard verifier on the UNAVAILABLE marker, reporting the reason', async () => {
    const rt = makeRuntime({ probeReply: 'OPENCODE_UNAVAILABLE: no opencode binary on PATH' })
    const result = (await wf.run(rt, {
      ...BASE_ARGS,
      agentTypes: { verify: 'workflow-toolbox:opencode-verifier' },
    })) as WfResult

    // Verification still ran — standard subagent (no agentType threaded)
    const verifierCalls = rt.calls.filter((c) =>
      c.opts?.label?.startsWith('adversarialVerification:'),
    )
    expect(verifierCalls.length).toBeGreaterThan(0)
    expect(verifierCalls.every((c) => c.opts?.agentType === undefined)).toBe(true)
    expect(result.confirmed.length).toBe(1)

    // Pure identifier stays null; the structured probe field carries the story
    expect(result.verifierType).toBeNull()
    expect(result.probe?.requested).toBe('workflow-toolbox:opencode-verifier')
    expect(result.probe?.available).toBe(false)
    expect(result.probe?.reason).toContain('OPENCODE_UNAVAILABLE: no opencode binary on PATH')
  })

  it('falls back the same way when the probe agent returns null', async () => {
    const rt = makeRuntime({ probeReply: null })
    const result = (await wf.run(rt, {
      ...BASE_ARGS,
      agentTypes: { verify: 'codex:codex-rescue' },
    })) as WfResult

    expect(result.verifierType).toBeNull()
    expect(result.probe?.available).toBe(false)
    expect(result.confirmed.length).toBe(1)
  })
})
