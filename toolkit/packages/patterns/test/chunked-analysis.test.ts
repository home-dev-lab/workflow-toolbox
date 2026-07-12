import { describe, it, expect } from 'vitest'
import { FakeRuntime, parseDigest } from '@workflow-toolbox/runtime'
import { chunkText, chunkedAnalysis } from '../src/chunked-analysis.js'
import type { ChunkedAnalysisOptions } from '../src/chunked-analysis.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOptions(
  overrides: Partial<ChunkedAnalysisOptions<string>> = {},
): ChunkedAnalysisOptions<string> {
  return {
    // "aaaa\nbbbb\ncccc" is 14 chars; with maxChars 5 it splits on the newlines.
    input: 'aaaa\nbbbb\ncccc',
    maxChars: 5,
    analyzePrompt: (chunk, i, total) => `analyze chunk ${i}/${total}: ${chunk}`,
    synthesizePrompt: (parts) => `synthesize: ${parts.join(', ')}`,
    ...overrides,
  }
}

function isSynthesisCall(label: string | undefined): boolean {
  return label === 'chunkedAnalysis:synthesize'
}

// ===========================================================================
// Chunker — pure function, unit-tested in isolation
// ===========================================================================

describe('chunkText — config validation', () => {
  it('rejects a non-integer or < 1 maxChars', () => {
    expect(() => chunkText('abc', { maxChars: 0 })).toThrow(/maxChars/)
    expect(() => chunkText('abc', { maxChars: -3 })).toThrow(/maxChars/)
    expect(() => chunkText('abc', { maxChars: 2.5 })).toThrow(/maxChars/)
  })

  it('rejects a negative or non-integer overlapChars', () => {
    expect(() => chunkText('abc', { maxChars: 4, overlapChars: -1 })).toThrow(/overlapChars/)
    expect(() => chunkText('abc', { maxChars: 4, overlapChars: 1.5 })).toThrow(/overlapChars/)
  })

  it('rejects overlapChars >= maxChars (no forward progress)', () => {
    expect(() => chunkText('abc', { maxChars: 4, overlapChars: 4 })).toThrow(/forward progress/)
    expect(() => chunkText('abc', { maxChars: 4, overlapChars: 9 })).toThrow(/forward progress/)
  })
})

describe('chunkText — hard character cuts', () => {
  it('splits a newline-free string at exactly maxChars', () => {
    expect(chunkText('abcdefghij', { maxChars: 4 })).toEqual(['abcd', 'efgh', 'ij'])
  })

  it('hard-cuts a single line longer than maxChars (line preference cannot help)', () => {
    expect(chunkText('aaaaaaaaaa', { maxChars: 4 })).toEqual(['aaaa', 'aaaa', 'aa'])
  })

  it('returns one chunk when the text fits under maxChars', () => {
    expect(chunkText('short', { maxChars: 100 })).toEqual(['short'])
  })
})

describe('chunkText — line-boundary preference', () => {
  it('cuts at the last newline before the limit, keeping whole lines together', () => {
    // "line1\nline2\nline3" = 17 chars; maxChars 10 cuts after each "\n".
    expect(chunkText('line1\nline2\nline3', { maxChars: 10 })).toEqual([
      'line1\n',
      'line2\n',
      'line3',
    ])
  })
})

describe('chunkText — overlap', () => {
  it('carries the previous chunk tail into the next chunk head', () => {
    expect(chunkText('abcdefghij', { maxChars: 5, overlapChars: 2 })).toEqual([
      'abcde',
      'defgh',
      'ghij',
    ])
  })

  it('skips overlap for a chunk no longer than the overlap (guarantees progress)', () => {
    // "a\nbcdefgh": the short "a\n" line-boundary chunk is shorter than the
    // overlap (4), so overlap is dropped for that step — no stall, still deterministic.
    expect(chunkText('a\nbcdefgh', { maxChars: 6, overlapChars: 4 })).toEqual([
      'a\n',
      'bcdefg',
      'defgh',
    ])
  })
})

describe('chunkText — string[] input (caller pre-chunks, each re-split)', () => {
  it('re-splits each element by maxChars and concatenates in element order', () => {
    expect(chunkText(['abcdef', 'gh'], { maxChars: 4 })).toEqual(['abcd', 'ef', 'gh'])
  })

  it('produces no chunks for empty strings', () => {
    expect(chunkText('', { maxChars: 4 })).toEqual([])
    expect(chunkText(['', 'ab', ''], { maxChars: 4 })).toEqual(['ab'])
  })
})

describe('chunkText — determinism', () => {
  it('produces identical output on repeated calls', () => {
    const a = chunkText('line1\nline2\nline3\nline4', { maxChars: 8, overlapChars: 2 })
    const b = chunkText('line1\nline2\nline3\nline4', { maxChars: 8, overlapChars: 2 })
    expect(a).toEqual(b)
  })
})

// ===========================================================================
// chunkedAnalysis — pattern
// ===========================================================================

describe('chunkedAnalysis — config validation', () => {
  it('propagates chunker config errors synchronously (bad maxChars)', async () => {
    const rt = new FakeRuntime()
    await expect(chunkedAnalysis(rt, makeOptions({ maxChars: 0 }))).rejects.toThrow(/maxChars/)
  })

  it('rejects when the input produces no chunks (empty input)', async () => {
    const rt = new FakeRuntime()
    await expect(chunkedAnalysis(rt, makeOptions({ input: '' }))).rejects.toThrow(/no chunks/i)
  })

  it('rejects when maxChunks < 1', async () => {
    const rt = new FakeRuntime()
    await expect(chunkedAnalysis(rt, makeOptions({ maxChunks: 0 }))).rejects.toThrow(/maxChunks/)
  })

  it('rejects an empty or whitespace-only analyzeType / synthesizeType', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'ok' })
    await expect(chunkedAnalysis(rt, makeOptions({ analyzeType: '' }))).rejects.toThrow(/analyzeType/)
    await expect(chunkedAnalysis(rt, makeOptions({ analyzeType: '  ' }))).rejects.toThrow(/analyzeType/)
    await expect(chunkedAnalysis(rt, makeOptions({ synthesizeType: '' }))).rejects.toThrow(/synthesizeType/)
  })
})

describe('chunkedAnalysis — happy path', () => {
  it('analyzes every chunk then synthesizes, with exact stats', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => (isSynthesisCall(opts?.label) ? 'final' : 'chunk-analysis'),
    })

    const result = await chunkedAnalysis(rt, makeOptions())

    // "aaaa\nbbbb\ncccc" at maxChars 5 → ["aaaa\n", "bbbb\n", "cccc"] (3 chunks)
    expect(result.value).toBe('final')
    expect(result.warnings).toHaveLength(0)
    expect(result.stats.itemsIn).toBe(3)
    expect(result.stats.itemsOut).toBe(3)
    expect(result.stats.dropped).toBe(0)
    expect(result.stats.truncated).toBe(0)
    // 3 chunk agents + 1 synthesis
    expect(result.stats.agentsSpawned).toBe(4)
    // surviving per-chunk analyses exposed in order
    expect(result.chunkResults).toEqual(['chunk-analysis', 'chunk-analysis', 'chunk-analysis'])
  })

  it('passes total = post-cap chunk count to the analyze prompt', async () => {
    const seenTotals: number[] = []
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => (isSynthesisCall(opts?.label) ? 'final' : 'a'),
    })
    await chunkedAnalysis(rt, makeOptions({
      analyzePrompt: (chunk, i, total) => { seenTotals.push(total); return `${i}/${total}:${chunk}` },
    }))
    expect(seenTotals).toEqual([3, 3, 3])
  })

  it('emits a phase digest with the synthesis handoff + funnel counts', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => (isSynthesisCall(opts?.label) ? 'final' : 'a'),
    })
    await chunkedAnalysis(rt, makeOptions())
    const digest = rt.logs.map(parseDigest).find((d) => d?.stage === 'chunkedAnalysis')
    expect(digest?.counts).toEqual({ chunks: 3, analyzed: 3, dropped: 0, truncated: 0 })
    expect(digest?.output).toBe('synthesis from 3/3 chunks')
  })

  it('assigns chunk / synthesis label shapes', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => (isSynthesisCall(opts?.label) ? 'final' : 'a'),
    })
    await chunkedAnalysis(rt, makeOptions())
    const labels = rt.calls.map((c) => c.opts?.label)
    expect(labels).toContain('chunkedAnalysis:chunk:0')
    expect(labels).toContain('chunkedAnalysis:chunk:1')
    expect(labels).toContain('chunkedAnalysis:chunk:2')
    expect(labels).toContain('chunkedAnalysis:synthesize')
  })
})

describe('chunkedAnalysis — all analyses null', () => {
  it('skips synthesis, returns null value, warns', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => (isSynthesisCall(opts?.label) ? 'final' : null),
    })

    const result = await chunkedAnalysis(rt, makeOptions())

    expect(result.value).toBeNull()
    expect(rt.calls.find((c) => isSynthesisCall(c.opts?.label))).toBeUndefined()
    expect(result.stats.agentsSpawned).toBe(3) // only chunk agents
    expect(result.chunkResults).toEqual([])
    expect(result.warnings.some((w) => /synthesis skipped/.test(w))).toBe(true)
  })
})

describe('chunkedAnalysis — synthesis null', () => {
  it('returns null and warns when the synthesis agent returns null', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => (isSynthesisCall(opts?.label) ? null : 'a'),
    })

    const result = await chunkedAnalysis(rt, makeOptions())

    expect(result.value).toBeNull()
    expect(result.warnings.some((w) => w.includes('synthesis') && w.includes('null'))).toBe(true)
    expect(rt.logs.some((l) => l.includes('synthesis') && l.includes('null'))).toBe(true)
  })
})

describe('chunkedAnalysis — partial null fan-out', () => {
  it('drops null analyses, warns, passes only survivors to synthesis in order', async () => {
    const captured: string[] = []
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'final'
        if (opts?.label === 'chunkedAnalysis:chunk:1') return null
        return `a-${opts?.label?.split(':').pop() ?? ''}`
      },
    })

    const result = await chunkedAnalysis(rt, makeOptions({
      synthesizePrompt: (parts) => { captured.push(...parts); return 'synth' },
    }))

    expect(result.stats.dropped).toBe(1)
    expect(result.stats.itemsOut).toBe(2)
    expect(result.warnings.some((w) => w.includes('null'))).toBe(true)
    expect(captured).toEqual(['a-0', 'a-2'])
    expect(result.chunkResults).toEqual(['a-0', 'a-2'])
  })
})

describe('chunkedAnalysis — truncation', () => {
  it('applies the maxChunks cap and reports truncated + warning', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => (isSynthesisCall(opts?.label) ? 'final' : 'a'),
    })

    const result = await chunkedAnalysis(rt, makeOptions({ maxChunks: 2 }))

    // 3 chunks, cap 2 → 1 truncated
    expect(result.stats.itemsIn).toBe(3)
    expect(result.stats.truncated).toBe(1)
    expect(result.stats.agentsSpawned).toBe(3) // 2 chunks + 1 synthesis
    expect(result.warnings.some((w) => w.includes('truncated'))).toBe(true)
    const digest = rt.logs.map(parseDigest).find((d) => d?.stage === 'chunkedAnalysis')
    expect(digest?.counts).toEqual({ chunks: 3, analyzed: 2, dropped: 0, truncated: 1 })
  })
})

describe('chunkedAnalysis — agentType routing (leaf-fence default)', () => {
  it('omits agentType on every call when neither analyzeType nor synthesizeType is set', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'ok' })
    await chunkedAnalysis(rt, makeOptions())
    expect(rt.calls.every((c) => c.opts?.agentType === undefined)).toBe(true)
  })

  it('threads analyzeType to the chunk agents only (not synthesis)', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'ok' })
    await chunkedAnalysis(rt, makeOptions({ analyzeType: 'codex:codex-rescue' }))
    const chunkCalls = rt.calls.filter((c) => !isSynthesisCall(c.opts?.label))
    const synthCalls = rt.calls.filter((c) => isSynthesisCall(c.opts?.label))
    expect(chunkCalls.length).toBe(3)
    expect(chunkCalls.every((c) => c.opts?.agentType === 'codex:codex-rescue')).toBe(true)
    expect(synthCalls.every((c) => c.opts?.agentType === undefined)).toBe(true)
  })

  it('threads synthesizeType to the synthesis agent only (not the chunks)', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'ok' })
    await chunkedAnalysis(rt, makeOptions({ synthesizeType: 'workflow-toolbox:opencode-verifier' }))
    const chunkCalls = rt.calls.filter((c) => !isSynthesisCall(c.opts?.label))
    const synthCalls = rt.calls.filter((c) => isSynthesisCall(c.opts?.label))
    expect(synthCalls.every((c) => c.opts?.agentType === 'workflow-toolbox:opencode-verifier')).toBe(true)
    expect(chunkCalls.every((c) => c.opts?.agentType === undefined)).toBe(true)
  })
})

describe('chunkedAnalysis — schema/model/effort forwarding', () => {
  it('forwards analyzeSchema to the chunk agents', async () => {
    const analyzeSchema = { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] }
    let captured: unknown = null
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'final'
        captured = opts?.schema
        return { v: 'x' }
      },
    })
    await chunkedAnalysis(rt, makeOptions({ input: 'abc', maxChars: 100, analyzeSchema }))
    expect(captured).toEqual(analyzeSchema)
  })

  it('forwards analyzeModel/synthesizeModel and analyzeEffort/synthesizeEffort', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => (isSynthesisCall(opts?.label) ? 'final' : 'a'),
    })
    await chunkedAnalysis(rt, makeOptions({
      analyzeModel: 'haiku', synthesizeModel: 'opus',
      analyzeEffort: 'low', synthesizeEffort: 'high',
    }))
    const chunkCalls = rt.calls.filter((c) => !isSynthesisCall(c.opts?.label))
    const synthCall = rt.calls.find((c) => isSynthesisCall(c.opts?.label))
    expect(chunkCalls.every((c) => c.opts?.model === 'haiku' && c.opts?.effort === 'low')).toBe(true)
    expect(synthCall?.opts?.model).toBe('opus')
    expect(synthCall?.opts?.effort).toBe('high')
  })
})

describe('chunkedAnalysis — phase propagation', () => {
  it('forwards opts.phase to all agent calls', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => (isSynthesisCall(opts?.label) ? 'final' : 'a'),
    })
    await chunkedAnalysis(rt, makeOptions({ phase: 'Map' }))
    expect(rt.calls.every((c) => c.phase === 'Map')).toBe(true)
  })

  it('leaves phase undefined when not set', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => (isSynthesisCall(opts?.label) ? 'final' : 'a'),
    })
    await chunkedAnalysis(rt, makeOptions())
    expect(rt.calls.every((c) => c.phase === undefined)).toBe(true)
  })
})

describe('chunkedAnalysis — budget guard', () => {
  it('degrades every chunk to null under a zero budget and skips synthesis', async () => {
    // budgetTotal 0 → the first agent() call already exceeds the ceiling and
    // throws; rt.parallel catches each throw as null → all chunks dropped, so
    // synthesis is skipped (never spawned). No throw escapes the pattern.
    const rt = new FakeRuntime({ onAgent: () => 'a', budgetTotal: 0, agentTokenCost: 1 })
    const result = await chunkedAnalysis(rt, makeOptions())
    expect(result.value).toBeNull()
    expect(result.stats.dropped).toBe(3)
    expect(rt.calls.find((c) => isSynthesisCall(c.opts?.label))).toBeUndefined()
    expect(result.warnings.some((w) => /synthesis skipped/.test(w))).toBe(true)
  })

  it('surfaces a budget-exhausted synthesis as a throw (barrier-pattern contract)', async () => {
    // Budget covers exactly the 3 chunk agents; the synthesis call then has no
    // remaining budget and throws — matching fanOutAndSynthesize/planAndExecute
    // (a direct synthesis await propagates a hard budget stop, not a null degrade).
    const rt = new FakeRuntime({ onAgent: () => 'a', budgetTotal: 3, agentTokenCost: 1 })
    await expect(chunkedAnalysis(rt, makeOptions())).rejects.toThrow(/budget/i)
  })
})

describe('chunkedAnalysis — audit trail', () => {
  it('records one chunk entry per agent in index order + a final synthesis entry', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => (isSynthesisCall(opts?.label) ? 'final' : 'a'),
    })
    const result = await chunkedAnalysis(rt, makeOptions())

    expect(result.trail).toHaveLength(result.stats.agentsSpawned)
    expect(result.trail).toHaveLength(4)
    expect(result.trail[0]!.stage).toBe('chunkedAnalysis:chunk:0')
    expect(result.trail[1]!.stage).toBe('chunkedAnalysis:chunk:1')
    expect(result.trail[2]!.stage).toBe('chunkedAnalysis:chunk:2')
    expect(result.trail[3]!.stage).toBe('chunkedAnalysis:synthesize')
    expect(result.trail.every((r) => r.outcome === 'ok')).toBe(true)
  })

  it('records outcome=null at the correct chunk index for a partial fan-out', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'final'
        return opts?.label === 'chunkedAnalysis:chunk:1' ? null : 'a'
      },
    })
    const result = await chunkedAnalysis(rt, makeOptions())
    expect(result.trail[0]!.outcome).toBe('ok')
    expect(result.trail[1]!.outcome).toBe('null')
    expect(result.trail[2]!.outcome).toBe('ok')
    expect(result.trail[3]!.outcome).toBe('ok')
  })

  it('records model/effort overrides on the matching records only', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => (isSynthesisCall(opts?.label) ? 'final' : 'a'),
    })
    const result = await chunkedAnalysis(rt, makeOptions({
      analyzeModel: 'haiku', analyzeEffort: 'low', synthesizeModel: 'opus',
    }))
    expect(result.trail[0]!.model).toBe('haiku')
    expect(result.trail[0]!.effort).toBe('low')
    expect(result.trail[3]!.model).toBe('opus')
    expect(result.trail[3]!).not.toHaveProperty('effort')
  })

  it('omits model/effort fields when no override is set', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => (isSynthesisCall(opts?.label) ? 'final' : 'a'),
    })
    const result = await chunkedAnalysis(rt, makeOptions())
    for (const rec of result.trail) {
      expect(rec).not.toHaveProperty('model')
      expect(rec).not.toHaveProperty('effort')
    }
  })

  it('produces an identical trail on two runs of the same scenario', async () => {
    const makeRt = () => new FakeRuntime({
      onAgent: ({ opts }) => (isSynthesisCall(opts?.label) ? 'final' : 'a'),
    })
    const a = await chunkedAnalysis(makeRt(), makeOptions())
    const b = await chunkedAnalysis(makeRt(), makeOptions())
    expect(a.trail).toEqual(b.trail)
  })
})

// ---------------------------------------------------------------------------
// cacheWarm (opt-in, mechanism a — first-completes-then-burst)
// ---------------------------------------------------------------------------

describe('chunkedAnalysis — cacheWarm=false (default, inert)', () => {
  it('is byte-identical to omitting the option: same stats, same trail', async () => {
    const rtOmitted = new FakeRuntime({
      onAgent: ({ opts }) => (isSynthesisCall(opts?.label) ? 'final' : 'a'),
    })
    const rtFalse = new FakeRuntime({
      onAgent: ({ opts }) => (isSynthesisCall(opts?.label) ? 'final' : 'a'),
    })

    const resultOmitted = await chunkedAnalysis(rtOmitted, makeOptions())
    const resultFalse = await chunkedAnalysis(rtFalse, makeOptions({ cacheWarm: false }))

    expect(resultFalse.stats).toEqual(resultOmitted.stats)
    expect(resultFalse.trail).toEqual(resultOmitted.trail)
    expect(rtFalse.calls.map(c => c.opts?.label)).toEqual(rtOmitted.calls.map(c => c.opts?.label))
  })
})

describe('chunkedAnalysis — cacheWarm=true (staggered)', () => {
  it('awaits chunk:0 to completion before chunk:1/chunk:2 are invoked', async () => {
    let laterChunkStartedBeforeFirstResolved = false
    let firstResolved = false
    let resolveFirst: (v: string) => void = () => {}

    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'final'
        if (opts?.label === 'chunkedAnalysis:chunk:0') {
          return new Promise<string>((resolve) => {
            resolveFirst = (v) => { firstResolved = true; resolve(v) }
          })
        }
        if (!firstResolved) laterChunkStartedBeforeFirstResolved = true
        return 'a'
      },
    })

    const promise = chunkedAnalysis(rt, makeOptions({ cacheWarm: true }))
    await Promise.resolve()
    await Promise.resolve()

    expect(laterChunkStartedBeforeFirstResolved).toBe(false)
    expect(rt.calls.map(c => c.opts?.label)).toEqual(['chunkedAnalysis:chunk:0'])

    resolveFirst('first-chunk-result')
    const result = await promise

    expect(result.stats.agentsSpawned).toBe(4) // 3 chunks + 1 synthesis
  })

  it('does not add an extra agent — stats/agentsSpawned match the un-staggered run', async () => {
    const rtWarm = new FakeRuntime({
      onAgent: ({ opts }) => (isSynthesisCall(opts?.label) ? 'final' : 'a'),
    })
    const rtPlain = new FakeRuntime({
      onAgent: ({ opts }) => (isSynthesisCall(opts?.label) ? 'final' : 'a'),
    })

    const resultWarm = await chunkedAnalysis(rtWarm, makeOptions({ cacheWarm: true }))
    const resultPlain = await chunkedAnalysis(rtPlain, makeOptions())

    expect(resultWarm.stats).toEqual(resultPlain.stats)
    expect(resultWarm.trail).toEqual(resultPlain.trail)
  })
})
