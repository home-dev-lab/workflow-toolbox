import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  parseJournal,
  agentEvents,
  doneAgents,
  incompleteAgents,
  retriedAgents,
} from '../src/journal.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fx = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

describe('parseJournal', () => {
  it('parses a real completed journal', () => {
    const j = parseJournal(fx('real-completed.json'))
    expect(j).not.toBeNull()
    expect(j?.runId).toBe('wf_9d4ee73f-61b')
    expect(j?.status).toBe('completed')
  })

  it('parses a real failed (script-throw) journal with its error stack', () => {
    const j = parseJournal(fx('real-script-throw.json'))
    expect(j?.status).toBe('failed')
    expect(j?.error).toMatch(/demo-pipeline requires args/)
  })

  it('returns null on malformed JSON without throwing', () => {
    expect(parseJournal('{ not json ]')).toBeNull()
    expect(parseJournal('')).toBeNull()
  })

  it('returns null on non-object / array / missing runId', () => {
    expect(parseJournal('42')).toBeNull()
    expect(parseJournal('null')).toBeNull()
    expect(parseJournal('[1,2,3]')).toBeNull()
    expect(parseJournal('{"status":"completed"}')).toBeNull() // no runId
  })

  it('tolerates an absent status key (in-progress fixture)', () => {
    const j = parseJournal(fx('synthetic-in-progress.json'))
    expect(j).not.toBeNull()
    expect(j?.status).toBeUndefined()
  })

  it('phases[].detail survives parsing (real journals carry it on disk)', () => {
    const j = parseJournal(fx('real-script-throw.json'))
    expect(j?.phases?.[0]?.detail).toBe('collect the input items')
    expect(j?.phases?.[1]?.detail).toBe('process each gathered item')
  })
})

describe('agent accessors', () => {
  it('agentEvents filters to workflow_agent events only', () => {
    const j = parseJournal(fx('synthetic-agent-died.json'))!
    const agents = agentEvents(j)
    expect(agents).toHaveLength(2)
    expect(agents.every((a) => a.type === 'workflow_agent')).toBe(true)
  })

  it('doneAgents / incompleteAgents split on state === "done"', () => {
    const j = parseJournal(fx('synthetic-agent-died.json'))!
    expect(doneAgents(j).map((a) => a.label)).toEqual(['work:0'])
    expect(incompleteAgents(j).map((a) => a.label)).toEqual(['work:1'])
  })

  it('retriedAgents flags attempt > 1', () => {
    const j = parseJournal(fx('synthetic-schema-retries.json'))!
    expect(retriedAgents(j).map((a) => a.label)).toEqual(['classify:0'])
  })

  it('REAL script-throw fixture has zero agents (guards the empty-progress reality)', () => {
    // 39/39 failed journals on disk had agentCount 0 — arg-validation throws before any agent.
    // If a schema change starts populating agents on failed runs, this assertion goes red on purpose.
    const j = parseJournal(fx('real-script-throw.json'))!
    expect(agentEvents(j)).toHaveLength(0)
    expect(doneAgents(j)).toHaveLength(0)
  })

  it('accessors tolerate an absent workflowProgress', () => {
    const j = parseJournal('{"runId":"wf_x","status":"failed"}')!
    expect(agentEvents(j)).toEqual([])
    expect(doneAgents(j)).toEqual([])
    expect(incompleteAgents(j)).toEqual([])
    expect(retriedAgents(j)).toEqual([])
  })
})
