// report-format.test.ts — unit tests for the PURE markdown renderer of an AuditReport.
//
// formatAuditReportMarkdown(report, ctx) → deterministic markdown (the report.md body).
// Honesty contract: an empty decision trail and absent transcripts render as explicit
// "none recorded / pruned" lines, never as silence implying completeness; a token
// mismatch renders a visible caveat.

import { describe, it, expect } from 'vitest'
import { formatAuditReportMarkdown } from '../src/report-format.js'
import type { AuditReport } from '../src/report.js'
import type { AgentUsage, CompactionReport } from '../src/transcript-usage.js'
import type { ToolDenialReport } from '../src/tool-denial.js'

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

describe('formatAuditReportMarkdown — tool denials section', () => {
  const denialReport: ToolDenialReport = {
    total: 2,
    agentsAffected: 1,
    bySignature: [{ signature: 'git diff', count: 2 }],
    degraded: true,
    denials: [
      { agentId: 'a1', label: 'review:bugs', tool: 'Bash', detail: 'git diff a..b -- x.ts', kind: 'rejected', reason: null, at: null },
      { agentId: 'a1', label: 'review:bugs', tool: 'Bash', detail: 'git diff c..d', kind: 'auto-mode-classifier', reason: '[Create Unsafe Agents]', at: null },
    ],
    recoveredCount: 0,
    allRecovered: false,
  }

  it('renders a ⚠ DEGRADED banner + a per-denial table when denials are present', () => {
    const md = formatAuditReportMarkdown(report({ denials: denialReport }))
    expect(md).toMatch(/## Tool denials/)
    expect(md).toMatch(/⚠.*2 tool call\(s\) DENIED across 1 agent\(s\)/)
    expect(md).toMatch(/DEGRADED/)
    expect(md).toContain('git diff ×2') // grouped summary
    expect(md).toContain('review:bugs') // resolved label
    expect(md).toContain('[Create Unsafe Agents]') // auto-mode reason
  })

  it('escapes a pipe in a denied command so it cannot inject extra table columns', () => {
    const piped: ToolDenialReport = {
      total: 1,
      agentsAffected: 1,
      bySignature: [{ signature: 'git log', count: 1 }],
      degraded: true,
      denials: [
        { agentId: 'a1', label: 'review:bugs', tool: 'Bash', detail: 'git log | head -5', kind: 'rejected', reason: null, at: null },
      ],
      recoveredCount: 0,
      allRecovered: false,
    }
    const md = formatAuditReportMarkdown(report({ denials: piped }))
    // Select the TABLE ROW (the banner line also says "git log ×1"); "head -5" is unique to it.
    const row = md.split('\n').find((l) => l.includes('head -5')) ?? ''
    // The detail's pipe is escaped, so the row keeps exactly its 6 columns (7 delimiters —
    // Stage/Tool/Attempted/Denial/Reason/Recovered).
    expect(row).toContain('git log \\| head -5')
    expect((row.match(/(?<!\\)\|/g) ?? []).length).toBe(7)
  })

  it('renders an honest clean line when there are no denials (absent field)', () => {
    const md = formatAuditReportMarkdown(report()) // fixture has no denials field
    expect(md).toMatch(/## Tool denials/)
    expect(md).toMatch(/no tool denials detected/i)
  })

  it('renders the clean line for an explicit zero-denial report too', () => {
    const md = formatAuditReportMarkdown(
      report({ denials: { total: 0, agentsAffected: 0, bySignature: [], denials: [], degraded: false, recoveredCount: 0, allRecovered: false } }),
    )
    expect(md).toMatch(/no tool denials detected/i)
  })
})

describe('formatAuditReportMarkdown — auto-compaction (advisory) section', () => {
  const compactionReport: CompactionReport = {
    agentsCompacted: 1,
    peakTokens: 198625,
    droppedTokens: 99667,
    compacted: true,
    agents: [{ agentId: 'a1', label: 'read:big', peakTokens: 198625, droppedTokens: 99667, trigger: 'auto', boundaries: 1 }],
  }

  it('renders an ℹ advisory (softer than the ⚠ DEGRADED denial signal) + a per-agent table', () => {
    const md = formatAuditReportMarkdown(report({ compaction: compactionReport }))
    expect(md).toMatch(/## Auto-compaction/)
    expect(md).toMatch(/ℹ/)
    expect(md).toMatch(/1 agent\(s\) compacted their context/)
    expect(md).toContain('198,625') // peak
    expect(md).toContain('99,667') // dropped
    expect(md).toContain('read:big') // resolved label
    expect(md).not.toMatch(/DEGRADED/) // advisory tier — the run SUCCEEDED, never call it degraded
    expect(md).not.toMatch(/200k/) // no hardcoded window size — model-dependent, uses the measured peak
  })

  it('renders an honest clean line when no agent compacted (absent field)', () => {
    const md = formatAuditReportMarkdown(report()) // fixture has no compaction field
    expect(md).toMatch(/## Auto-compaction/)
    expect(md).toMatch(/no agent compacted/i)
  })

  it('renders the clean line for an explicit zero-compaction report too', () => {
    const md = formatAuditReportMarkdown(
      report({ compaction: { agentsCompacted: 0, peakTokens: null, droppedTokens: null, agents: [], compacted: false } }),
    )
    expect(md).toMatch(/no agent compacted/i)
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

describe('formatAuditReportMarkdown — recovery-aware denial rendering', () => {
  const recDenials: ToolDenialReport = {
    total: 2,
    agentsAffected: 1,
    bySignature: [{ signature: 'WebFetch', count: 2 }],
    degraded: true,
    denials: [
      { agentId: 'a1', label: 'verify:1:0', tool: 'WebFetch', detail: 'https://a', kind: 'hook', reason: null, at: null, recovered: { via: 'WebSearch', at: null } },
      { agentId: 'a1', label: 'verify:1:0', tool: 'WebFetch', detail: 'https://b', kind: 'hook', reason: null, at: null, recovered: { via: 'WebSearch', at: null } },
    ],
    recoveredCount: 2,
    allRecovered: true,
  }

  it('renders each denial row with its recovery signal', () => {
    const md = formatAuditReportMarkdown(report({ denials: recDenials }))
    expect(md).toContain('| Recovered |')
    expect(md).toContain('via WebSearch')
  })

  it('ALL recovered: softens the banner (recovery signal named, no bare DEGRADED-blind claim)', () => {
    const md = formatAuditReportMarkdown(report({ denials: recDenials }))
    expect(md).toContain('RECOVERY signal')
    expect(md).toContain('Verify the recovery covered the same intent')
    expect(md).not.toContain('may be DEGRADED')
  })

  it('MIXED: keeps the DEGRADED banner and counts the recovery signals', () => {
    const mixed: ToolDenialReport = {
      ...recDenials,
      denials: [recDenials.denials[0]!, { agentId: 'a1', label: 'verify:1:0', tool: 'Bash', detail: 'git diff', kind: 'rejected', reason: null, at: null }],
      recoveredCount: 1,
      allRecovered: false,
    }
    const md = formatAuditReportMarkdown(report({ denials: mixed }))
    expect(md).toContain('may be DEGRADED')
    expect(md).toContain('1 of 2 show a recovery signal')
  })
})
