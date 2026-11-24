import { afterEach, describe, expect, it } from 'vitest'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, truncateSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error TS7016 -- shipped JavaScript outside the TS project
import { recordSkippedWake, skipJournalPath } from '../../../../plugin/bin/lib/watch-skip-journal.mjs'
// @ts-expect-error TS7016 -- shipped JavaScript outside the TS project
import { lineBoundary } from '../../../../plugin/bin/lib/host/watch-skip-journal.mjs'

const roots: string[] = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'watch-skips-'))
  roots.push(dir)
  const path = skipJournalPath({ env: { WT_WATCH_SKIP_JOURNAL_DIR: dir }, sessionId: '../a/b', watcher: 'arc' })
  return { dir, path, watcher: 'arc', reason: 'observer-transcript', line: 'STALE: exact text', nowMs: 0 }
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('skipped-wake journal', () => {
  it('appends readable exact lines and protects the base fields from extra', () => {
    const f = fixture()
    expect(f.path.startsWith(f.dir)).toBe(true)
    expect(skipJournalPath({ env: { WT_WATCH_SKIP_JOURNAL_DIR: f.dir }, sessionId: '', watcher: 'arc' })).toBe(join(f.dir, 'no-session.arc.jsonl'))
    expect(recordSkippedWake({ ...f, extra: { elapsedMs: 42, line: 'forged', at: 'forged' } })).toBe(true)
    expect(recordSkippedWake(f)).toBe(true)
    const rows = readFileSync(f.path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(rows).toEqual([
      { at: '1970-01-01T00:00:00.000Z', watcher: 'arc', reason: f.reason, line: f.line, elapsedMs: 42 },
      { at: '1970-01-01T00:00:00.000Z', watcher: 'arc', reason: f.reason, line: f.line },
    ])
  })
  it('rotates only when the pre-append file exceeds 1 MiB, replacing the previous rotation', () => {
    const f = fixture()
    writeFileSync(f.path, 'x'.repeat(1024 * 1024))
    expect(recordSkippedWake(f)).toBe(true)
    writeFileSync(`${f.path}.1`, 'previous')
    expect(recordSkippedWake(f)).toBe(true)
    expect(readFileSync(`${f.path}.1`, 'utf8')).toBe('x'.repeat(1024 * 1024) + '\n' + JSON.stringify({ at: '1970-01-01T00:00:00.000Z', watcher: 'arc', reason: f.reason, line: f.line }) + '\n')
    expect(JSON.parse(readFileSync(f.path, 'utf8')).line).toBe(f.line)
  })
  it('never throws and returns false when a parent is a file', () => {
    const f = fixture()
    writeFileSync(join(f.dir, 'blocked'), '')
    expect(recordSkippedWake({ ...f, path: join(f.dir, 'blocked', 'wake.jsonl') })).toBe(false)
    expect(recordSkippedWake({ ...f, nowMs: NaN })).toBe(false)
    expect(recordSkippedWake(null)).toBe(false)
  })
})

describe('skipped-wake journal files', () => {
  it('gives each watcher its own session journal and preserves both rotations', () => {
    const f = fixture()
    const quotaPath = skipJournalPath({ env: { WT_WATCH_SKIP_JOURNAL_DIR: f.dir }, sessionId: '../a/b', watcher: 'quota' })
    expect(f.path).toBe(join(f.dir, '---a-b.arc.jsonl'))
    expect(quotaPath).toBe(join(f.dir, '---a-b.quota.jsonl'))
    expect(quotaPath).not.toBe(f.path)
    const arcPrevious = 'a'.repeat(1024 * 1024 + 1), quotaPrevious = 'q'.repeat(1024 * 1024 + 1)
    writeFileSync(f.path, arcPrevious)
    writeFileSync(quotaPath, quotaPrevious)
    expect(recordSkippedWake(f)).toBe(true)
    expect(recordSkippedWake({ ...f, path: quotaPath, watcher: 'quota' })).toBe(true)
    expect(readFileSync(`${f.path}.1`, 'utf8')).toBe(arcPrevious)
    expect(readFileSync(`${quotaPath}.1`, 'utf8')).toBe(quotaPrevious)
    expect(JSON.parse(readFileSync(f.path, 'utf8')).watcher).toBe('arc')
    expect(JSON.parse(readFileSync(quotaPath, 'utf8')).watcher).toBe('quota')
  })
  it('keeps a good append readable after a partial last line', () => {
    const f = fixture()
    writeFileSync(f.path, '{"partial":')
    expect(recordSkippedWake(f)).toBe(true)
    const rows = readFileSync(f.path, 'utf8').split('\n').flatMap((line) => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
    expect(rows).toEqual([{ at: '1970-01-01T00:00:00.000Z', watcher: 'arc', reason: f.reason, line: f.line }])
  })
})

describe('skipped-wake journal line boundary', () => {
  // On NTFS a file extended without explicit sparse marking is allocated in full, so this fixture would write 3 GiB there.
  it.skipIf(process.platform === 'win32')('decides the line boundary from the last byte only, without reading the whole file', () => {
    const f = fixture()
    const size = 3 * 2 ** 30 // sparse; far larger than any string a whole-file UTF-8 read can return
    writeFileSync(f.path, '')
    truncateSync(f.path, size)
    expect(lineBoundary(f.path)).toBe('\n')
    const fd = openSync(f.path, 'r+')
    try { writeSync(fd, '\n', size - 1) } finally { closeSync(fd) }
    expect(lineBoundary(f.path)).toBe('')
  })
})
