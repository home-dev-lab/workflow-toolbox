import { describe, it, expect } from 'vitest'
import type { AuditReport } from '../src/report.js'
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
    expect(s.systemMessage).toContain('pnpm dwt:report wf_abc')
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
    expect(s.reason).toContain('pnpm dwt:report wf_abc')
    expect(s.reason.toLowerCase()).toContain('unreconciled')
  })
})

describe('buildProvisionalSurface', () => {
  it('notice references the task and never blocks', () => {
    const s = buildProvisionalSurface({ id: 'tk1', name: 'demo' })
    expect(s.block).toBe(false)
    expect(s.reason).toBe('')
    expect(s.systemMessage).toContain('tk1')
    expect(s.systemMessage.toLowerCase()).toContain('dwt:report')
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
