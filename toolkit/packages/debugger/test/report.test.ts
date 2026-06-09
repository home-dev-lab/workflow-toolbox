// report.test.ts — unit tests for the PURE audit-report builder.
//
// buildAuditReport(journal, {presentTranscripts}) is a pure function: journal model
// in → AuditReport model out, zero IO. The transcript-existence signal is INJECTED
// (a Set of agentIds) so both the present and the pruned branch are testable without
// touching the filesystem. Honesty contract (plan F1/F3): decisions come from the
// always-present workflowProgress[] agent rows, enriched best-effort by
// result.envelope.trail — never from `logs` (verified dead path) — and degrade to an
// explicit empty list rather than implying a complete trail.

import { describe, it, expect } from 'vitest'
import { buildAuditReport } from '../src/report.js'
import type { WorkflowJournal } from '../src/journal.js'
import type { AgentUsage } from '../src/transcript-usage.js'

// A journal shaped like a real one (modelled on wf_975e3d74-552): two workflow_agent
// rows under a workflow_phase header, per-agent tokens summing to totalTokens, and an
// envelope trail carrying the filter decision.
function smokeJournal(overrides: Partial<WorkflowJournal> = {}): WorkflowJournal {
  return {
    runId: 'wf_975e3d74-552',
    taskId: 'wwugnfjzt',
    workflowName: 'dwt-smoke',
    status: 'completed',
    durationMs: 6976,
    defaultModel: 'claude-opus-4-8[1m]',
    agentCount: 2,
    totalTokens: 18815,
    totalToolCalls: 2,
    result: {
      marker: 'dwt-smoke-ok',
      envelope: {
        value: [],
        stats: {},
        warnings: [],
        trail: [
          { stage: 'generateAndFilter:generate:0', outcome: 'ok' },
          { stage: 'generateAndFilter:filter:0', outcome: 'ok', decision: 'pass' },
        ],
      },
    },
    workflowProgress: [
      { type: 'workflow_phase', index: 0, title: 'Smoke' },
      {
        type: 'workflow_agent',
        label: 'generateAndFilter:generate:0',
        phaseTitle: 'Smoke',
        agentId: 'ac83de77485e77ad1',
        model: 'claude-opus-4-8[1m]',
        state: 'done',
        attempt: 1,
        tokens: 9356,
        toolCalls: 1,
        durationMs: 3046,
      },
      {
        type: 'workflow_agent',
        label: 'generateAndFilter:filter:0',
        phaseTitle: 'Smoke',
        agentId: 'a29e57ea76ae2941e',
        model: 'claude-opus-4-8[1m]',
        state: 'done',
        attempt: 1,
        tokens: 9459,
        toolCalls: 1,
        durationMs: 3000,
      },
    ],
    ...overrides,
  }
}

describe('buildAuditReport — identity + cost rollup', () => {
  it('captures run identity incl. taskId (traceability)', () => {
    const r = buildAuditReport(smokeJournal())
    expect(r.runId).toBe('wf_975e3d74-552')
    expect(r.taskId).toBe('wwugnfjzt')
    expect(r.workflowName).toBe('dwt-smoke')
    expect(r.status).toBe('completed')
    expect(r.defaultModel).toBe('claude-opus-4-8[1m]')
    expect(r.durationMs).toBe(6976)
  })

  it('rolls up per-agent cost rows from workflowProgress (phase headers excluded)', () => {
    const r = buildAuditReport(smokeJournal())
    expect(r.agents).toHaveLength(2)
    expect(r.agents[0]).toMatchObject({
      label: 'generateAndFilter:generate:0',
      agentId: 'ac83de77485e77ad1',
      model: 'claude-opus-4-8[1m]',
      tokens: 9356,
      toolCalls: 1,
      phaseTitle: 'Smoke',
    })
    expect(r.totalTokens).toBe(18815)
    expect(r.totalToolCalls).toBe(2)
  })
})

describe('buildAuditReport — token reconciliation', () => {
  it('reconciles when Σ per-agent tokens === totalTokens', () => {
    const r = buildAuditReport(smokeJournal())
    expect(r.reconciliation.perAgentSum).toBe(18815)
    expect(r.reconciliation.totalTokens).toBe(18815)
    expect(r.reconciliation.reconciles).toBe(true)
    expect(r.reconciliation.delta).toBe(0)
    expect(r.reconciliation.missingTokenAgents).toBe(0)
  })

  it('flags a mismatch with the delta (does not silently hide it)', () => {
    const r = buildAuditReport(smokeJournal({ totalTokens: 20000 }))
    expect(r.reconciliation.reconciles).toBe(false)
    expect(r.reconciliation.delta).toBe(20000 - 18815)
  })

  it('counts agents with undefined tokens and refuses to reconcile', () => {
    const j = smokeJournal()
    // drop the second agent's tokens
    ;(j.workflowProgress![2] as Record<string, unknown>)['tokens'] = undefined
    const r = buildAuditReport(j)
    expect(r.reconciliation.missingTokenAgents).toBe(1)
    expect(r.reconciliation.perAgentSum).toBe(9356)
    expect(r.reconciliation.reconciles).toBe(false)
  })
})

describe('buildAuditReport — decision trail', () => {
  it('builds one decision per agent row, enriched by envelope.trail (stage===label)', () => {
    const r = buildAuditReport(smokeJournal())
    expect(r.decisions).toHaveLength(2)
    expect(r.decisions[0]).toMatchObject({ stage: 'generateAndFilter:generate:0', outcome: 'ok', decision: null })
    expect(r.decisions[1]).toMatchObject({ stage: 'generateAndFilter:filter:0', outcome: 'ok', decision: 'pass' })
  })

  it('degrades to an explicit empty list when there are no agents and no trail (no logs fallback)', () => {
    const r = buildAuditReport({ runId: 'wf_x', logs: [] } as unknown as WorkflowJournal)
    expect(r.decisions).toEqual([])
  })
})

describe('buildAuditReport — transcript links (best-effort, injected)', () => {
  it('marks links present when the agentId is in the injected Set', () => {
    const r = buildAuditReport(smokeJournal(), {
      presentTranscripts: new Set(['ac83de77485e77ad1']),
    })
    expect(r.transcripts).toEqual([
      { agentId: 'ac83de77485e77ad1', relativePath: 'transcripts/agent-ac83de77485e77ad1.jsonl', present: true },
      { agentId: 'a29e57ea76ae2941e', relativePath: 'transcripts/agent-a29e57ea76ae2941e.jsonl', present: false },
    ])
  })

  it('marks all absent when no Set is injected (pruned / >30-day cleanup)', () => {
    const r = buildAuditReport(smokeJournal())
    expect(r.transcripts.every((t) => !t.present)).toBe(true)
  })
})

describe('buildAuditReport — transcript token breakdown (best-effort, injected)', () => {
  const usage = (i: number, o: number, cr: number, cc: number): AgentUsage => ({
    inputTokens: i,
    outputTokens: o,
    cacheReadTokens: cr,
    cacheCreationTokens: cc,
  })

  it('attaches per-agent usage by agentId and rolls up only covered agents', () => {
    const r = buildAuditReport(smokeJournal(), {
      usageByAgent: new Map([['ac83de77485e77ad1', usage(100, 50, 10, 5)]]),
    })
    expect(r.agents[0]!.usage).toEqual(usage(100, 50, 10, 5))
    expect(r.agents[1]!.usage).toBeNull() // no transcript usage for this agent
    expect(r.tokenBreakdown).toEqual({
      totals: usage(100, 50, 10, 5),
      coveredAgents: 1,
      totalAgents: 2,
    })
  })

  it('sums usage across distinct covered agents', () => {
    const r = buildAuditReport(smokeJournal(), {
      usageByAgent: new Map([
        ['ac83de77485e77ad1', usage(100, 50, 10, 5)],
        ['a29e57ea76ae2941e', usage(1, 2, 3, 4)],
      ]),
    })
    expect(r.tokenBreakdown).toEqual({
      totals: usage(101, 52, 13, 9),
      coveredAgents: 2,
      totalAgents: 2,
    })
  })

  it('degrades to null tokenBreakdown + null per-agent usage when no map is injected', () => {
    const r = buildAuditReport(smokeJournal())
    expect(r.tokenBreakdown).toBeNull()
    expect(r.agents.every((a) => a.usage === null)).toBe(true)
  })
})

describe('buildAuditReport — determinism + tolerance', () => {
  it('is deterministic — same input → deep-equal output', () => {
    expect(buildAuditReport(smokeJournal())).toEqual(buildAuditReport(smokeJournal()))
  })

  it('never throws on a sparse journal (just a runId)', () => {
    const r = buildAuditReport({ runId: 'wf_sparse' } as WorkflowJournal)
    expect(r.runId).toBe('wf_sparse')
    expect(r.taskId).toBeNull()
    expect(r.agents).toEqual([])
    expect(r.decisions).toEqual([])
    expect(r.transcripts).toEqual([])
    expect(r.totalTokens).toBeNull()
    expect(r.reconciliation.reconciles).toBe(false)
  })
})
