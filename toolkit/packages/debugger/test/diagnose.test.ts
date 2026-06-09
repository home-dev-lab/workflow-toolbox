import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseJournal } from '../src/journal.js'
import { diagnoseRun } from '../src/diagnose.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const diagnose = (name: string) => diagnoseRun(parseJournal(readFileSync(join(FIXTURES, name), 'utf8'))!)

describe('diagnoseRun — primary mode (decision table is total + mutually exclusive)', () => {
  it('real completed run with no agents → completed-ok', () => {
    expect(diagnose('real-completed.json').mode).toBe('completed-ok')
  })

  it('real failed run (arg-validation throw, 0 agents) → script-throw', () => {
    expect(diagnose('real-script-throw.json').mode).toBe('script-throw')
  })

  it('completed run with an incomplete agent → agent-died', () => {
    expect(diagnose('synthetic-agent-died.json').mode).toBe('agent-died')
  })

  it('completed run with attempt>1 (no dead agents) → schema-retries', () => {
    expect(diagnose('synthetic-schema-retries.json').mode).toBe('schema-retries')
  })

  it('async_launched (never ran) → script-throw with a launch-failure finding', () => {
    const d = diagnose('synthetic-async-launched.json')
    expect(d.mode).toBe('script-throw')
    expect(d.findings.some((f) => f.kind === 'launch-failure')).toBe(true)
  })

  it('absent status key → in-progress (unknown), with a zombie hint', () => {
    const d = diagnose('synthetic-in-progress.json')
    expect(d.mode).toBe('in-progress')
    expect(d.findings.some((f) => f.kind === 'zombie-hint')).toBe(true)
  })
})

describe('diagnoseRun — precedence (dead agent dominates a script throw)', () => {
  it('a FAILED run with a dead agent surfaces agent-died as primary, throw as secondary', () => {
    const j = parseJournal(
      JSON.stringify({
        runId: 'wf_failed-with-dead',
        status: 'failed',
        error: 'Error: cannot read property of null (a dead agent left a hole)',
        workflowProgress: [
          { type: 'workflow_agent', label: 'a', state: 'done', attempt: 1 },
          { type: 'workflow_agent', label: 'b', state: 'error', attempt: 1 },
        ],
      }),
    )!
    const d = diagnoseRun(j)
    expect(d.mode).toBe('agent-died')
    expect(d.findings.some((f) => f.kind === 'dead-agent')).toBe(true)
  })
})

describe('diagnoseRun — findings collected regardless of primary mode', () => {
  it('budget wording on a failed run attaches a budget-hint finding (not a primary mode)', () => {
    const d = diagnose('synthetic-budget.json')
    expect(d.findings.some((f) => f.kind === 'budget-hint')).toBe(true)
  })

  it('a healthy completed run has no findings', () => {
    expect(diagnose('real-completed.json').findings).toEqual([])
  })

  it('a completed run with BOTH a dead and a retried agent → agent-died primary, retry still a Finding', () => {
    const j = parseJournal(
      JSON.stringify({
        runId: 'wf_both',
        status: 'completed',
        workflowProgress: [
          { type: 'workflow_agent', label: 'a', state: 'error', attempt: 1 },
          { type: 'workflow_agent', label: 'b', state: 'done', attempt: 3 },
        ],
      }),
    )!
    const d = diagnoseRun(j)
    expect(d.mode).toBe('agent-died')
    expect(d.findings.some((f) => f.kind === 'dead-agent')).toBe(true)
    expect(d.findings.some((f) => f.kind === 'schema-retry')).toBe(true)
  })
})

describe('recommendResume — honours same-session-only cache semantics', () => {
  it('agent-died → resume recommended, flagged same-session-only', () => {
    const r = diagnose('synthetic-agent-died.json').resume
    expect(r.recommended).toBe(true)
    expect(r.sameSessionOnly).toBe(true)
    expect(r.rationale).toMatch(/session/i)
  })

  it('script-throw with 0 agents (the real case) → resume NOT recommended (nothing cached)', () => {
    const r = diagnose('real-script-throw.json').resume
    expect(r.recommended).toBe(false)
    expect(r.rationale).toMatch(/nothing ran|no cached|run fresh/i)
  })

  it('script-throw WITH completed agents (budget fixture) → resume recommended, same-session-only', () => {
    const r = diagnose('synthetic-budget.json').resume
    expect(r.recommended).toBe(true)
    expect(r.sameSessionOnly).toBe(true)
  })

  it('async_launched (never ran) → resume NOT recommended', () => {
    expect(diagnose('synthetic-async-launched.json').resume.recommended).toBe(false)
  })

  it('completed-ok and schema-retries → resume NOT recommended', () => {
    expect(diagnose('real-completed.json').resume.recommended).toBe(false)
    expect(diagnose('synthetic-schema-retries.json').resume.recommended).toBe(false)
  })

  it('in-progress → resume NOT recommended (do not resume a live run)', () => {
    expect(diagnose('synthetic-in-progress.json').resume.recommended).toBe(false)
  })
})

describe('diagnoseRun — stats', () => {
  it('reports agent counts from the progress stream', () => {
    const s = diagnose('synthetic-agent-died.json').stats
    expect(s.doneAgents).toBe(1)
    expect(s.incompleteAgents).toBe(1)
    expect(s.runId).toBe('wf_synth-agentdied')
  })
})
