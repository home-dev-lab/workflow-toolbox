import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findJournal, scannedProjectDir } from '../src/source.js'

// findJournal is impure (disk), but it takes configDir/cwd overrides — these tests
// exercise the NEW literal-journal-path branch and the scanned-dir helper
// against a throwaway fixture tree, never the real config dir.

const JOURNAL = JSON.stringify({ status: 'completed', agents: [] })

let configDir: string
let journalPath: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'wt-source-test-'))
  const wfDir = join(configDir, 'projects', '-some-project', 'sess-1', 'workflows')
  mkdirSync(wfDir, { recursive: true })
  journalPath = join(wfDir, 'wf_pathtest.json')
  writeFileSync(journalPath, JOURNAL)
})

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true })
})

describe('findJournal — literal journal path', () => {
  it('resolves an existing wf_*.json path directly, bypassing project discovery', () => {
    const r = findJournal(journalPath, { configDir: '/nonexistent-config', cwd: '/nowhere' })
    expect(r).not.toBeNull()
    expect(r!.path).toBe(journalPath)
    expect(r!.runId).toBe('wf_pathtest')
    expect(r!.sessionId).toBe('sess-1')
    expect(r!.text).toBe(JOURNAL)
  })

  it('returns null for a path that does not exist', () => {
    const r = findJournal(join(configDir, 'missing', 'wf_nope.json'), { configDir, cwd: '/nowhere' })
    expect(r).toBeNull()
  })
})

describe('scannedProjectDir', () => {
  it('derives the project dir from cwd when no project is given', () => {
    const dir = scannedProjectDir({ configDir, cwd: '/some/project' })
    expect(dir).toBe(join(configDir, 'projects', '-some-project'))
  })

  it('uses the explicit project slug when given', () => {
    const dir = scannedProjectDir({ configDir, project: '-explicit-slug' })
    expect(dir).toBe(join(configDir, 'projects', '-explicit-slug'))
  })
})
