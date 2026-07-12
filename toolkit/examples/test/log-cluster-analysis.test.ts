// log-cluster-analysis.test.ts — end-to-end composition test for the
// chunkedAnalysis example. Uses FakeRuntime with an onAgent handler routing on
// prompt content (analyze chunk vs synthesis).

import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import wf from '../log-cluster-analysis.workflow.js'

// A small multi-line log that splits into several chunks at a low maxChars.
const LOG = [
  'INFO service starting',
  'ERROR OutOfMemory at handler',
  'WARN slow query 1200ms',
  'ERROR OutOfMemory at worker',
  'INFO request served',
  'ERROR NullPointer at parse',
].join('\n')

function isSynthesis(prompt: string): boolean {
  return prompt.toLowerCase().includes('merge these per-chunk error findings')
}

function makeHappyRuntime(): FakeRuntime {
  return new FakeRuntime({
    onAgent: ({ prompt }: { prompt: string; index: number }) => {
      if (isSynthesis(prompt)) {
        return {
          clusters: [
            { label: 'OutOfMemory', totalCount: 2 },
            { label: 'NullPointer', totalCount: 1 },
          ],
          summary: 'OutOfMemory dominates; one NullPointer.',
        }
      }
      return { hasErrors: true, signatures: [{ kind: 'error', count: 1 }] }
    },
  })
}

describe('log-cluster-analysis metadata', () => {
  it('has the expected name and phases', () => {
    expect(wf.meta.name).toBe('log-cluster-analysis')
    expect(wf.meta.description).toBeTruthy()
    const titles = wf.meta.phases?.map((p) => p.title)
    expect(titles).toEqual(['Analyze', 'Report'])
  })
})

describe('log-cluster-analysis parseInput', () => {
  it('throws when log is missing or empty', async () => {
    const rt = makeHappyRuntime()
    await expect(wf.run(rt, JSON.stringify({}))).rejects.toThrow(/log/)
    await expect(wf.run(rt, JSON.stringify({ log: '' }))).rejects.toThrow(/log/)
  })

  it('throws when maxChars is invalid', async () => {
    const rt = makeHappyRuntime()
    await expect(wf.run(rt, JSON.stringify({ log: LOG, maxChars: 0 }))).rejects.toThrow(/maxChars/)
  })

  it('throws when overlapChars >= maxChars', async () => {
    const rt = makeHappyRuntime()
    await expect(wf.run(rt, JSON.stringify({ log: LOG, maxChars: 10, overlapChars: 10 }))).rejects.toThrow(/overlapChars/)
  })

  it('throws when maxChunks < 1', async () => {
    const rt = makeHappyRuntime()
    await expect(wf.run(rt, JSON.stringify({ log: LOG, maxChunks: 0 }))).rejects.toThrow(/maxChunks/)
  })
})

describe('log-cluster-analysis happy path', () => {
  it('chunks, analyzes each chunk, and synthesizes a clustered report', async () => {
    const rt = makeHappyRuntime()
    const result = await wf.run(rt, JSON.stringify({ log: LOG, maxChars: 25 }))

    expect(result.report).not.toBeNull()
    expect(result.report?.clusters?.[0]?.label).toBe('OutOfMemory')
    expect(result.chunksTotal).toBeGreaterThan(1)
    expect(result.chunksAnalyzed).toBe(result.chunksTotal)
    expect(result.dropped).toBe(0)
    expect(result.truncated).toBe(0)
    expect(Array.isArray(result.warnings)).toBe(true)
    // trail: one record per chunk agent + one synthesis record
    expect(result.envelope.trail.length).toBe(result.chunksTotal + 1)
  })

  it('records the Analyze and Report phases', async () => {
    const rt = makeHappyRuntime()
    await wf.run(rt, JSON.stringify({ log: LOG, maxChars: 25 }))
    expect(rt.phases).toContain('Analyze')
    expect(rt.phases).toContain('Report')
  })
})

describe('log-cluster-analysis truncation', () => {
  it('honors maxChunks and reports truncated chunks', async () => {
    const rt = makeHappyRuntime()
    const result = await wf.run(rt, JSON.stringify({ log: LOG, maxChars: 25, maxChunks: 1 }))
    expect(result.chunksAnalyzed).toBe(1)
    expect(result.truncated).toBeGreaterThan(0)
  })
})

describe('log-cluster-analysis degradation', () => {
  it('returns a null report and warns when every chunk analysis fails', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string; index: number }) =>
        isSynthesis(prompt) ? { clusters: [], summary: 'x' } : null,
    })
    const result = await wf.run(rt, JSON.stringify({ log: LOG, maxChars: 25 }))
    expect(result.report).toBeNull()
    expect(result.dropped).toBeGreaterThan(0)
    expect(result.warnings.length).toBeGreaterThan(0)
  })
})
