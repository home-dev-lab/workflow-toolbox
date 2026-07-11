import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listRuns } from '../src/source.js'

// listRuns is impure (disk) but takes a `configDir` override — exercised against a
// throwaway fixture tree, never the real config dir. Two projects, distinct
// mtimes, plus a non-journal sibling that must be filtered out.

const JOURNAL = JSON.stringify({ status: 'completed', agents: [] })
let configDir: string

function writeJournal(slug: string, session: string, file: string, mtimeSec: number): string {
  const wfDir = join(configDir, 'projects', slug, session, 'workflows')
  mkdirSync(wfDir, { recursive: true })
  const path = join(wfDir, file)
  writeFileSync(path, JOURNAL)
  utimesSync(path, mtimeSec, mtimeSec) // deterministic ordering, no sleeps
  return path
}

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'wt-source-list-'))
  writeJournal('-proj-a', 'sess-1', 'wf_a1.json', 1000)
  writeJournal('-proj-a', 'sess-1', 'wf_a2.json', 2000)
  writeJournal('-proj-b', 'sess-2', 'wf_b1.json', 3000)
  // A non-journal sibling in the same workflows/ dir must NOT appear.
  writeJournal('-proj-b', 'sess-2', 'agent-aXYZ.meta.json', 3500)
})

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true })
})

describe('listRuns', () => {
  it('lists runs across ALL projects, newest-first, when no project is given', () => {
    const runs = listRuns({ configDir })
    expect(runs.map((r) => r.runId)).toEqual(['wf_b1', 'wf_a2', 'wf_a1'])
  })

  it('filters out non-wf_ journal siblings (e.g. agent-*.meta.json)', () => {
    const runs = listRuns({ configDir })
    expect(runs.some((r) => r.runId.includes('agent-'))).toBe(false)
  })

  it('carries runId, journalPath, sessionId, mtimeMs and project on each ref', () => {
    const newest = listRuns({ configDir })[0]!
    expect(newest.runId).toBe('wf_b1')
    expect(newest.sessionId).toBe('sess-2')
    expect(newest.journalPath.endsWith('wf_b1.json')).toBe(true)
    expect(newest.mtimeMs).toBeGreaterThan(0)
    expect(newest.project).toBe('-proj-b')
  })

  it('sets project to the scoped opts.project when scanning a single project', () => {
    const runs = listRuns({ configDir, project: '-proj-a' })
    expect(runs.every((r) => r.project === '-proj-a')).toBe(true)
  })

  it('scopes to a single project when opts.project is given', () => {
    const runs = listRuns({ configDir, project: '-proj-a' })
    expect(runs.map((r) => r.runId)).toEqual(['wf_a2', 'wf_a1'])
  })

  it('returns [] for a missing configDir / project, never throws', () => {
    expect(listRuns({ configDir: '/nonexistent-config-xyz' })).toEqual([])
    expect(listRuns({ configDir, project: '-does-not-exist' })).toEqual([])
  })
})
