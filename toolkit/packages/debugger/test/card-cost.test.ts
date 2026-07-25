// card-cost.test.ts — unit tests for the PURE per-card cost rollup (buildCardCostReport).
// No IO here — see card-cost-scan.test.ts for the disk-reading layer.

import { describe, it, expect } from 'vitest'
import { buildCardCostReport, freshComputeTokens, type CardCostAgentInput } from '../src/card-cost.js'
import { emptyUsage, emptyActivity, type AgentUsage, type TranscriptActivity } from '../src/transcript-usage.js'

function usage(u: Partial<AgentUsage>): AgentUsage {
  return { ...emptyUsage(), ...u }
}

function activity(a: Partial<TranscriptActivity>): TranscriptActivity {
  return { ...emptyActivity(), ...a }
}

function agent(overrides: Partial<CardCostAgentInput> = {}): CardCostAgentInput {
  return {
    agentId: 'a1',
    name: null,
    agentType: null,
    model: null,
    description: null,
    usage: emptyUsage(),
    activity: emptyActivity(),
    ...overrides,
  }
}

describe('freshComputeTokens', () => {
  it('is input + output + cache-CREATION, excluding cache-READ', () => {
    const u = usage({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 1000, cacheCreationTokens: 5 })
    expect(freshComputeTokens(u)).toBe(35) // 10 + 20 + 5, NOT +1000
  })
})

describe('buildCardCostReport', () => {
  it('rolls up totals, fresh totals, and per-agent rows across multiple agents', () => {
    const a1 = agent({
      agentId: 'a1',
      name: 'pilot-x',
      agentType: 'pilot',
      model: 'sonnet',
      description: 'card pilot',
      usage: usage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 500, cacheCreationTokens: 10 }),
      activity: activity({ turns: 3, toolCalls: 5, firstTimestamp: '2026-07-25T10:00:00.000Z', lastTimestamp: '2026-07-25T10:05:00.000Z' }),
    })
    const a2 = agent({
      agentId: 'a2',
      name: 'exec-y',
      agentType: 'general-purpose',
      model: 'sonnet',
      description: 'sub-executor',
      usage: usage({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 100, cacheCreationTokens: 2 }),
      activity: activity({ turns: 1, toolCalls: 1, firstTimestamp: '2026-07-25T10:01:00.000Z', lastTimestamp: '2026-07-25T10:02:00.000Z' }),
    })

    const report = buildCardCostReport('CARD1', [a1, a2])

    expect(report.cardId).toBe('CARD1')
    expect(report.totalAgents).toBe(2)
    expect(report.coveredAgents).toBe(2)
    expect(report.totals).toEqual({ inputTokens: 120, outputTokens: 60, cacheReadTokens: 600, cacheCreationTokens: 12 })
    expect(report.freshTotal).toBe(120 + 60 + 12) // excludes the 600 cache-read
    expect(report.spanStart).toBe('2026-07-25T10:00:00.000Z') // a1's earlier start wins
    expect(report.spanEnd).toBe('2026-07-25T10:05:00.000Z') // a1's later end wins
    expect(report.agents).toHaveLength(2)
    expect(report.agents[0]).toMatchObject({ agentId: 'a1', name: 'pilot-x', freshTokens: 160, turns: 3, toolCalls: 5 })
  })

  it('coveredAgents counts only agents with NON-EMPTY usage — an all-zero agent is in totalAgents but not coveredAgents', () => {
    const zeroAgent = agent({ agentId: 'a-zero' }) // default emptyUsage()
    const realAgent = agent({ agentId: 'a-real', usage: usage({ inputTokens: 1 }) })
    const report = buildCardCostReport(null, [zeroAgent, realAgent])
    expect(report.totalAgents).toBe(2)
    expect(report.coveredAgents).toBe(1)
  })

  it('accepts a null cardId (informational tag only) and an empty input list', () => {
    const report = buildCardCostReport(null, [])
    expect(report).toMatchObject({
      cardId: null,
      agents: [],
      coveredAgents: 0,
      totalAgents: 0,
      totals: emptyUsage(),
      freshTotal: 0,
      spanStart: null,
      spanEnd: null,
    })
  })

  it('spanStart/spanEnd stay null when no agent carries a timestamp', () => {
    const report = buildCardCostReport('C', [agent({ agentId: 'a1' }), agent({ agentId: 'a2' })])
    expect(report.spanStart).toBeNull()
    expect(report.spanEnd).toBeNull()
  })

  it('does not mutate its inputs', () => {
    const a1 = agent({ agentId: 'a1', usage: usage({ inputTokens: 5 }) })
    const snapshot = JSON.parse(JSON.stringify(a1))
    buildCardCostReport('C', [a1])
    expect(a1).toEqual(snapshot)
  })
})
