import { describe, expect, it } from 'vitest'
import { parseDagArtifact, serializeDagArtifact } from '../src/dag-artifact.js'

describe('dagArtifact', () => {
  it('round-trips through JSON stringify/parse', () => {
    const artifact = serializeDagArtifact({
      name: 'review-plan',
      createdAt: '2026-08-04T12:00:00.000Z',
      nodes: [
        { id: 'collect', dependsOn: [], label: 'Collect evidence' },
        { id: 'verify', dependsOn: ['collect'], label: 'Verify findings' },
      ],
    })

    const parsed = parseDagArtifact(JSON.parse(JSON.stringify(artifact)))

    expect(parsed).toEqual(artifact)
  })

  it('can be reconstructed by a fresh reader from a hand-written literal', () => {
    const parsed = parseDagArtifact({
      schemaVersion: 1,
      name: 'handwritten',
      createdAt: '2026-08-04T12:34:56.000Z',
      nodes: [
        { id: 'A', dependsOn: [], label: 'First step' },
        { id: 'B', dependsOn: ['A'] },
      ],
    })

    expect(parsed).toEqual({
      schemaVersion: 1,
      name: 'handwritten',
      createdAt: '2026-08-04T12:34:56.000Z',
      nodes: [
        { id: 'A', dependsOn: [], label: 'First step' },
        { id: 'B', dependsOn: ['A'] },
      ],
    })
  })

  it('throws on malformed input, naming the defect', () => {
    expect(() => parseDagArtifact({ schemaVersion: 1, name: 'x', createdAt: '2026-08-04T12:00:00.000Z' })).toThrow(/nodes is missing/i)
    expect(() => parseDagArtifact({ schemaVersion: 2, name: 'x', createdAt: '2026-08-04T12:00:00.000Z', nodes: [] })).toThrow(/schemaVersion/i)
    expect(() => parseDagArtifact({ schemaVersion: 1, name: 'x', createdAt: '2026-08-04T12:00:00.000Z', nodes: [{ dependsOn: [] }] })).toThrow(/nodes\[0\]\.id/i)
  })

  it('throws on graph-level defects a per-node check cannot see: duplicate ids and dangling references', () => {
    expect(() =>
      parseDagArtifact({
        schemaVersion: 1,
        name: 'x',
        createdAt: '2026-08-04T12:00:00.000Z',
        nodes: [{ id: 'A', dependsOn: [] }, { id: 'A', dependsOn: [] }],
      }),
    ).toThrow(/duplicate node id "A"/i)

    expect(() =>
      parseDagArtifact({
        schemaVersion: 1,
        name: 'x',
        createdAt: '2026-08-04T12:00:00.000Z',
        nodes: [{ id: 'A', dependsOn: ['missing'] }],
      }),
    ).toThrow(/depends on unknown id "missing"/i)
  })

  it('rejects a sparse dependsOn array instead of silently dropping the hole', () => {
    // A hole (index never assigned) is invisible to .every()/.map() but NOT
    // to an indexed loop — this proves the parser uses the latter.
    const sparse: unknown[] = new Array(1)
    expect(() =>
      parseDagArtifact({
        schemaVersion: 1,
        name: 'x',
        createdAt: '2026-08-04T12:00:00.000Z',
        nodes: [{ id: 'A', dependsOn: sparse }],
      }),
    ).toThrow(/dependsOn must contain only strings/i)
  })
})
