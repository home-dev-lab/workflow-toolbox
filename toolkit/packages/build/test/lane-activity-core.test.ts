import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { computeStallVerdict, extractLatestLogActivity, normalizeSessionRow, pickLatestSessionRow } from '../../../../plugin/bin/lib/lane-activity-core.mjs'

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/lane-activity', import.meta.url))

// Builds a fresh tmp-file SQLite DB from the real-store fixture (schema.sql + real rows) and
// returns { db, cleanup }. A tmp FILE, not `:memory:`, because the behavior under test is
// opening the store read-only — `readOnly:true` needs an actual path to reopen.
function loadRealFixtureDb() {
  const dir = mkdtempSync(join(tmpdir(), 'lane-activity-fixture-'))
  const dbPath = join(dir, 'opencode.db')
  const setup = new DatabaseSync(dbPath)
  setup.exec(readFileSync(join(FIXTURES_DIR, 'schema.sql'), 'utf8'))
  setup.exec(readFileSync(join(FIXTURES_DIR, 'real-session-rows.sql'), 'utf8'))
  setup.close()
  const db = new DatabaseSync(`file:${dbPath}?mode=ro`, { readOnly: true })
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('normalizeSessionRow — a real captured session row', () => {
  it('parses model + token totals from the REAL fixture row (captured from a live opencode store, see fixtures/lane-activity/README.md)', () => {
    const { db, cleanup } = loadRealFixtureDb()
    try {
      const row = db.prepare('select * from session limit 1').get()
      const normalized = normalizeSessionRow(row)
      expect(normalized).not.toBeNull()
      expect(normalized?.model).toEqual({ id: 'gpt-5.4', providerID: 'openai', variant: 'default' })
      expect(normalized?.tokensInput).toBe(4016)
      expect(normalized?.tokensOutput).toBe(12)
      expect(normalized?.tokensReasoning).toBe(11)
      expect(normalized?.tokensCacheRead).toBe(3584)
      expect(normalized?.tokensTotal).toBe(4016 + 12 + 11)
      expect(normalized?.directory).toBe('/tmp/fixture-worktree')
      expect(normalized?.lastUpdatedMs).toBe(1786130915755)
    } finally {
      cleanup()
    }
  })

  it('returns null for a missing/undefined row rather than a zeroed-out object', () => {
    expect(normalizeSessionRow(null)).toBeNull()
    expect(normalizeSessionRow(undefined)).toBeNull()
  })

  it('returns null when time_updated is unusable — never fabricates lastUpdatedMs', () => {
    expect(normalizeSessionRow({ id: 'x', model: '{}', time_updated: 'not-a-number' })).toBeNull()
  })

  it('reports model:null on malformed model JSON rather than throwing or guessing a model', () => {
    const normalized = normalizeSessionRow({ id: 'x', model: '{not json', time_updated: 100 })
    expect(normalized?.model).toBeNull()
  })

  it('defaults missing token columns to 0 (a genuinely absent column, distinct from an unreadable row)', () => {
    const normalized = normalizeSessionRow({ id: 'x', model: null, time_updated: 100 })
    expect(normalized?.tokensInput).toBe(0)
    expect(normalized?.tokensTotal).toBe(0)
  })
})

describe('pickLatestSessionRow', () => {
  it('picks the row with the greatest time_updated among EXACT directory matches', () => {
    const rows = [
      { directory: '/a', time_updated: 100 },
      { directory: '/a', time_updated: 300 },
      { directory: '/a', time_updated: 200 },
    ]
    expect(pickLatestSessionRow(rows, '/a')?.time_updated).toBe(300)
  })

  it('never matches a directory that is merely a PREFIX of the worktree path (session.directory is a recorded value, not a live cwd)', () => {
    const rows = [{ directory: '/a', time_updated: 100 }]
    expect(pickLatestSessionRow(rows, '/a/sub')).toBeNull()
  })

  it('returns null for an empty row set', () => {
    expect(pickLatestSessionRow([], '/a')).toBeNull()
    expect(pickLatestSessionRow(null, '/a')).toBeNull()
  })
})

describe('extractLatestLogActivity — a real captured log tail', () => {
  const realLog = readFileSync(join(FIXTURES_DIR, 'real-log-tail.txt'), 'utf8')

  it('returns the LATEST matching line for the worktree, by timestamp — not the last line in the file', () => {
    const activity = extractLatestLogActivity(realLog, '/tmp/fixture-worktree')
    expect(activity).not.toBeNull()
    expect(activity?.description).toBe('project copy refresh done')
    expect(activity?.timestampIso).toBe('2026-08-07T19:28:33.938Z')
  })

  it('unquotes a bare (non-quoted) message= token identically to a quoted one', () => {
    const line = 'timestamp=2026-01-01T00:00:00.000Z level=INFO run=abc message=fromDirectory directory=/tmp/fixture-worktree'
    const activity = extractLatestLogActivity(line, '/tmp/fixture-worktree')
    expect(activity?.description).toBe('fromDirectory')
  })

  it('returns null (not a crash, not a stale line) when nothing in the log mentions the worktree', () => {
    expect(extractLatestLogActivity(realLog, '/tmp/some-other-worktree-never-mentioned')).toBeNull()
  })

  it('returns null on empty/absent log text', () => {
    expect(extractLatestLogActivity('', '/tmp/fixture-worktree')).toBeNull()
    expect(extractLatestLogActivity(null, '/tmp/fixture-worktree')).toBeNull()
  })

  it('ignores a line that mentions the worktree but has no parseable timestamp= prefix', () => {
    const line = 'garbage line mentioning /tmp/fixture-worktree with no timestamp field at all'
    expect(extractLatestLogActivity(line, '/tmp/fixture-worktree')).toBeNull()
  })
})

describe('computeStallVerdict — the invariant that both sources must agree', () => {
  const nowMs = 1_000_000
  const thresholdMs = 10 * 60 * 1000 // 10 minutes

  it('stalled: process alive AND both store and log are past the threshold', () => {
    const verdict = computeStallVerdict({
      nowMs,
      storeLastUpdatedMs: nowMs - thresholdMs - 1,
      logLastTimestampMs: nowMs - thresholdMs - 1,
      thresholdMs,
      processAlive: true,
    })
    expect(verdict.verdict).toBe('stalled')
  })

  it('active: process alive, store is stale but the LOG shows recent movement (the measured card scenario, inverted)', () => {
    const verdict = computeStallVerdict({
      nowMs,
      storeLastUpdatedMs: nowMs - thresholdMs - 1,
      logLastTimestampMs: nowMs - 100,
      thresholdMs,
      processAlive: true,
    })
    expect(verdict.verdict).toBe('active')
  })

  it('active: process alive, log is stale but the STORE shows recent movement — the exact scenario the card measured (DB said finish:stop 26 min earlier, process alive 29 min, log said otherwise)', () => {
    const verdict = computeStallVerdict({
      nowMs,
      storeLastUpdatedMs: nowMs - 100,
      logLastTimestampMs: nowMs - thresholdMs - 1,
      thresholdMs,
      processAlive: true,
    })
    expect(verdict.verdict).toBe('active')
  })

  it('unknown: only the store is readable — never guesses stalled OR active from one instrument', () => {
    const verdict = computeStallVerdict({
      nowMs,
      storeLastUpdatedMs: nowMs - thresholdMs - 1,
      logLastTimestampMs: null,
      thresholdMs,
      processAlive: true,
    })
    expect(verdict.verdict).toBe('unknown')
  })

  it('unknown: only the log is readable', () => {
    const verdict = computeStallVerdict({
      nowMs,
      storeLastUpdatedMs: null,
      logLastTimestampMs: nowMs - thresholdMs - 1,
      thresholdMs,
      processAlive: true,
    })
    expect(verdict.verdict).toBe('unknown')
  })

  it('unknown: neither source is readable', () => {
    const verdict = computeStallVerdict({
      nowMs,
      storeLastUpdatedMs: null,
      logLastTimestampMs: null,
      thresholdMs,
      processAlive: true,
    })
    expect(verdict.verdict).toBe('unknown')
  })

  it('gone: process confirmed not alive — never reported as "stalled" even if both sources are stale', () => {
    const verdict = computeStallVerdict({
      nowMs,
      storeLastUpdatedMs: nowMs - thresholdMs - 1,
      logLastTimestampMs: nowMs - thresholdMs - 1,
      thresholdMs,
      processAlive: false,
    })
    expect(verdict.verdict).toBe('gone')
  })

  it('unknown: process liveness itself could not be determined (e.g. unsupported platform)', () => {
    const verdict = computeStallVerdict({
      nowMs,
      storeLastUpdatedMs: nowMs - thresholdMs - 1,
      logLastTimestampMs: nowMs - thresholdMs - 1,
      thresholdMs,
      processAlive: 'unknown',
    })
    expect(verdict.verdict).toBe('unknown')
  })
})
