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
    // Exclude the provenance-gate checker: it is a PLAIN subagent (no agentType),
    // not a verifier, so it is not part of "every verifier carries the type".
    const verifierCalls = rt.calls.filter((c) =>
      c.opts?.label?.startsWith('adversarialVerification:') &&
      !c.opts.label.includes(':provenance-check'),
    )
    expect(probeCalls.length).toBe(1)
    expect(probeCalls[0]!.opts?.agentType).toBe('workflow-toolbox:opencode-verifier')
    expect(verifierCalls.length).toBeGreaterThan(0)
    expect(
      verifierCalls.every((c) => c.opts?.agentType === 'workflow-toolbox:opencode-verifier'),
    ).toBe(true)

    // The external route ARMS the provenance gate: a checker runs, and it is a
    // PLAIN subagent — never routed to the external CLI it is auditing.
    const checkerCall = rt.calls.find((c) => (c.opts?.label ?? '').includes(':provenance-check'))
    expect(checkerCall).toBeDefined()
    expect(checkerCall!.opts?.agentType).toBeUndefined()

    expect(result.verifierType).toBe('workflow-toolbox:opencode-verifier')
    expect(result.probe).toEqual({
      requested: 'workflow-toolbox:opencode-verifier',
      available: true,
      reason: null,
    })
  })
})

// ---------------------------------------------------------------------------
// Fail-fast — a requested verifier must be available
// ---------------------------------------------------------------------------

describe('cross-model-verify — fails fast (probe unavailable)', () => {
  it('refuses the launch on the UNAVAILABLE marker', async () => {
    const rt = makeRuntime({ probeReply: 'OPENCODE_UNAVAILABLE: no opencode binary on PATH' })
    await expect(
      wf.run(rt, {
        ...BASE_ARGS,
        agentTypes: { verify: 'workflow-toolbox:opencode-verifier' },
      }),
    ).rejects.toThrow(
      /required agentType .* is unavailable/,
    )
  })

  it('refuses the launch when the probe agent returns null', async () => {
    const rt = makeRuntime({ probeReply: null })
    await expect(
      wf.run(rt, {
        ...BASE_ARGS,
        agentTypes: { verify: 'codex:codex-rescue' },
      }),
    ).rejects.toThrow(/required agentType .* is unavailable/)
  })
})

// ---------------------------------------------------------------------------
// refuteThreshold — exposes adversarialVerification's own knob through the
// workflow's input contract. Regression-locks the "votes:1 needs
// refuteThreshold:1" guard interaction that blocked a live single-round-trip
// smoke of the opencode cross-model bridge (adversarialVerification's default
// refuteThreshold is 2, which is > a votes:1 config and throws synchronously).
// ---------------------------------------------------------------------------

describe('cross-model-verify — refuteThreshold', () => {
  it('rejects a non-number / < 1 refuteThreshold at parseInput', async () => {
    const rt = makeRuntime()
    await expect(
      wf.run(rt, { ...BASE_ARGS, refuteThreshold: 0 }),
    ).rejects.toThrow(/"refuteThreshold" must be a number >= 1/)
    await expect(
      wf.run(rt, { ...BASE_ARGS, refuteThreshold: 'two' }),
    ).rejects.toThrow(/"refuteThreshold" must be a number >= 1/)
  })

  it('propagates adversarialVerification\'s own guard when refuteThreshold defaults to 2 but votes:1 is requested (the exact shape that starved a live smoke)', async () => {
    const rt = makeRuntime()
    await expect(
      wf.run(rt, { ...BASE_ARGS, votes: 1 }),
    ).rejects.toThrow(/refuteThreshold \(2\) must not be > votes \(1\)/)
  })

  it('votes:1, refuteThreshold:1 — the cheapest single-round-trip config — runs and tallies a lone refute as REFUTED', async () => {
    const rt = new FakeRuntime({
      onAgent: () => ({ verdict: 'refuted', reason: 'counterexample found' }),
    })
    const result = (await wf.run(rt, {
      claims: BASE_ARGS.claims,
      votes: 1,
      refuteThreshold: 1,
    })) as WfResult & { refuted: string[] }
    expect(result.refuted).toEqual(BASE_ARGS.claims)
  })
})

// ---------------------------------------------------------------------------
// perAgent — Class-A blanket per-agent defaults, wired via withAgentDefaults.
// This is the actual starvation fix: neither adversarialVerification nor
// probeAgentType owns a stallMs knob of their own, so a CLI-backed bridge
// (opencode) with a ~570-600s budget was silently killed by the sandbox's
// 180s default agent stall timeout. perAgent.stallMs is the existing generic
// channel (already proven in pr-review.workflow.ts) this workflow was simply
// never wired to.
// ---------------------------------------------------------------------------

describe('cross-model-verify — perAgent (withAgentDefaults wiring)', () => {
  it('threads perAgent.stallMs to the probe AND every verifier vote', async () => {
    const rt = makeRuntime()
    await wf.run(rt, {
      ...BASE_ARGS,
      agentTypes: { verify: 'workflow-toolbox:opencode-verifier' },
      perAgent: { stallMs: 650000 },
    })
    const probe = rt.calls.find((c) => c.opts?.label === 'probeAgentType:probe')!
    expect(probe.opts?.stallMs).toBe(650000)
    const verifierCalls = rt.calls.filter((c) => c.opts?.label?.startsWith('adversarialVerification:'))
    expect(verifierCalls.length).toBeGreaterThan(0)
    for (const c of verifierCalls) expect(c.opts?.stallMs).toBe(650000)
  })

  it('perAgent.model reaches the probe (it sets no model of its own) but NOT the verifier votes (adversarialVerification sets its own resolved model — haiku for an external RELAY verifier)', async () => {
    const rt = makeRuntime()
    await wf.run(rt, {
      ...BASE_ARGS,
      agentTypes: { verify: 'workflow-toolbox:opencode-verifier' },
      perAgent: { model: 'sonnet' },
    })
    const probe = rt.calls.find((c) => c.opts?.label === 'probeAgentType:probe')!
    expect(probe.opts?.model).toBe('sonnet')
    const verifierCalls = rt.calls.filter((c) =>
      c.opts?.label?.startsWith('adversarialVerification:verify:'),
    )
    expect(verifierCalls.length).toBeGreaterThan(0)
    // perAgent.model (sonnet) does NOT reach the verifier votes — the pattern owns the vote
    // model. Here verifierType routes to the EXTERNAL opencode relay, so the pattern defaults
    // the wrapper to 'haiku' (card #1825163461588419933): the wrapper only shells out to the
    // CLI, so a cheap relay model bounds a self-answer's cost. (Was 'opus'/BEST_MODEL before.)
    for (const c of verifierCalls) expect(c.opts?.model).toBe('haiku')
  })

  it('rejects an unknown perAgent key via the shared parseConfig validation', async () => {
    const rt = makeRuntime()
    await expect(
      wf.run(rt, { ...BASE_ARGS, perAgent: { bogus: 1 } }),
    ).rejects.toThrow(/unknown perAgent key/)
  })
})
