import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseJournal } from '../src/journal.js'
import { diagnoseRun } from '../src/diagnose.js'
import { formatDiagnosis } from '../src/format.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const report = (name: string, ctx?: { journalPath?: string; sessionId?: string }) =>
  formatDiagnosis(diagnoseRun(parseJournal(readFileSync(join(FIXTURES, name), 'utf8'))!), ctx)

describe('formatDiagnosis', () => {
  it('renders the mode headline and the runId', () => {
    const out = report('synthetic-agent-died.json')
    expect(out).toMatch(/agent-died/i)
    expect(out).toContain('wf_synth-agentdied')
  })

  it('prints a copy-pasteable resumeFromRunId snippet when resume is recommended', () => {
    const out = report('synthetic-agent-died.json')
    expect(out).toContain('resumeFromRunId')
    expect(out).toContain('wf_synth-agentdied')
  })

  it('surfaces the same-session warning with the concrete sessionId when provided', () => {
    const out = report('synthetic-agent-died.json', { sessionId: 'sess-ABC' })
    expect(out).toMatch(/same session|session sess-ABC/i)
    expect(out).toContain('sess-ABC')
  })

  it('states resume is NOT recommended for a 0-agent script-throw', () => {
    const out = report('real-script-throw.json')
    expect(out).toMatch(/not recommended/i)
  })

  it('lists findings (budget hint) in the report body', () => {
    const out = report('synthetic-budget.json')
    expect(out).toMatch(/budget/i)
  })

  it('never throws on a healthy completed run', () => {
    expect(() => report('real-completed.json')).not.toThrow()
    expect(report('real-completed.json')).toMatch(/completed-ok/i)
  })

  it('appends a report pointer when the run has agents — consumer-first npx form by default', () => {
    const out = report('synthetic-agent-died.json')
    expect(out).toMatch(/per-agent cost \+ transcripts/i)
    expect(out).toContain('npx workflow-toolbox report wf_synth-agentdied')
  })

  it('an explicit reportCommand context overrides the default (maintainer form)', () => {
    const d = diagnoseRun(parseJournal(readFileSync(join(FIXTURES, 'synthetic-agent-died.json'), 'utf8'))!)
    const out = formatDiagnosis(d, { reportCommand: 'pnpm wt:report' })
    expect(out).toContain('pnpm wt:report wf_synth-agentdied')
  })

  it('omits the report pointer for a 0-agent run', () => {
    const out = report('real-completed.json')
    expect(out).not.toMatch(/workflow-toolbox report|wt:report/i)
  })
})
