import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDelegationHopCostReport, formatDelegationHopCostMarkdown, type DelegationTranscript } from '../src/delegation-hop-cost.js'

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

  it('characterizes malformed records and a spawn whose result never arrives', () => {
    const report = buildDelegationHopCostReport([
      {
        id: 'main',
        records: [
          null,
          { type: 'assistant', message: null },
          { type: 'assistant', message: { content: [null, { type: 'tool_use', name: 'Agent', id: 'spawn-missing', input: { name: 'ghost' } }] }, timestamp: '2026-01-01T00:00:00Z' },
          { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { recipient: 'ghost', content: 'ping' } }] }, timestamp: '2026-01-01T00:00:01Z' },
        ],
      },
    ])
    expect(report.hops[0]).toMatchObject({
      depth: 1,
      delegateId: null,
      delegateName: 'ghost',
      chatterCount: 1,
      promptTokens: { tokens: null, source: 'unknown' },
      returnedTokens: { tokens: null, source: 'unknown' },
      chatterFreshTokens: { tokens: null, source: 'unknown' },
    })
    expect(formatDelegationHopCostMarkdown(report)).toContain('unknown (spawn result has no agent id)')
  })

  it('attributes chatter by exact delivered text and by timestamp, including a no-usage message', () => {
    const main: DelegationTranscript = {
      id: 'main',
      records: [
        { type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'tool_use', name: 'Task', id: 'spawn', input: { description: 'worker', prompt: 'do work' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'spawn', content: [{ text: 'agent id: child' }] }] } },
        { type: 'assistant', timestamp: '2026-01-01T00:00:02Z', message: { content: [
          { type: 'tool_use', name: 'SendMessage', input: { to: 'child', message: 'exact' } },
          { type: 'tool_use', name: 'SendMessage', input: { to: 'worker', message: 'time-only' } },
          { type: 'tool_use', name: 'SendMessage', input: { to: 'child', message: 'too-late' } },
        ] } },
      ],
    }
    const child: DelegationTranscript = {
      id: 'child',
      records: [
        { type: 'user', timestamp: '2026-01-01T00:00:03Z', message: { content: 'exact' } },
        { type: 'assistant', timestamp: '2026-01-01T00:00:04Z', message: { usage: { input_tokens: 7, cache_read_input_tokens: 3 }, content: [] } },
      ],
    }
    const row = buildDelegationHopCostReport([main, child]).hops[0]!
    expect(row.chatterCount).toBe(3)
    expect(row.chatterCosts.map((cost) => cost.attribution)).toEqual(['by-text', 'by-time', 'by-time'])
    expect(row.chatterFreshTokens.tokens).toBe(21)
  })

  it('reports unresolved depth for a cyclic parent graph', () => {
    const spawn = (id: string, child: string): DelegationTranscript => ({
      id,
      records: [
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id: `spawn-${child}`, input: { prompt: child } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `spawn-${child}`, content: JSON.stringify({ id: child }) }] } },
      ],
    })
    const report = buildDelegationHopCostReport([spawn('a', 'b'), spawn('b', 'a')])
    expect(report.hops.every((row) => row.depth === null)).toBe(true)
    expect(report.totals.maxDepth).toBe(0)
    expect(formatDelegationHopCostMarkdown(report)).toContain('unknown (unresolved parent)')
  })
})
