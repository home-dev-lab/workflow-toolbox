// report-format.test.ts — unit tests for the PURE markdown renderer of an AuditReport.
//
// formatAuditReportMarkdown(report, ctx) → deterministic markdown (the report.md body).
// Honesty contract: an empty decision trail and absent transcripts render as explicit
// "none recorded / pruned" lines, never as silence implying completeness; a token
// mismatch renders a visible caveat.

import { describe, it, expect } from 'vitest'
import { formatAuditReportMarkdown } from '../src/report-format.js'
import type { AuditReport } from '../src/report.js'
import type { AgentUsage } from '../src/transcript-usage.js'

const usage = (i: number, o: number, cr: number, cc: number): AgentUsage => ({
  inputTokens: i,
  outputTokens: o,
  cacheReadTokens: cr,
  cacheCreationTokens: cc,
})

function report(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    runId: 'wf_975e3d74-552',
    taskId: 'wwugnfjzt',
    workflowName: 'wt-smoke',
    status: 'completed',
    durationMs: 6976,
    defaultModel: 'claude-opus-4-8[1m]',
    agentCount: 2,
    totalTokens: 18815,
    totalToolCalls: 2,
    agents: [
      { label: 'generateAndFilter:generate:0', agentId: 'ac83de77485e77ad1', model: 'claude-opus-4-8[1m]', tokens: 9356, toolCalls: 1, phaseTitle: 'Smoke', state: 'done' },
      { label: 'generateAndFilter:filter:0', agentId: 'a29e57ea76ae2941e', model: 'claude-opus-4-8[1m]', tokens: 9459, toolCalls: 1, phaseTitle: 'Smoke', state: 'done' },
    ],
    reconciliation: { perAgentSum: 18815, totalTokens: 18815, reconciles: true, delta: 0, missingTokenAgents: 0 },
    decisions: [
      { stage: 'generateAndFilter:generate:0', outcome: 'ok', decision: null, phaseTitle: 'Smoke' },
      { stage: 'generateAndFilter:filter:0', outcome: 'ok', decision: 'pass', phaseTitle: 'Smoke' },
    ],
    transcripts: [
      { agentId: 'ac83de77485e77ad1', relativePath: 'transcripts/agent-ac83de77485e77ad1.jsonl', present: true },
      { agentId: 'a29e57ea76ae2941e', relativePath: 'transcripts/agent-a29e57ea76ae2941e.jsonl', present: false },
    ],
    ...overrides,
  }
}

describe('formatAuditReportMarkdown — identity + cost', () => {
  it('renders run identity incl. taskId and the thousands-formatted total', () => {
    const md = formatAuditReportMarkdown(report())
    expect(md).toMatch(/Workflow Audit Report/)
    expect(md).toContain('wf_975e3d74-552')
    expect(md).toContain('wwugnfjzt')
    expect(md).toContain('18,815')
  })

  it('renders one cost-table row per agent', () => {
    const md = formatAuditReportMarkdown(report())
    expect(md).toContain('generateAndFilter:generate:0')
    expect(md).toContain('generateAndFilter:filter:0')
    expect(md).toContain('9,356')
    expect(md).toContain('9,459')
  })
})

describe('formatAuditReportMarkdown — reconciliation caveat', () => {
  it('shows a clean reconciliation marker when Σ === total', () => {
    const md = formatAuditReportMarkdown(report())
    expect(md).toMatch(/reconcil/i)
    expect(md).not.toMatch(/⚠|mismatch/i)
  })

  it('shows a visible caveat with the delta when Σ !== total', () => {
    const md = formatAuditReportMarkdown(
      report({ totalTokens: 20000, reconciliation: { perAgentSum: 18815, totalTokens: 20000, reconciles: false, delta: 1185, missingTokenAgents: 0 } }),
    )
    expect(md).toMatch(/⚠|mismatch|does not reconcile/i)
    expect(md).toContain('1,185')
  })
})

describe('formatAuditReportMarkdown — honest empty states', () => {
  it('states "no structured decision trail" when decisions is empty', () => {
    const md = formatAuditReportMarkdown(report({ decisions: [] }))
    expect(md).toMatch(/no structured decision trail/i)
  })

  it('states transcripts pruned/none when there are no transcript links', () => {
    const md = formatAuditReportMarkdown(report({ transcripts: [] }))
    expect(md).toMatch(/no transcripts|pruned/i)
  })

  it('marks each transcript present/absent with the cleanup note for absent ones', () => {
    const md = formatAuditReportMarkdown(report())
    expect(md).toContain('transcripts/agent-ac83de77485e77ad1.jsonl')
    expect(md).toContain('transcripts/agent-a29e57ea76ae2941e.jsonl')
    expect(md).toMatch(/pruned|not captured/i)
  })
})

describe('formatAuditReportMarkdown — transcript token breakdown', () => {
  it('renders per-agent in/out/cache cells, an N-of-M rollup, and the per-turn caveat', () => {
    const md = formatAuditReportMarkdown(
      report({
        agents: [
          { label: 'gen', agentId: 'id1', model: 'm', tokens: 9356, toolCalls: 1, phaseTitle: 'Smoke', state: 'done', usage: usage(1000, 200, 5000, 300) },
          { label: 'filt', agentId: 'id2', model: 'm', tokens: 9459, toolCalls: 1, phaseTitle: 'Smoke', state: 'done', usage: null },
        ],
        tokenBreakdown: { totals: usage(1000, 200, 5000, 300), coveredAgents: 1, totalAgents: 2 },
      }),
    )
    expect(md).toMatch(/token usage/i)
    expect(md).toContain('1,000') // input cell
    expect(md).toContain('5,000') // cache-read cell
    expect(md).toMatch(/1 of 2/) // coverage rollup
    expect(md).toMatch(/per-turn|tool-use turns/i) // S1 caveat: distinct from journal Tokens
  })

  it('states an honest empty line when no transcript usage is available (null breakdown)', () => {
    const md = formatAuditReportMarkdown(report({ tokenBreakdown: null }))
    expect(md).toMatch(/no transcript token usage/i)
  })

  it('treats an absent (undefined) breakdown the same as null — honest empty line', () => {
    const md = formatAuditReportMarkdown(report()) // fixture has no tokenBreakdown
    expect(md).toMatch(/no transcript token usage/i)
  })
})

describe('formatAuditReportMarkdown — determinism', () => {
  it('is byte-stable for a fixed input', () => {
    expect(formatAuditReportMarkdown(report())).toBe(formatAuditReportMarkdown(report()))
  })

  it('includes the journal path when given in context', () => {
    const md = formatAuditReportMarkdown(report(), { journalPath: '/home/x/.claude/projects/p/s/workflows/wf_975e3d74-552.json' })
    expect(md).toContain('/workflows/wf_975e3d74-552.json')
  })
})
