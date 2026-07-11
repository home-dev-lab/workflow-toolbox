import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listRuns, readRunSummary, listRunSummaries } from '../src/source.js'

// readRunSummary/listRunSummaries parse the journal (unlike listRuns) to surface the
// human-facing header fields. Exercised against a throwaway fixture tree (configDir
// override), never the real config dir. Covers the full happy path plus every
// degradation: missing fields, malformed JSON, and a vanished file — all → null,
// never a throw.

let configDir: string

function writeJournal(slug: string, session: string, file: string, body: string, mtimeSec: number): string {
  const wfDir = join(configDir, 'projects', slug, session, 'workflows')
  mkdirSync(wfDir, { recursive: true })
  const path = join(wfDir, file)
  writeFileSync(path, body)
  utimesSync(path, mtimeSec, mtimeSec) // deterministic ordering, no sleeps
  return path
}

const FULL = JSON.stringify({
  runId: 'wf_full',
  workflowName: 'smoke-mini',
  summary: 'Minimal smoke workflow: one agent, returns a marker.',
  startTime: 1780859584232,
  status: 'completed',
})
const MISSING = JSON.stringify({ runId: 'wf_missing' }) // valid journal, no header fields
const MALFORMED = '{ not json'

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'wt-source-summary-'))
  writeJournal('-proj-a', 'sess-1', 'wf_full.json', FULL, 3000)
  writeJournal('-proj-a', 'sess-1', 'wf_missing.json', MISSING, 2000)
  writeJournal('-proj-a', 'sess-1', 'wf_malformed.json', MALFORMED, 1000)
})

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true })
})

describe('readRunSummary', () => {
  it('enriches a ref with workflowName, goal (journal.summary), startTime and status', () => {
    const ref = listRuns({ configDir }).find((r) => r.runId === 'wf_full')!
    const s = readRunSummary(ref)
    expect(s.workflowName).toBe('smoke-mini')
    expect(s.goal).toBe('Minimal smoke workflow: one agent, returns a marker.')
    expect(s.startTime).toBe(1780859584232)
    expect(s.status).toBe('completed')
    // RunRef fields pass through untouched.
    expect(s.runId).toBe('wf_full')
    expect(s.sessionId).toBe('sess-1')
    expect(s.mtimeMs).toBeGreaterThan(0)
  })

  it('degrades every header field to null for a journal missing them (never throws)', () => {
    const ref = listRuns({ configDir }).find((r) => r.runId === 'wf_missing')!
    const s = readRunSummary(ref)
    expect(s).toMatchObject({
      runId: 'wf_missing',
      workflowName: null,
      goal: null,
      startTime: null,
      status: null,
    })
  })

  it('degrades to null for a malformed (unparseable) journal, never throws', () => {
    const ref = listRuns({ configDir }).find((r) => r.runId === 'wf_malformed')!
    const s = readRunSummary(ref)
    expect(s.workflowName).toBeNull()
    expect(s.goal).toBeNull()
    expect(s.status).toBeNull()
  })

  it('degrades to null when the journal file has vanished, never throws', () => {
    const s = readRunSummary({
      runId: 'wf_gone',
      journalPath: join(configDir, 'does-not-exist.json'),
      sessionId: 'sess-x',
      mtimeMs: 1,
      project: '-proj-a',
    })
    expect(s.workflowName).toBeNull()
    expect(s.goal).toBeNull()
  })
})

describe('listRunSummaries', () => {
  it('returns enriched summaries newest-first, capped by maxRuns', () => {
    const out = listRunSummaries({ configDir }, { maxRuns: 2 })
    expect(out).toHaveLength(2)
    expect(out[0]!.runId).toBe('wf_full') // newest by mtime
    expect(out[0]!.workflowName).toBe('smoke-mini')
    expect(out[0]!.goal).toContain('Minimal smoke')
  })

  it('defaults the cap to 50 and never throws on an empty tree', () => {
    expect(listRunSummaries({ configDir: '/nonexistent-config-xyz' })).toEqual([])
  })

  it('excludes refs older than sinceMs, before enriching', () => {
    // Fixture mtimes (seconds → ms): wf_full=3000000, wf_missing=2000000, wf_malformed=1000000.
    const out = listRunSummaries({ configDir }, { sinceMs: 2_500_000 })
    expect(out.map((s) => s.runId)).toEqual(['wf_full'])
  })

  it('applies the sinceMs window even when maxRuns alone would have allowed more through', () => {
    const out = listRunSummaries({ configDir }, { sinceMs: 2_500_000, maxRuns: 50 })
    expect(out.map((s) => s.runId)).toEqual(['wf_full'])
  })

  it('with no sinceMs, behaves exactly as before (every ref within maxRuns)', () => {
    const out = listRunSummaries({ configDir }, { maxRuns: 50 })
    expect(out.map((s) => s.runId)).toEqual(['wf_full', 'wf_missing', 'wf_malformed'])
  })
})

describe('readRunSummary — journal-header discriminator fields (rich run picker, card #1811913410825160598)', () => {
  it('surfaces durationMs/totalTokens/agentCount/argsPreview from the journal', () => {
    const configDir2 = mkdtempSync(join(tmpdir(), 'wt-source-summary-hdr-'))
    try {
      const body = JSON.stringify({
        runId: 'wf_hdr',
        workflowName: 'demo',
        durationMs: 12345,
        totalTokens: 999,
        agentCount: 4,
        args: { range: 'HEAD~3..HEAD', mode: 'full' },
      })
      const wfDir = join(configDir2, 'projects', '-proj-hdr', 'sess-1', 'workflows')
      mkdirSync(wfDir, { recursive: true })
      writeFileSync(join(wfDir, 'wf_hdr.json'), body)
      const ref = listRuns({ configDir: configDir2 }).find((r) => r.runId === 'wf_hdr')!
      const s = readRunSummary(ref)
      expect(s.durationMs).toBe(12345)
      expect(s.totalTokens).toBe(999)
      expect(s.agentCount).toBe(4)
      expect(s.argsPreview).toBe(JSON.stringify({ range: 'HEAD~3..HEAD', mode: 'full' }))
      expect(s.project).toBe('-proj-hdr')
    } finally {
      rmSync(configDir2, { recursive: true, force: true })
    }
  })

  it('truncates argsPreview to 160 chars', () => {
    const configDir2 = mkdtempSync(join(tmpdir(), 'wt-source-summary-hdr2-'))
    try {
      const longArg = 'x'.repeat(300)
      const body = JSON.stringify({ runId: 'wf_long', args: { blob: longArg } })
      const wfDir = join(configDir2, 'projects', '-proj-hdr2', 'sess-1', 'workflows')
      mkdirSync(wfDir, { recursive: true })
      writeFileSync(join(wfDir, 'wf_long.json'), body)
      const ref = listRuns({ configDir: configDir2 }).find((r) => r.runId === 'wf_long')!
      const s = readRunSummary(ref)
      expect(s.argsPreview).not.toBeNull()
      expect(s.argsPreview!.length).toBe(160)
    } finally {
      rmSync(configDir2, { recursive: true, force: true })
    }
  })

  it('degrades durationMs/totalTokens/agentCount/argsPreview to null when the journal has none (never throws)', () => {
    const ref = listRuns({ configDir }).find((r) => r.runId === 'wf_full')!
    const s = readRunSummary(ref)
    expect(s.durationMs).toBeNull()
    expect(s.totalTokens).toBeNull()
    expect(s.agentCount).toBeNull()
    expect(s.argsPreview).toBeNull()
  })
})
