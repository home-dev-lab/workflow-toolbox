import { describe, expect, it } from 'vitest'
// @ts-expect-error TS7016 -- shipped JavaScript outside the TS project
import { transcriptLocality, isProvenForeign } from '../../../../plugin/bin/lib/arc-watch-ownership.mjs'

const ids = { brief: new Set(['raw']), name: new Set(['named']), nameComplete: true }
describe('arc transcript ownership', () => {
  it.each([
    ['brief', 'raw', 'local'], ['brief', 'elsewhere', 'foreign'],
    ['name', 'named', 'local'], ['name', 'elsewhere', 'foreign'],
    ['none', 'raw', 'unknown'], ['legacy', 'raw', 'local'],
    ['legacy', 'named', 'local'], ['legacy', 'elsewhere', 'foreign'],
  ])('%s / %s is %s', (agentIdSource, agentId, result) => {
    expect(transcriptLocality({ agentIdSource, agentId }, ids)).toBe(result)
  })
  it('cannot prove foreign ownership without ids or a complete current scan', () => {
    const record = { agentIdSource: 'brief', agentId: 'elsewhere' }
    expect(transcriptLocality(record, undefined)).toBe('unknown')
    expect(isProvenForeign(record, ids, false)).toBe(false)
    expect(isProvenForeign(record, ids, undefined)).toBe(false)
    expect(isProvenForeign(record, ids, true)).toBe(true)
  })
  it.each(['name', 'legacy'])('incomplete names keep unmatched %s records unknown, but positive matches local', (agentIdSource) => {
    const partial = { ...ids, nameComplete: false }
    expect(transcriptLocality({ agentIdSource, agentId: 'elsewhere' }, partial)).toBe('unknown')
    expect(transcriptLocality({ agentIdSource, agentId: 'named' }, partial)).toBe('local')
    expect(isProvenForeign({ agentIdSource, agentId: 'elsewhere' }, partial, true)).toBe(false)
  })
  it('brief ownership is independent of name completeness', () => {
    expect(transcriptLocality({ agentIdSource: 'brief', agentId: 'elsewhere' }, { ...ids, nameComplete: false })).toBe('foreign')
  })
})
