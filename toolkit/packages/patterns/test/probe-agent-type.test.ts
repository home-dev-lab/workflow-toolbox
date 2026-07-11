import { describe, it, expect } from 'vitest'
import { FakeRuntime, parseDigest } from '@workflow-toolbox/runtime'
import { probeAgentType } from '../src/probe-agent-type.js'

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe('probeAgentType — config validation', () => {
  it('rejects an empty or whitespace-only agentType', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    await expect(probeAgentType(rt, '')).rejects.toThrow(/agentType/)
    await expect(probeAgentType(rt, '   ')).rejects.toThrow(/agentType/)
  })
})

// ---------------------------------------------------------------------------
// Available path — the external bridge answered the probe task
// ---------------------------------------------------------------------------

describe('probeAgentType — available', () => {
  it('resolves to the requested agentType when the probe replies the default token', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    const probe = await probeAgentType(rt, 'workflow-toolbox:opencode-verifier')
    expect(probe).toEqual({
      agentType: 'workflow-toolbox:opencode-verifier',
      available: true,
      reason: null,
    })
  })

  it('uses a distinctive default token (a bare OK reply is NOT accepted)', async () => {
    // Review finding: 'not OK' ends with 'OK' — an end-anchored match on a
    // natural word is negation-prone. The artificial PROBE_OK token makes a
    // natural-language negation ending exactly with it implausible.
    const rt = new FakeRuntime({ onAgent: () => 'OK' })
    const probe = await probeAgentType(rt, 'workflow-toolbox:opencode-verifier')
    expect(probe.available).toBe(false)
  })

  it('tolerates CLI banner noise and ANSI escapes around the expected token', async () => {
    // Real opencode output shape observed live: '\x1b[0m> build · glm-5.2\x1b[0mPROBE_OK'
    const rt = new FakeRuntime({ onAgent: () => '[0m> build · glm-5.2[0mPROBE_OK' })
    const probe = await probeAgentType(rt, 'workflow-toolbox:opencode-verifier')
    expect(probe.available).toBe(true)
    expect(probe.agentType).toBe('workflow-toolbox:opencode-verifier')
  })

  it('spawns exactly one probe agent, routed through the requested type, with NO schema', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    await probeAgentType(rt, 'codex:codex-rescue')
    expect(rt.calls.length).toBe(1)
    const call = rt.calls[0]!
    expect(call.opts?.agentType).toBe('codex:codex-rescue')
    expect(call.opts?.label).toBe('probeAgentType:probe')
    // CRITICAL: the probe must never force a schema — the unavailability marker
    // is a plain string and must not enter the StructuredOutput retry loop.
    expect(call.opts?.schema).toBeUndefined()
  })

  it('threads phase to the probe call', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    await probeAgentType(rt, 'codex:codex-rescue', { phase: 'Probe' })
    expect(rt.calls[0]!.opts?.phase).toBe('Probe')
  })

  it('logs the routing decision (never silent)', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    await probeAgentType(rt, 'codex:codex-rescue')
    expect(rt.logs.some((l) => l.includes('codex:codex-rescue') && /available/i.test(l))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Unavailable paths — marker, null, unexpected text
// ---------------------------------------------------------------------------

describe('probeAgentType — unavailable', () => {
  it('falls back (agentType undefined) on the OPENCODE_UNAVAILABLE marker, preserving the reason', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'OPENCODE_UNAVAILABLE: no opencode binary on PATH' })
    const probe = await probeAgentType(rt, 'workflow-toolbox:opencode-verifier')
    expect(probe.available).toBe(false)
    expect(probe.agentType).toBeUndefined()
    expect(probe.reason).toContain('OPENCODE_UNAVAILABLE: no opencode binary on PATH')
  })

  it('extracts the reason FROM the marker even after a long banner (never truncated away)', async () => {
    // Review finding: head(reply) took the FIRST 200 chars — a long CLI banner
    // could push the marker + its reason past the excerpt entirely.
    const banner = 'banner '.repeat(40) // ~280 chars of preamble
    const rt = new FakeRuntime({
      onAgent: () => `${banner}OPENCODE_UNAVAILABLE: credential expired for provider zai`,
    })
    const probe = await probeAgentType(rt, 'workflow-toolbox:opencode-verifier')
    expect(probe.available).toBe(false)
    expect(probe.reason).toContain('OPENCODE_UNAVAILABLE: credential expired for provider zai')
  })

  it('treats ANY *_UNAVAILABLE-style marker as unavailable (generic contract)', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'CODEX_UNAVAILABLE: not logged in' })
    const probe = await probeAgentType(rt, 'codex:codex-rescue')
    expect(probe.available).toBe(false)
    expect(probe.agentType).toBeUndefined()
  })

  it('falls back on a non-string probe reply (defensive vs test-runtime handlers)', async () => {
    const rt = new FakeRuntime({ onAgent: () => ({ verdict: 'confirmed' }) })
    const probe = await probeAgentType(rt, 'workflow-toolbox:opencode-verifier')
    expect(probe.available).toBe(false)
    expect(probe.reason).toContain('non-string')
  })

  it('falls back when the probe agent returns null (opaque failure)', async () => {
    const rt = new FakeRuntime({ onAgent: () => null })
    const probe = await probeAgentType(rt, 'workflow-toolbox:opencode-verifier')
    expect(probe.available).toBe(false)
    expect(probe.agentType).toBeUndefined()
    expect(probe.reason).toMatch(/null/i)
  })

  it('falls back on unexpected reply text (e.g. a verbatim CLI error), keeping a head excerpt', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'Error: request timed out after 570s' })
    const probe = await probeAgentType(rt, 'workflow-toolbox:opencode-verifier')
    expect(probe.available).toBe(false)
    expect(probe.reason).toContain('request timed out')
  })

  it('UNAVAILABLE beats an incidental OK in the same reply (negative checked first)', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'OK, but OPENCODE_UNAVAILABLE: credential expired' })
    const probe = await probeAgentType(rt, 'workflow-toolbox:opencode-verifier')
    expect(probe.available).toBe(false)
  })

  it('falls back when the probe agent THROWS (e.g. unknown agentType in this session registry)', async () => {
    // Real failure observed live (headless/server-launched run, 2026-07-09):
    // plugin agents are not registered there, and the runtime THROWS on an
    // unknown agentType instead of returning null. The probe must catch and
    // degrade — this is the most common unavailability mode for consumers
    // who don't have the bridge plugin installed.
    const rt = new FakeRuntime({
      onAgent: () => {
        throw new Error(
          "agent({agentType}): agent type 'workflow-toolbox:opencode-verifier' not found. Available agents: claude, Explore",
        )
      },
    })
    const probe = await probeAgentType(rt, 'workflow-toolbox:opencode-verifier')
    expect(probe.available).toBe(false)
    expect(probe.agentType).toBeUndefined()
    expect(probe.reason).toContain('not found')
  })

  it('logs the fallback with its reason (never silent)', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'OPENCODE_UNAVAILABLE: no credential' })
    await probeAgentType(rt, 'workflow-toolbox:opencode-verifier')
    expect(
      rt.logs.some((l) => /fall(ing)? back/i.test(l) && l.includes('no credential')),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Options — custom probe prompt / expected token
// ---------------------------------------------------------------------------

describe('probeAgentType — options', () => {
  it('uses the custom probePrompt when given', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    await probeAgentType(rt, 'codex:codex-rescue', { probePrompt: 'Custom availability ping. Reply: OK' })
    expect(rt.calls[0]!.prompt).toBe('Custom availability ping. Reply: OK')
  })

  it('matches a custom expectedToken instead of OK', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'READY' })
    const probe = await probeAgentType(rt, 'codex:codex-rescue', {
      probePrompt: 'Reply with exactly: READY',
      expectedToken: 'READY',
    })
    expect(probe.available).toBe(true)
    // and the default token would NOT have matched
    const rt2 = new FakeRuntime({ onAgent: () => 'READY' })
    const probe2 = await probeAgentType(rt2, 'codex:codex-rescue')
    expect(probe2.available).toBe(false)
  })

  it('rejects an empty expectedToken', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    await expect(
      probeAgentType(rt, 'codex:codex-rescue', { expectedToken: ' ' }),
    ).rejects.toThrow(/expectedToken/)
  })
})

// ---------------------------------------------------------------------------
// Phase digest — one per probe run, both outcomes
// ---------------------------------------------------------------------------

describe('probeAgentType — phase digest', () => {
  it('emits an available digest', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'PROBE_OK' })
    await probeAgentType(rt, 'codex:codex-rescue')
    const digest = rt.logs.map(parseDigest).find((d) => d?.stage === 'probeAgentType')
    expect(digest?.output).toContain('available')
  })

  it('emits a fallback digest when unavailable', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'OPENCODE_UNAVAILABLE: x' })
    await probeAgentType(rt, 'codex:codex-rescue')
    const digest = rt.logs.map(parseDigest).find((d) => d?.stage === 'probeAgentType')
    expect(digest?.output).toContain('fallback')
  })
})
