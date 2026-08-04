import { describe, expect, it } from 'vitest'
import { FakeRuntime, parseDigest } from '@workflow-toolbox/runtime'
import { dagExecute } from '../src/dag-execute.js'

describe('dagExecute', () => {
  it('runs independent nodes in the same wave concurrently', async () => {
    const rt = new FakeRuntime()
    const delayMs = 50
    const started: string[] = []

    const start = Date.now()
    const result = await dagExecute(rt, {
      nodes: [
        { id: 'A', dependsOn: [] },
        { id: 'B', dependsOn: [] },
      ],
      run: async (node) => {
        started.push(node.id)
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        return `${node.id}-done`
      },
    })
    const elapsed = Date.now() - start

    expect(started).toEqual(['A', 'B'])
    expect(elapsed).toBeLessThan(delayMs * 2 - 10)
    expect(result.value.waves).toBe(1)
    expect(result.stats.agentsSpawned).toBe(2)
  })

  it('computes a diamond graph as two waves', async () => {
    const rt = new FakeRuntime()
    const result = await dagExecute(rt, {
      nodes: [
        { id: 'A', dependsOn: [] },
        { id: 'B', dependsOn: [] },
        { id: 'C', dependsOn: ['A', 'B'] },
      ],
      run: async (node) => node.id,
      phase: 'dag-phase',
    })

    expect(result.value.waves).toBe(2)
    expect(result.value.results).toEqual([
      { node: { id: 'A', dependsOn: [] }, status: 'succeeded', value: 'A' },
      { node: { id: 'B', dependsOn: [] }, status: 'succeeded', value: 'B' },
      { node: { id: 'C', dependsOn: ['A', 'B'] }, status: 'succeeded', value: 'C' },
    ])
    expect(result.trail.map((record) => record.stage)).toEqual([
      'dagExecute:run:0',
      'dagExecute:run:1',
      'dagExecute:run:2',
    ])
    const digest = rt.logs.map(parseDigest).find((entry) => entry?.stage === 'dagExecute')
    expect(digest?.phase).toBe('dag-phase')
  })

  it('skips dependents of a failed node', async () => {
    const rt = new FakeRuntime()
    const result = await dagExecute(rt, {
      nodes: [
        { id: 'A', dependsOn: [] },
        { id: 'B', dependsOn: ['A'] },
      ],
      run: async (node) => (node.id === 'A' ? null : `${node.id}-done`),
    })

    expect(result.value.results).toEqual([
      { node: { id: 'A', dependsOn: [] }, status: 'failed', value: null },
      { node: { id: 'B', dependsOn: ['A'] }, status: 'skipped', value: null },
    ])
    expect(result.stats.itemsOut).toBe(0)
    expect(result.stats.agentsSpawned).toBe(1)
    expect(result.stats.dropped).toBe(2)
    expect(result.trail).toHaveLength(1)
    expect(result.warnings.join(' ')).toContain('skipped node "B"')
  })

  it('throws synchronously on a cycle', async () => {
    const rt = new FakeRuntime()
    await expect(
      dagExecute(rt, {
        nodes: [
          { id: 'A', dependsOn: ['B'] },
          { id: 'B', dependsOn: ['A'] },
        ],
        run: async () => 'ok',
      }),
    ).rejects.toThrow(/cycle/i)
  })

  it('throws synchronously on an unknown dependency reference', async () => {
    const rt = new FakeRuntime()
    await expect(
      dagExecute(rt, {
        nodes: [{ id: 'A', dependsOn: ['missing'] }],
        run: async () => 'ok',
      }),
    ).rejects.toThrow(/unknown id "missing"/i)
  })
})
