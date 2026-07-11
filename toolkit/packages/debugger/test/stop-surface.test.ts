import { describe, it, expect } from 'vitest'
import type { AuditReport } from '../src/report.js'
import type { CompactionReport } from '../src/transcript-usage.js'
import type { Diagnosis, DiagnosisMode } from '../src/diagnose.js'
import {
  buildFullSurface,
  buildProvisionalSurface,
  decideSurface,
  isTrouble,
  mergeStopSurfaces,
  renderHookOutput,
  type StopSurface,
} from '../src/stop-surface.js'

function report(over: Partial<AuditReport> = {}): AuditReport {
  return {
    runId: 'wf_abc',
    taskId: 'task1',
    workflowName: 'demo',
    status: 'completed',
    durationMs: 1234,
    defaultModel: 'claude-opus-4-8',
    agentCount: 2,
    totalTokens: 18815,
    totalToolCalls: 4,
    agents: [],
    reconciliation: { perAgentSum: 18815, totalTokens: 18815, reconciles: true, delta: 0, missingTokenAgents: 0 },
    decisions: [
      { stage: 's1', outcome: 'ok', decision: null, phaseTitle: null },
      { stage: 's2', outcome: 'ok', decision: null, phaseTitle: null },
    ],
    transcripts: [],
    ...over,
  }
}

function diag(mode: DiagnosisMode, over: Partial<Diagnosis> = {}): Diagnosis {
  return {
    mode,
    headline: `headline for ${mode}`,
    findings: [],
    resume: { recommended: false, sameSessionOnly: true, rationale: 'n/a' },
    stats: {
      runId: 'wf_abc',
      status: 'completed',
      workflowName: 'demo',
      agentCount: 2,
      doneAgents: 2,
      incompleteAgents: 0,
      retriedAgents: 0,
      totalTokens: 18815,
      totalToolCalls: 4,
      durationMs: 1234,
    },
    ...over,
  }
}

describe('isTrouble', () => {
  it('flags only agent-died / script-throw / schema-retries', () => {
    expect(isTrouble('agent-died')).toBe(true)
    expect(isTrouble('script-throw')).toBe(true)
    expect(isTrouble('schema-retries')).toBe(true)
    expect(isTrouble('completed-ok')).toBe(false)
    expect(isTrouble('in-progress')).toBe(false)
  })
})

describe('decideSurface', () => {
  it('a parsed, conclusive journal → full + block iff trouble', () => {
    expect(decideSurface(diag('completed-ok'), 1)).toEqual({ surface: 'full', block: false, conclusive: true })
    expect(decideSurface(diag('agent-died'), 1)).toEqual({ surface: 'full', block: true, conclusive: true })
  })

  it('in-progress / missing journal → provisional once, then none; conclusive only at MAX', () => {
    expect(decideSurface(diag('in-progress'), 1)).toEqual({ surface: 'provisional', block: false, conclusive: false })
    expect(decideSurface(null, 1)).toEqual({ surface: 'provisional', block: false, conclusive: false })
    expect(decideSurface(null, 2)).toEqual({ surface: 'none', block: false, conclusive: false })
    expect(decideSurface(null, 3)).toEqual({ surface: 'none', block: false, conclusive: true })
  })
})

describe('buildFullSurface', () => {
  it('healthy run: systemMessage notice, no block', () => {
    const s = buildFullSurface({ runId: 'wf_abc', report: report(), diagnosis: diag('completed-ok'), diskDir: null })
    expect(s.block).toBe(false)
    expect(s.systemMessage).toContain('wf_abc')
    expect(s.systemMessage).toContain('2 agents')
    expect(s.systemMessage).toContain('18,815 tok')
    expect(s.systemMessage).toContain('2 decisions')
    expect(s.systemMessage).toContain('pnpm wt:report wf_abc')
    expect(s.systemMessage).not.toContain('written to')
  })

  it('disk dir appears in the notice when written', () => {
    const s = buildFullSurface({ runId: 'wf_abc', report: report(), diagnosis: diag('completed-ok'), diskDir: '/logs/wf_abc' })
    expect(s.systemMessage).toContain('written to /logs/wf_abc')
  })

  it('trouble run: block with a compact reason carrying findings + reconciliation caveat', () => {
    const rep = report({
      status: 'failed',
      reconciliation: { perAgentSum: 100, totalTokens: 200, reconciles: false, delta: 100, missingTokenAgents: 1 },
    })
    const d = diag('agent-died', { headline: 'a subagent died', findings: [{ kind: 'dead-agent', detail: 'agent X never finished' }] })
    const s = buildFullSurface({ runId: 'wf_abc', report: rep, diagnosis: d, diskDir: null })
    expect(s.block).toBe(true)
    expect(s.reason).toContain('a subagent died')
    expect(s.reason).toContain('agent X never finished')
    expect(s.reason).toContain('pnpm wt:report wf_abc')
    expect(s.reason.toLowerCase()).toContain('unreconciled')
  })

  // A silently-degraded run reads `completed-ok` at the journal level — the denial signal is
  // an INDEPENDENT block trigger on top of isTrouble. This is the whole point of the feature.
  const degradedDenials = {
    total: 7,
    agentsAffected: 2,
    bySignature: [{ signature: 'git diff', count: 7 }],
    degraded: true,
    denials: [],
    recoveredCount: 0,
    allRecovered: false,
  }

  it('completed-ok BUT degraded (denials): blocks, with a DEGRADED reason + notice suffix', () => {
    const s = buildFullSurface({
      runId: 'wf_abc',
      report: report({ denials: degradedDenials }),
      diagnosis: diag('completed-ok'),
      diskDir: null,
    })
    expect(s.block).toBe(true)
    expect(s.systemMessage).toContain('⚠ 7 tool denial(s)/2 agent(s)')
    expect(s.reason).toMatch(/DEGRADED/)
    expect(s.reason).toContain('git diff ×7')
    expect(s.reason).toContain('pnpm wt:report wf_abc')
  })

  it('trouble AND degraded: reason carries BOTH the failure findings and the denial warning', () => {
    const d = diag('agent-died', { headline: 'a subagent died', findings: [{ kind: 'dead-agent', detail: 'agent X never finished' }] })
    const s = buildFullSurface({
      runId: 'wf_abc',
      report: report({ denials: degradedDenials }),
      diagnosis: d,
      diskDir: null,
    })
    expect(s.block).toBe(true)
    expect(s.reason).toContain('a subagent died')
    expect(s.reason).toMatch(/DEGRADED/)
    expect(s.reason).toContain('git diff ×7')
  })

  it('completed-ok with an explicit zero-denial report: no block, no denial suffix', () => {
    const s = buildFullSurface({
      runId: 'wf_abc',
      report: report({ denials: { total: 0, agentsAffected: 0, bySignature: [], denials: [], degraded: false, recoveredCount: 0, allRecovered: false } }),
      diagnosis: diag('completed-ok'),
      diskDir: null,
    })
    expect(s.block).toBe(false)
    expect(s.systemMessage).not.toContain('tool denial')
  })

  // Auto-compaction is the ADVISORY tier: it appends an ℹ suffix to the always-on notice so the
  // observer/debugger is warned an agent over-scoped, but it NEVER blocks (the run succeeded) —
  // deliberately softer than the ⚠ DEGRADED denial signal above.
  const compactionReport: CompactionReport = {
    agentsCompacted: 1,
    peakTokens: 198625,
    droppedTokens: 99667,
    compacted: true,
    agents: [{ agentId: 'a1', label: 'read:big', peakTokens: 198625, droppedTokens: 99667, trigger: 'auto', boundaries: 1 }],
  }

  it('completed-ok BUT auto-compacted: advisory ℹ notice suffix, NO block', () => {
    const s = buildFullSurface({
      runId: 'wf_abc',
      report: report({ compaction: compactionReport }),
      diagnosis: diag('completed-ok'),
      diskDir: null,
    })
    expect(s.block).toBe(false) // advisory tier — never blocks
    expect(s.systemMessage).toContain('ℹ 1 agent(s) compacted context')
    expect(s.systemMessage).toContain('198,625 tok')
    expect(s.reason).toBe('')
  })

  it('auto-compaction does not upgrade a clean run to a block, and stacks with a denial suffix', () => {
    const s = buildFullSurface({
      runId: 'wf_abc',
      report: report({ compaction: compactionReport, denials: degradedDenials }),
      diagnosis: diag('completed-ok'),
      diskDir: null,
    })
    // denials still drive the block; compaction only adds its advisory suffix alongside.
    expect(s.block).toBe(true)
    expect(s.systemMessage).toContain('⚠ 7 tool denial(s)/2 agent(s)')
    expect(s.systemMessage).toContain('ℹ 1 agent(s) compacted context')
  })

  it('no compaction field → no compaction suffix', () => {
    const s = buildFullSurface({ runId: 'wf_abc', report: report(), diagnosis: diag('completed-ok'), diskDir: null })
    expect(s.systemMessage).not.toContain('compacted context')
  })
})

describe('buildProvisionalSurface', () => {
  it('notice references the task and never blocks', () => {
    const s = buildProvisionalSurface({ id: 'tk1', name: 'demo' })
    expect(s.block).toBe(false)
    expect(s.reason).toBe('')
    expect(s.systemMessage).toContain('tk1')
    expect(s.systemMessage.toLowerCase()).toContain('wt:report')
  })
})

describe('mergeStopSurfaces + renderHookOutput', () => {
  const ok: StopSurface = { systemMessage: 'note A', block: false, reason: '' }
  const bad: StopSurface = { systemMessage: 'note B', block: true, reason: 'REASON B' }

  it('joins systemMessages and blocks if any surface blocks', () => {
    const out = mergeStopSurfaces([ok, bad])
    expect(out.systemMessage).toBe('note A\nnote B')
    expect(out.decision).toBe('block')
    expect(out.reason).toBe('REASON B')
  })

  it('no blocking surface → systemMessage only, no decision', () => {
    const out = mergeStopSurfaces([ok])
    expect(out.systemMessage).toBe('note A')
    expect(out.decision).toBeUndefined()
    expect(out.reason).toBeUndefined()
  })

  it('empty input renders the inert {} object', () => {
    expect(renderHookOutput(mergeStopSurfaces([]))).toBe('{}')
    expect(renderHookOutput({ systemMessage: 'x' })).toBe('{"systemMessage":"x"}')
  })
})

describe('buildFullSurface — recovery-aware denial wording (annotate, never suppress)', () => {
  const recovered = (via: string) => ({ via, at: null })
  const den = (tool: string, rec: { via: string; at: null } | undefined) => ({
    agentId: 'a1',
    tool,
    detail: 'x',
    kind: 'hook' as const,
    reason: null,
    ...(rec !== undefined ? { recovered: rec } : {}),
  })

  it('ALL denials recovered: still blocks and lists, but wording names the recovery instead of "blind"', () => {
    const denials = {
      total: 2,
      agentsAffected: 1,
      bySignature: [{ signature: 'WebFetch', count: 2 }],
      degraded: true,
      denials: [den('WebFetch', recovered('WebSearch')), den('WebFetch', recovered('WebSearch'))],
      recoveredCount: 2,
      allRecovered: true,
    }
    const s = buildFullSurface({ runId: 'wf_rec', report: report({ denials }), diagnosis: diag('completed-ok'), diskDir: null })
    expect(s.block).toBe(true) // never suppress — a human still verifies intent coverage
    expect(s.reason).toContain('RECOVERY signal')
    expect(s.reason).toContain('WebSearch')
    expect(s.reason).toContain('Verify the recovery covered the same intent')
    expect(s.reason).not.toMatch(/may be blind/i)
  })

  it('MIXED: keeps the blind warning and counts the recovery signals', () => {
    const denials = {
      total: 2,
      agentsAffected: 1,
      bySignature: [{ signature: 'WebFetch', count: 1 }, { signature: 'git diff', count: 1 }],
      degraded: true,
      denials: [den('WebFetch', recovered('WebSearch')), den('Bash', undefined)],
      recoveredCount: 1,
      allRecovered: false,
    }
    const s = buildFullSurface({ runId: 'wf_mix', report: report({ denials }), diagnosis: diag('completed-ok'), diskDir: null })
    expect(s.reason).toMatch(/DEGRADED/)
    expect(s.reason).toMatch(/may be blind/i)
    expect(s.reason).toContain('1 of 2 show a recovery signal')
  })
})
