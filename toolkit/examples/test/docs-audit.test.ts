// docs-audit.test.ts — end-to-end composition test for the docs-audit workflow.
// Uses FakeRuntime with onAgent handler routing on prompt content.
// TDD: written before the implementation (RED step).

import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import wf from '../docs-audit.workflow.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeClaim {
  surface: string
  kind: string
  risk: string
  quote: string
  claim: string
  checkHint: string
}

function makeClaim(overrides: Partial<FakeClaim> = {}): FakeClaim {
  return {
    surface: 'docs/a.md',
    kind: 'behavior',
    risk: 'high',
    quote: 'the loop stops after two dry rounds',
    claim: 'loopUntilDone stops after two consecutive non-progressing rounds',
    checkHint: 'packages/patterns/src/loop-until-done.ts',
    ...overrides,
  }
}

/**
 * Build a FakeRuntime routing on UNIQUE phrases from the workflow prompts:
 *  0. probes:     "availability probe"                    → 'PROBE_OK'
 *  1. warmup:     "reply with a single word"              → 'ready'
 *  2. Inventory:  "inventory the documentation surfaces"  → { surfaces }
 *  3. Extract:    "extract checkable claims"              → { claims } (per-round)
 *  4. Verify:     "adversarially verify the following claim" → { verdict, reason }
 */
function makeRuntime(opts: {
  inventory?: string[] | null
  /** Claims returned per extraction ROUND (call order); rounds beyond the
   *  array's length repeat the LAST entry (which makes the loop go dry). */
  extractRounds: FakeClaim[][]
  /** quote substring → verdict for verifier votes (default 'confirmed'). */
  verdicts?: Record<string, string>
}): FakeRuntime {
  let extractCalls = 0
  return new FakeRuntime({
    onAgent: ({ prompt }: { prompt: string; index: number }) => {
      const p = prompt.toLowerCase()

      if (p.includes('availability probe')) return 'PROBE_OK'
      if (p.includes('reply with a single word')) return 'ready'

      if (p.includes('inventory the documentation surfaces')) {
        if (opts.inventory === null) return null
        return { surfaces: opts.inventory ?? ['docs/a.md', 'docs/b.md'] }
      }

      if (p.includes('extract checkable claims')) {
        const round = Math.min(extractCalls, opts.extractRounds.length - 1)
        extractCalls++
        return { claims: opts.extractRounds[round] }
      }

      if (p.includes('adversarially verify the following claim')) {
        for (const [needle, verdict] of Object.entries(opts.verdicts ?? {})) {
          if (p.includes(needle.toLowerCase())) {
            return { verdict, reason: `fake verdict for ${needle}` }
          }
        }
        return { verdict: 'confirmed', reason: 'matches the sources' }
      }

      return 'unrouted'
    },
  })
}

const BASE_INPUT = {
  repoRoot: '/repo',
  surfaces: ['docs/a.md', 'docs/b.md'],
}

// ---------------------------------------------------------------------------
// Test: workflow metadata
// ---------------------------------------------------------------------------

describe('docs-audit workflow metadata', () => {
  it('has correct name and phases', () => {
    expect(wf.meta.name).toBe('docs-audit')
    expect(wf.meta.description).toBeTruthy()
    const titles = wf.meta.phases?.map(p => p.title)
    expect(titles).toEqual(['Fence', 'Inventory', 'Extract', 'Verify', 'Report'])
  })
})

// ---------------------------------------------------------------------------
// Test: parseInput / fail-fast validation
// ---------------------------------------------------------------------------

describe('docs-audit parseInput', () => {
  const rt = () => makeRuntime({ extractRounds: [[]] })

  it('throws actionable error when repoRoot is missing', async () => {
    await expect(wf.run(rt(), JSON.stringify({}))).rejects.toThrow(/repoRoot/)
  })

  it('throws actionable error when repoRoot is empty', async () => {
    await expect(wf.run(rt(), JSON.stringify({ repoRoot: '  ' }))).rejects.toThrow(/repoRoot/)
  })

  it('throws when surfaces is provided but empty', async () => {
    await expect(
      wf.run(rt(), JSON.stringify({ repoRoot: '/repo', surfaces: [] })),
    ).rejects.toThrow(/surfaces/)
  })

  it('throws when surfaces contains a non-string', async () => {
    await expect(
      wf.run(rt(), JSON.stringify({ repoRoot: '/repo', surfaces: ['a.md', 5] })),
    ).rejects.toThrow(/surfaces/)
  })

  it.each([
    ['maxRounds', 0],
    ['dryRounds', 0],
    ['surfacesPerAgent', 0],
    ['votes', 0],
    ['maxVerifyClaims', 0],
  ])('throws when %s is below 1', async (field, value) => {
    await expect(
      wf.run(rt(), JSON.stringify({ ...BASE_INPUT, [field]: value })),
    ).rejects.toThrow(new RegExp(field))
  })

  it('throws when surfacesPerAgent exceeds 10', async () => {
    await expect(
      wf.run(rt(), JSON.stringify({ ...BASE_INPUT, surfacesPerAgent: 11 })),
    ).rejects.toThrow(/surfacesPerAgent/)
  })

  it('throws when verifierModel is not a known alias', async () => {
    await expect(
      wf.run(rt(), JSON.stringify({ ...BASE_INPUT, verifierModel: 'gpt-9' })),
    ).rejects.toThrow(/verifierModel/)
  })
})

// ---------------------------------------------------------------------------
// Test: happy path (surfaces provided — no inventory agent)
// ---------------------------------------------------------------------------

describe('docs-audit happy path', () => {
  const staleClaim = makeClaim({
    surface: 'docs/b.md',
    risk: 'medium',
    quote: 'the cap silently drops extra claims',
    claim: 'claims beyond the cap are dropped',
    checkHint: 'packages/patterns/src/envelope.ts',
  })
  const goodClaim = makeClaim()

  async function runHappy() {
    const rt = makeRuntime({
      // Round 1 discovers both claims; round 2 repeats them → dedup → dry stop.
      extractRounds: [[goodClaim, staleClaim], [goodClaim, staleClaim]],
      verdicts: { 'the cap silently drops': 'refuted' },
    })
    const out = await wf.run(rt, JSON.stringify(BASE_INPUT))
    return { rt, out }
  }

  it('audits the provided surfaces without an inventory agent', async () => {
    const { rt, out } = await runHappy()
    expect(out.surfaces).toEqual(['docs/a.md', 'docs/b.md'])
    expect(out.inventorySource).toBe('input')
    const inventoryCalls = rt.calls.filter(c =>
      String(c.prompt).toLowerCase().includes('inventory the documentation surfaces'))
    expect(inventoryCalls).toHaveLength(0)
  })

  it('stops the extraction loop on a dry round and reports it honestly', async () => {
    const { out } = await runHappy()
    expect(out.rounds).toBe(2)
    expect(out.stoppedBy).toBe('dryRounds')
    expect(out.extractionComplete).toBe(true)
    expect(out.claimsSeen).toBe(2)
  })

  it('verifies claims and reports the stale one as a finding', async () => {
    const { out } = await runHappy()
    expect(out.summary).toEqual({
      total: 2,
      confirmed: 1,
      stale: 1,
      partiallyStale: 0,
      unverifiable: 0,
      unverifiedByCap: 0,
    })
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0]?.quote).toBe('the cap silently drops extra claims')
    expect(out.findings[0]?.verdict).toBe('refuted')
    expect(out.findings[0]?.surface).toBe('docs/b.md')
  })

  it('embeds repoRoot in extract and verify prompts', async () => {
    const { rt } = await runHappy()
    const extract = rt.calls.filter(c =>
      String(c.prompt).toLowerCase().includes('extract checkable claims'))
    expect(extract.length).toBeGreaterThan(0)
    for (const c of extract) expect(String(c.prompt)).toContain('/repo')
    const verify = rt.calls.filter(c =>
      String(c.prompt).toLowerCase().includes('adversarially verify the following claim'))
    expect(verify.length).toBeGreaterThan(0)
    for (const c of verify) expect(String(c.prompt)).toContain('/repo')
  })

  it('exposes the envelope trail and the leaf-fence report', async () => {
    const { out } = await runHappy()
    expect(Array.isArray(out.envelope.trail)).toBe(true)
    expect(out.envelope.trail.length).toBeGreaterThan(0)
    expect(out.leafFence).toBeTruthy()
    expect(out.verifierProbe).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Test: inventory path (surfaces derived by agent)
// ---------------------------------------------------------------------------

describe('docs-audit inventory', () => {
  it('derives surfaces from the inventory agent when none are provided', async () => {
    const rt = makeRuntime({
      inventory: ['README.md', 'docs/x.md'],
      extractRounds: [[makeClaim({ surface: 'README.md' })], [makeClaim({ surface: 'README.md' })]],
    })
    const out = await wf.run(rt, JSON.stringify({ repoRoot: '/repo' }))
    expect(out.inventorySource).toBe('agent')
    expect(out.surfaces).toEqual(['README.md', 'docs/x.md'])
    const extract = rt.calls.filter(c =>
      String(c.prompt).toLowerCase().includes('extract checkable claims'))
    expect(String(extract[0]?.prompt)).toContain('README.md')
  })

  it('throws actionable error when the inventory agent fails', async () => {
    const rt = makeRuntime({ inventory: null, extractRounds: [[]] })
    await expect(wf.run(rt, JSON.stringify({ repoRoot: '/repo' }))).rejects.toThrow(/inventory/i)
  })

  it('throws actionable error when the inventory agent returns no surfaces', async () => {
    const rt = makeRuntime({ inventory: [], extractRounds: [[]] })
    await expect(wf.run(rt, JSON.stringify({ repoRoot: '/repo' }))).rejects.toThrow(/inventory/i)
  })
})

// ---------------------------------------------------------------------------
// Test: extraction loop mechanics
// ---------------------------------------------------------------------------

describe('docs-audit extraction loop', () => {
  it('dedups repeated claims across rounds and accumulates fresh ones', async () => {
    const a = makeClaim({ quote: 'first unique quote' })
    const b = makeClaim({ quote: 'second unique quote' })
    const rt = makeRuntime({
      // Round 1: a. Round 2: a (dup) + b (fresh). Round 3: same → dry.
      extractRounds: [[a], [a, b], [a, b]],
    })
    const out = await wf.run(rt, JSON.stringify(BASE_INPUT))
    expect(out.claimsSeen).toBe(2)
    expect(out.rounds).toBe(3)
    expect(out.stoppedBy).toBe('dryRounds')
  })

  it('stops at maxRounds when every round keeps finding fresh claims', async () => {
    let n = 0
    const rt = new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string; index: number }) => {
        const p = prompt.toLowerCase()
        if (p.includes('availability probe')) return 'PROBE_OK'
        if (p.includes('reply with a single word')) return 'ready'
        if (p.includes('extract checkable claims')) {
          n++
          return { claims: [makeClaim({ quote: `fresh quote number ${n}` })] }
        }
        if (p.includes('adversarially verify the following claim')) {
          return { verdict: 'confirmed', reason: 'ok' }
        }
        return 'unrouted'
      },
    })
    const out = await wf.run(rt, JSON.stringify({ ...BASE_INPUT, maxRounds: 2 }))
    expect(out.rounds).toBe(2)
    expect(out.stoppedBy).toBe('maxIterations')
    expect(out.extractionComplete).toBe(false)
    expect(out.claimsSeen).toBe(2)
  })

  it('drops claims whose surface is not in the audited set, with a warning', async () => {
    const rogue = makeClaim({ surface: 'not-in-list.md', quote: 'rogue quote' })
    const ok = makeClaim()
    const rt = makeRuntime({ extractRounds: [[ok, rogue], [ok, rogue]] })
    const out = await wf.run(rt, JSON.stringify(BASE_INPUT))
    expect(out.claimsSeen).toBe(1)
    expect(out.warnings.some((w) => w.includes('not-in-list.md'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Test: risk-sorted verification cap
// ---------------------------------------------------------------------------

describe('docs-audit verification cap', () => {
  it('verifies high-risk claims first and keeps capped-out claims as findings', async () => {
    const low = makeClaim({ risk: 'low', quote: 'low-risk quote text' })
    const high = makeClaim({ risk: 'high', quote: 'high-risk quote text' })
    const rt = makeRuntime({
      // Low-risk claim is DISCOVERED first — the sort must still verify high first.
      extractRounds: [[low, high], [low, high]],
    })
    const out = await wf.run(
      rt, JSON.stringify({ ...BASE_INPUT, maxVerifyClaims: 1 }),
    )

    const verify = rt.calls.filter(c =>
      String(c.prompt).toLowerCase().includes('adversarially verify the following claim'))
    expect(verify.length).toBeGreaterThan(0)
    for (const c of verify) expect(String(c.prompt)).toContain('high-risk quote text')

    expect(out.summary.unverifiedByCap).toBe(1)
    const capped = out.findings.filter((f) => f.verdict === 'unverified-by-cap')
    expect(capped).toHaveLength(1)
    expect(capped[0]?.quote).toBe('low-risk quote text')
    expect(out.warnings.some((w) => w.includes('maxVerifyClaims'))).toBe(true)
  })
})
