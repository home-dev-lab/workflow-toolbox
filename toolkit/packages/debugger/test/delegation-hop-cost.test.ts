import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDelegationHopCostReport, type DelegationTranscript } from '../src/delegation-hop-cost.js'

const fixture = join(import.meta.dirname, 'fixtures/hop-cost')

function transcript(id: string, path: string): DelegationTranscript {
  return { id, records: readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) }
}

describe('delegation hop cost known fixture', () => {
  it('matches the independently hand-counted depth, width, and chatter cost', () => {
    const subagents = join(fixture, 'session/subagents')
    const transcripts = [
      transcript('main', join(fixture, 'session.jsonl')),
      ...readdirSync(subagents).map((file) => transcript(file.slice('agent-'.length, -'.jsonl'.length), join(subagents, file))),
    ]
    const report = buildDelegationHopCostReport(transcripts)
    expect(report.totals).toEqual({ hops: 3, maxDepth: 2, chatterMessages: 2, widestTurn: 2 })
    expect(report.hops).toMatchObject([
      { depth: 1, delegateId: 'alpha-id', promptTokens: { tokens: 12, source: 'estimated' }, returnedTokens: { tokens: 13, source: 'inline' }, chatterCount: 2, chatterFreshTokens: { tokens: 203, source: 'by-time + by-text' }, chatterCacheReadTokens: { tokens: 43, source: 'by-time + by-text' }, chatterCosts: [{ attribution: 'by-time' }, { attribution: 'by-text' }] },
      { depth: 1, delegateId: 'beta-id', promptTokens: { tokens: 7, source: 'estimated' }, returnedTokens: { tokens: 29, source: 'notification + read-back' }, launchStubTokens: { source: 'launch stub' }, chatterCount: 0 },
      { depth: 2, delegateId: 'gamma-id', promptTokens: { tokens: 5, source: 'estimated' }, returnedTokens: { tokens: 12, source: 'inline' }, chatterCount: 0 },
    ])
  })
})
