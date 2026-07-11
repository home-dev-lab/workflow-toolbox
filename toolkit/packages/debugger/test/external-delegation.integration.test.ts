// external-delegation.integration.test.ts — the on-disk seam + run-level surfacing of the
// external-delegation compliance signal, end to end over committed fixtures:
//   scanTranscripts (sidecar meta + transcript read) → buildAuditReport (label enrichment,
//   rollup) → formatAuditReportMarkdown (the `## External delegation` section) →
//   buildFullSurface (the Stop-hook block trigger).
//
// The two fixtures mirror the grounded 2026-07-10 3-arm-eval outcome:
//   - agent-delegated-sample  : opencode-verifier meta + a REAL two-line `BIN=…\n"$BIN" run`
//     invocation (the false-negative-under-`.` shape) → compliant.
//   - agent-selfanswer-sample : codex-rescue meta + ONLY git commands (the 16/17 self-answer
//     shape) → non-compliant, flags the run, blocks the Stop surface like a denial.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { scanTranscripts } from '../src/audit-folder.js'
import { parseJournal } from '../src/journal.js'
import { buildAuditReport } from '../src/report.js'
import { formatAuditReportMarkdown } from '../src/report-format.js'
import { buildFullSurface } from '../src/stop-surface.js'
import { diagnoseRun } from '../src/diagnose.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const DELEGATED = 'delegated-sample'
const SELF_ANSWER = 'selfanswer-sample'

/** A minimal completed journal whose two agent rows point at the two fixture transcripts. */
const JOURNAL_TEXT = JSON.stringify({
  runId: 'wf_deleg-int',
  taskId: 'delegInt',
  workflowName: 'deleg-int',
  status: 'completed',
  durationMs: 90000,
  defaultModel: 'claude-opus-4-8',
  agentCount: 2,
  totalTokens: 2620,
  workflowProgress: [
    { type: 'workflow_agent', state: 'done', label: 'verify:opencode', agentId: DELEGATED, tokens: 1020 },
    { type: 'workflow_agent', state: 'done', label: 'verify:codex', agentId: SELF_ANSWER, tokens: 1600 },
  ],
})

function buildFixtureReport() {
  const journal = parseJournal(JOURNAL_TEXT)
  expect(journal).not.toBeNull()
  const scan = scanTranscripts(FIXTURES, [DELEGATED, SELF_ANSWER], { withDelegation: true })
  return { journal: journal!, report: buildAuditReport(journal!, { delegationByAgent: scan.delegationByAgent }) }
}

describe('scanTranscripts — withDelegation reads the meta sidecar + scans the same transcript read', () => {
  it('yields both agents with their agentType, compliant scan for the real CLI call, zero for the self-answer', () => {
    const scan = scanTranscripts(FIXTURES, [DELEGATED, SELF_ANSWER], { withDelegation: true })
    expect(scan.delegationByAgent.size).toBe(2)

    const ok = scan.delegationByAgent.get(DELEGATED)!
    expect(ok.agentType).toBe('workflow-toolbox:opencode-verifier')
    expect(ok.scan).not.toBeNull()
    expect(ok.scan!.cliCalls).toBe(1)
    expect(ok.scan!.firstCommand).toContain('opencode')

    const bad = scan.delegationByAgent.get(SELF_ANSWER)!
    expect(bad.agentType).toBe('codex:codex-rescue')
    expect(bad.scan).not.toBeNull()
    expect(bad.scan!.cliCalls).toBe(0)
  })

  it('leaves agents WITHOUT a meta sidecar out of the delegation map (default spawns are not delegated)', () => {
    const scan = scanTranscripts(FIXTURES, ['compacted-sample'], { withDelegation: true })
    expect(scan.delegationByAgent.size).toBe(0)
  })
})

describe('buildAuditReport — delegation rollup with journal labels', () => {
  it('flags the run and enriches rows with the phase labels', () => {
    const { report } = buildFixtureReport()
    expect(report.delegation).toBeDefined()
    expect(report.delegation!.flagged).toBe(true)
    expect(report.delegation!.delegatedAgents).toBe(2)
    expect(report.delegation!.withoutCli).toHaveLength(1)
    expect(report.delegation!.withoutCli[0]!.label).toBe('verify:codex')
    expect(report.delegation!.agents.find((a) => a.agentId === DELEGATED)?.label).toBe('verify:opencode')
  })

  it('produces an explicit empty report when nothing was injected', () => {
    const journal = parseJournal(JOURNAL_TEXT)!
    const report = buildAuditReport(journal, {})
    expect(report.delegation).toEqual({
      delegatedAgents: 0,
      withoutCli: [],
      agents: [],
      unknown: [],
      flagged: false,
    })
  })
})

describe('formatAuditReportMarkdown — the External delegation section', () => {
  it('renders the warning banner + per-agent table on a flagged run', () => {
    const { report } = buildFixtureReport()
    const md = formatAuditReportMarkdown(report)
    expect(md).toContain('## External delegation')
    expect(md).toContain('1 of 2 delegated agent(s) show NO external-CLI')
    expect(md).toContain('| verify:codex | codex:codex-rescue | ⚠ NONE | 0 |')
    expect(md).toContain('| verify:opencode | workflow-toolbox:opencode-verifier | ✓ | 1 |')
  })

  it('says so when no delegation was requested', () => {
    const journal = parseJournal(JOURNAL_TEXT)!
    const md = formatAuditReportMarkdown(buildAuditReport(journal, {}))
    expect(md).toContain('_No external delegation requested')
  })
})

describe('buildFullSurface — self-answered delegation blocks like a denial', () => {
  it('blocks with a SELF-ANSWERED reason and stamps the notice', () => {
    const { journal, report } = buildFixtureReport()
    const diagnosis = diagnoseRun(journal)
    const surface = buildFullSurface({ runId: report.runId, report, diagnosis, diskDir: null })
    expect(surface.block).toBe(true)
    expect(surface.systemMessage).toContain('1/2 delegated agent(s) NO external CLI')
    expect(surface.reason).toContain('SELF-ANSWERED')
    expect(surface.reason).toContain('codex:codex-rescue')
  })

  it('does NOT block when every delegated agent invoked its CLI', () => {
    const journal = parseJournal(JOURNAL_TEXT)!
    const scan = scanTranscripts(FIXTURES, [DELEGATED], { withDelegation: true })
    const report = buildAuditReport(journal, { delegationByAgent: scan.delegationByAgent })
    expect(report.delegation!.flagged).toBe(false)
    const surface = buildFullSurface({ runId: report.runId, report, diagnosis: diagnoseRun(journal), diskDir: null })
    expect(surface.block).toBe(false)
    expect(surface.systemMessage).not.toContain('NO external CLI')
  })
})
