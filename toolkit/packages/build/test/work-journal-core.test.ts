import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/host/
import * as io from '../../../../plugin/bin/lib/host/work-journal-io.mjs'

// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import * as journal from '../../../../plugin/bin/lib/work-journal.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { parsePushCommand } from '../../../../plugin/bin/lib/git-push.mjs'
const roots: string[] = []
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(profile = 'profile') {
  const root = mkdtempSync(join(tmpdir(), 'wt-journal-core-'))
  roots.push(root)
  const project = join(root, 'project')
  mkdirSync(project)
  const env = { HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'state'), CLAUDE_CONFIG_DIR: join(root, profile), CLAUDE_PROJECT_DIR: project,
    WT_WORK_JOURNAL_DIR: join(root, 'live'), WT_WORK_JOURNAL_ARCHIVE_DIR: join(root, 'archive'), WT_WORK_JOURNAL_NOW: '2026-06-02T12:00:00Z' }
  return { root, project, env, ctx: journal.resolveJournal({}, env) }
}
function act(text = 'Committed the change', extra = {}) { return { kind: 'commit', subject: 'feature', text, link: 'repo@abc', src: 'call', rec: 'git', actor: 'main', ...extra } }
function day(ctx: { store: string }, date = '2026-06-02') { return join(ctx.store, 'days', `${date}.ndjson`) }
function lines(ctx: { store: string }, date = '2026-06-02') { return readFileSync(day(ctx, date), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) }

function registerPathTests() {
  it('does not interpret a push argument to another git subcommand as a push act', () => {
    const f = fixture()
    expect(parsePushCommand('git log push', f.project, () => null)).toEqual([])
    expect(parsePushCommand("git -C 'space\\folder' push origin feature", f.project, () => null)[0].repo).toBe(join(f.project, 'space\\folder'))
  })
  it('separates configuration profiles, including their genesis and reader', () => {
    const f = fixture()
    const other = journal.resolveJournal({}, { ...f.env, CLAUDE_CONFIG_DIR: join(f.root, 'other') })
    expect(other.store).not.toBe(f.ctx.store)
    expect(journal.appendJournal(f.ctx, act('First profile')).outcome).toBe('recorded')
    expect(journal.appendJournal(other, act('Other profile')).outcome).toBe('recorded')
    expect(lines(f.ctx)[0].prev).toBe('0'.repeat(64))
    expect(lines(other)[0].prev).toBe('0'.repeat(64))
    expect(JSON.stringify(journal.verifyJournal(f.ctx).lines)).not.toContain('Other profile')
  })
  it('uses the project root rather than a drifting cwd and ignores plugin data paths', () => {
    const f = fixture()
    expect(f.ctx.store).not.toBe(f.env.WT_WORK_JOURNAL_DIR)
    expect(journal.resolveJournal({ cwd: join(f.project, 'sub') }, { ...f.env, CLAUDE_PLUGIN_DATA: join(f.root, 'plugin') }).store).toBe(f.ctx.store)
  })
  it.each(['WT_WORK_JOURNAL_DIR', 'WT_WORK_JOURNAL_ARCHIVE_DIR'])('refuses %s inside a git work tree before writing', (key) => {
    const f = fixture()
    mkdirSync(join(f.project, '.git'))
    expect(() => journal.resolveJournal({}, { ...f.env, [key]: join(f.project, 'journal') })).toThrow(/inside a repository/)
    expect(existsSync(join(f.project, 'journal'))).toBe(false)
  })
  it('hashes prev plus canonical JSON, independent of property insertion order', () => {
    const value = { v: 1, prev: 'a'.repeat(64), text: 'one' }
    const canonical = JSON.stringify({ prev: value.prev, text: value.text, v: value.v })
    expect(journal.hashLine(value)).toBe(createHash('sha256').update(`${value.prev}\n${canonical}`).digest('hex'))
    expect(journal.hashLine(value)).toBe(journal.hashLine({ text: 'one', prev: value.prev, v: 1 }))
  })
}
function registerDateTests() {
  it('links across day files and mirrors exact bytes', () => {
    const f = fixture()
    journal.appendJournal(f.ctx, act())
    const tomorrow = journal.resolveJournal({}, { ...f.env, WT_WORK_JOURNAL_NOW: '2026-06-03T12:00:00Z' })
    journal.appendJournal(tomorrow, act('Next day'))
    expect(lines(tomorrow, '2026-06-03')[0].prev).toBe(lines(f.ctx)[0].hash)
    expect(readFileSync(join(f.ctx.archive, 'days', '2026-06-02.ndjson'), 'utf8')).toBe(readFileSync(day(f.ctx), 'utf8'))
    expect(journal.verifyJournal(tomorrow).ok).toBe(true)
  })
  it('appends late acts today and never grows a closed day after a clock rollback', () => {
    const f = fixture()
    journal.appendJournal(f.ctx, act('Late', { at: '2026-05-01T12:00:00Z' }))
    expect(existsSync(day(f.ctx, '2026-05-01'))).toBe(false)
    expect(lines(f.ctx)[0].at).toBe('2026-05-01T12:00:00Z')
    const before = readFileSync(day(f.ctx), 'utf8')
    const tomorrow = journal.resolveJournal({}, { ...f.env, WT_WORK_JOURNAL_NOW: '2026-06-03T12:00:00Z' })
    journal.appendJournal(tomorrow, act())
    journal.appendJournal(f.ctx, act('Clock rolled back'))
    expect(readFileSync(day(f.ctx), 'utf8')).toBe(before)
    expect(lines(tomorrow, '2026-06-03')).toHaveLength(2)
    expect(journal.digestJournal(f.ctx)).toContain('Clock rolled back')
  })
  it('uses the append date when midnight passes after resolving the context', () => {
    const f = fixture()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 2, 23, 59, 59))
    const ctx = journal.resolveJournal({}, { ...f.env, WT_WORK_JOURNAL_NOW: '' })
    vi.setSystemTime(new Date(2026, 5, 3, 0, 0, 1))
    journal.appendJournal(ctx, act('After midnight'))
    expect(existsSync(day(ctx, '2026-06-03'))).toBe(true)
    expect(existsSync(day(ctx, '2026-06-02'))).toBe(false)
  })
}
function registerPendingTests() {
  it('queues a stable act while a live lock is held and never reclaims by age', () => {
    const f = fixture()
    mkdirSync(join(f.ctx.store, 'lock'), { recursive: true })
    writeFileSync(join(f.ctx.store, 'lock', 'owner.json'), JSON.stringify({ pid: process.pid, ts: '2000-01-01', nonce: 'held' }))
    const result = journal.appendJournal(f.ctx, act('Busy', { id: '1234567890abcdef' }), { waitMs: 0 })
    expect(result.outcome).toBe('failed:busy')
    expect(existsSync(day(f.ctx))).toBe(false)
    const pending = readdirSync(join(f.ctx.store, 'pending'))
    expect(pending).toHaveLength(1)
    expect(readFileSync(join(f.ctx.store, 'pending', pending[0]!), 'utf8')).toContain('1234567890abcdef')
    rmSync(join(f.ctx.store, 'lock'), { recursive: true })
    journal.appendJournal(f.ctx, act('After lock'))
    expect(lines(f.ctx).map((line) => line.text)).toEqual(['Busy', 'After lock'])
  })
  it('replays a crash-left pending id only once', () => {
    const f = fixture()
    const id = '1234567890abcdef'
    const value = act('Once', { id })
    journal.appendJournal(f.ctx, value)
    writeFileSync(join(f.ctx.store, 'pending', 'replay.json'), JSON.stringify(value))
    journal.appendJournal(f.ctx, act('Later'))
    expect(lines(f.ctx).filter((line) => line.id === id)).toHaveLength(1)
    expect(readdirSync(join(f.ctx.store, 'pending'))).toHaveLength(0)
  })
}
function registerCorruptionTests() {
  it.each(['edit', 'tail', 'head', 'archive-only', 'mirror'])('detects %s corruption', (damage) => {
    const f = fixture()
    journal.appendJournal(f.ctx, act())
    journal.appendJournal(f.ctx, act('Second'))
    if (damage === 'edit') writeFileSync(day(f.ctx), readFileSync(day(f.ctx), 'utf8').replace('Second', 'Forged'))
    if (damage === 'tail') writeFileSync(day(f.ctx), `${JSON.stringify(lines(f.ctx)[0])}\n`)
    if (damage === 'head') writeFileSync(join(f.ctx.store, 'head.json'), '{}')
    if (damage === 'archive-only') rmSync(day(f.ctx))
    if (damage === 'mirror') writeFileSync(join(f.ctx.archive, 'days', '2026-06-02.ndjson'), '')
    expect(journal.verifyJournal(f.ctx).ok).toBe(false)
  })
  it('quarantines a torn newest tail and rebuilds a lagging head before replay', () => {
    const f = fixture()
    journal.appendJournal(f.ctx, act())
    const firstHead = readFileSync(join(f.ctx.store, 'head.json'), 'utf8')
    journal.appendJournal(f.ctx, act('Second'))
    writeFileSync(join(f.ctx.store, 'head.json'), firstHead)
    appendFileSync(day(f.ctx), '{"torn":')
    expect(journal.appendJournal(f.ctx, act('Third')).outcome).toBe('recorded')
    expect(lines(f.ctx)).toHaveLength(3)
    expect(readdirSync(join(f.ctx.store, 'torn'))).toHaveLength(1)
    expect(journal.verifyJournal(f.ctx).ok).toBe(true)
  })
  it('blocks append when the head is ahead of the live ledger', () => {
    const f = fixture()
    journal.appendJournal(f.ctx, act())
    journal.appendJournal(f.ctx, act('Second'))
    writeFileSync(day(f.ctx), `${JSON.stringify(lines(f.ctx)[0])}\n`)
    expect(journal.appendJournal(f.ctx, act('Must wait')).outcome).toMatch(/^failed:/)
    expect(lines(f.ctx)).toHaveLength(1)
  })
}
function registerRecoveryTests() {
  it('detects mirrored tail deletion even when inventories and surviving chains agree', () => {
    const f = fixture()
    journal.appendJournal(f.ctx, act())
    journal.appendJournal(f.ctx, act('Second'))
    const surviving = `${JSON.stringify(lines(f.ctx)[0])}\n`
    writeFileSync(day(f.ctx), surviving)
    writeFileSync(join(f.ctx.archive, 'days', '2026-06-02.ndjson'), surviving)
    expect(journal.verifyJournal(f.ctx).ok).toBe(false)
  })
  it('requires mirror durability for a recorded acknowledgment', () => {
    const f = fixture()
    const append = io.append
    vi.spyOn(io, 'append').mockImplementation((file: string, data: string) => {
      if (file.startsWith(f.ctx.archive)) throw new Error('mirror unavailable')
      append(file, data)
    })
    expect(journal.appendJournal(f.ctx, act()).outcome).toBe('failed:mirror')
    expect(lines(f.ctx)).toHaveLength(1)
    expect(readdirSync(join(f.ctx.store, 'pending'))).toHaveLength(1)
  })
  it('restores a lost newest day from a verified archive and records the restoration', () => {
    const f = fixture()
    journal.appendJournal(f.ctx, act())
    rmSync(day(f.ctx))
    journal.restoreJournal(f.ctx, '2026-06-02')
    expect(journal.verifyJournal(f.ctx).ok).toBe(true)
    expect(lines(f.ctx).map((line: { kind: string }) => line.kind)).toEqual(['commit', 'restored'])
  })
}
function registerDigestTests() {
  it('bounds a worked-day digest to twelve subjects without an empty yesterday', () => {
    const f = fixture()
    for (let i = 0; i < 23; i++) journal.appendJournal(f.ctx, act(`Change ${i}`, { subject: `topic-${i}` }))
    const digest = journal.digestJournal(f.ctx)
    expect(digest).not.toContain('Work journal 2026-06-01')
    expect(digest).toContain('2026-06-02')
    expect(digest).toContain('+11 more subjects — show --date 2026-06-02')
    expect(digest.split('\n').filter((line: string) => line.includes(' acts ('))).toHaveLength(12)
  })
  it('details the last worked day under its own date after quiet calendar days', () => {
    const f = fixture()
    journal.appendJournal(f.ctx, act())
    const later = journal.resolveJournal({}, { ...f.env, WT_WORK_JOURNAL_NOW: '2026-06-10T12:00:00Z' })
    const digest = journal.digestJournal(later)
    expect(digest).toContain('Work journal 2026-06-02\nfeature — 1 acts')
    expect(digest).not.toContain('Work journal 2026-06-09')
  })
}
describe('work journal durable chain', () => {
  registerPathTests()
  registerDateTests()
  registerPendingTests()
  registerCorruptionTests()
  registerRecoveryTests()
  registerDigestTests()
})
