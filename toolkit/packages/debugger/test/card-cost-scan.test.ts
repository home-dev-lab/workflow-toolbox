// card-cost-scan.test.ts — INTEGRATION tests for scanCardCostAgents, the impure disk-reading
// layer over a shared session's flat `subagents/` directory. Fixtures live in test/fixtures/
// as agent-cost-{a,b,c,unrelated}.{meta.json,jsonl} pairs (agent-cost-c has NO .jsonl, to
// exercise the "identity survives, usage zeroed" path for a pruned/missing transcript).

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { scanCardCostAgents, isSafeAgentId } from '../src/card-cost-scan.js'
import { emptyUsage, emptyActivity } from '../src/transcript-usage.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

describe('scanCardCostAgents — explicit-selector scan over a shared flat directory', () => {
  it('matches by NAME, reads identity + usage + activity, and EXCLUDES an unrelated agent in the same dir', () => {
    const results = scanCardCostAgents(FIXTURES, { names: ['pilot-x', 'exec-y'] })
    const byId = new Map(results.map((r) => [r.agentId, r]))

    expect(results).toHaveLength(2) // NOT the unrelated agent also present in the dir
    expect(byId.has('cost-unrelated')).toBe(false)

    const a = byId.get('cost-a')!
    expect(a).toMatchObject({ name: 'pilot-x', agentType: 'pilot', model: 'sonnet', description: 'card pilot' })
    // 2 distinct message.id (msg_a1 final @ o:50, msg_a2) -> turns=2; tool_use on each final snapshot -> 2.
    expect(a.usage).toEqual({ inputTokens: 120, outputTokens: 62, cacheReadTokens: 500, cacheCreationTokens: 10 })
    expect(a.activity.turns).toBe(2)
    expect(a.activity.toolCalls).toBe(2)
    expect(a.activity.firstTimestamp).toBe('2026-07-25T10:00:00.000Z')
    expect(a.activity.lastTimestamp).toBe('2026-07-25T10:00:05.000Z')

    const b = byId.get('cost-b')!
    expect(b).toMatchObject({ name: 'exec-y', agentType: 'general-purpose' })
    expect(b.usage).toEqual({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 100, cacheCreationTokens: 2 })
  })

  it('matches by exact agentId too, independent of name', () => {
    const results = scanCardCostAgents(FIXTURES, { agentIds: ['cost-b'] })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ agentId: 'cost-b', name: 'exec-y' })
  })

  it('a meta.json with NO matching transcript still yields a row (identity intact), with zeroed usage/activity', () => {
    const results = scanCardCostAgents(FIXTURES, { names: ['orphan-transcript'] })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ agentId: 'cost-c', name: 'orphan-transcript', agentType: 'Explore' })
    expect(results[0]!.usage).toEqual(emptyUsage())
    expect(results[0]!.activity).toEqual(emptyActivity())
  })

  it('a requested name/id that matches nothing on disk yields NO fabricated row (empty result, not an error)', () => {
    expect(scanCardCostAgents(FIXTURES, { names: ['no-such-agent'] })).toEqual([])
    expect(scanCardCostAgents(FIXTURES, { agentIds: ['no-such-id'] })).toEqual([])
  })

  it('an empty selector matches nothing — this function never sweeps the whole directory by default', () => {
    expect(scanCardCostAgents(FIXTURES, {})).toEqual([])
  })

  it('never throws on an unreadable directory — yields an empty result', () => {
    expect(scanCardCostAgents(join(FIXTURES, 'does-not-exist'), { names: ['pilot-x'] })).toEqual([])
  })
})

describe('isSafeAgentId', () => {
  it('accepts alnum/dash/underscore ids', () => {
    expect(isSafeAgentId('cost-a')).toBe(true)
    expect(isSafeAgentId('a01d9019f09550996')).toBe(true)
    expect(isSafeAgentId('a_b-C9')).toBe(true)
  })

  it('rejects a path-traversal-shaped id', () => {
    expect(isSafeAgentId('../secret')).toBe(false)
    expect(isSafeAgentId('a/b')).toBe(false)
    expect(isSafeAgentId('a.b')).toBe(false)
    expect(isSafeAgentId('')).toBe(false)
  })
})
