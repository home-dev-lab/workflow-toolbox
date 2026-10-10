import fs from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { journalFixture } from './fixtures/work-journal.js'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/host/
import * as io from '../../../../plugin/bin/lib/host/work-journal-io.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import * as api from '../../../../plugin/bin/lib/work-journal.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { retireProgress } from '../../../../plugin/bin/lib/work-journal-commands.mjs'

const fixtures: ReturnType<typeof journalFixture>[] = []
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) f.cleanup() })
function fixture() { const f = journalFixture(); fixtures.push(f); return f }
function context(f: ReturnType<typeof fixture>) { return api.resolveJournal({}, f.env) }
const value = (extra = {}) => ({ kind: 'commit', subject: 'feature', text: 'Change', link: `repo@${'a'.repeat(40)}`, ...extra })
function retirementFixture() {
  const f = fixture(); f.board()
  const file = join(f.project, '.claude', 'progress.md')
  fs.writeFileSync(file, '## 2026-05-01\nFirst\n## 2026-05-02\nSecond\n')
  return { f, file, ctx: context(f) }
}

describe('work journal review regression locks', () => {
  it('R2-2 reads outcomes only for today and the previous calendar day', () => {
    const f = fixture(); const ctx = context(f); api.initializeJournal(ctx)
    for (const date of ['2026-05-01', '2026-06-01', '2026-06-02']) {
      fs.writeFileSync(join(ctx.store, 'outcomes', `${date}.ndjson`), `${JSON.stringify({ src: date })}\n`)
    }
    expect(api.readOutcomes(ctx).map((item: { src: string }) => item.src)).toEqual(['2026-06-01', '2026-06-02'])
  })
  it('R2-2 rebuilds an old index crash gap in full recovery without rereading it on the next append', () => {
    const f = fixture(); const ctx = context(f)
    api.appendJournal(api.resolveJournal({}, { ...f.env, WT_WORK_JOURNAL_NOW: '2026-05-01T12:00:00Z' }), value())
    api.appendJournal(api.resolveJournal({}, { ...f.env, WT_WORK_JOURNAL_NOW: '2026-06-01T12:00:00Z' }), value({ link: `repo@${'c'.repeat(40)}` }))
    api.appendJournal(ctx, value({ link: `repo@${'b'.repeat(40)}` }))
    fs.writeFileSync(join(ctx.store, 'commits.idx'), '')
    api.withJournalLock(ctx, () => api.recoverJournal(ctx))
    expect(fs.readFileSync(join(ctx.store, 'commits.idx'), 'utf8')).toContain('a'.repeat(40))
    const old = join(ctx.store, 'days', '2026-05-01.ndjson')
    const read = vi.spyOn(io, 'read')
    const bytes = vi.spyOn(io, 'readBytes')
    expect(api.appendJournal(ctx, value({ kind: 'message', link: 'next' })).outcome).toBe('recorded')
    expect(read.mock.calls.some(([file]: unknown[]) => file === old)).toBe(false)
    expect(bytes.mock.calls.some(([file]: unknown[]) => file === old)).toBe(false)
  })
  it('R2-2 ordinary appends do not reread historical day content', () => {
    const f = fixture(); const ctx = context(f)
    for (const date of ['2026-05-01', '2026-06-01', '2026-06-02']) api.appendJournal(api.resolveJournal({}, { ...f.env, WT_WORK_JOURNAL_NOW: `${date}T12:00:00Z` }), value({ kind: 'message', link: date }))
    const old = join(ctx.store, 'days', '2026-05-01.ndjson')
    const read = vi.spyOn(io, 'read')
    const bytes = vi.spyOn(io, 'readBytes')
    expect(api.appendJournal(ctx, value({ kind: 'message', link: 'new' })).outcome).toBe('recorded')
    expect(read.mock.calls.some(([file]: unknown[]) => file === old)).toBe(false)
    expect(bytes.mock.calls.some(([file]: unknown[]) => file === old)).toBe(false)
  })
  it('R2-3 clears a stale ownerless lock but refuses a fresh ownerless lock', () => {
    const f = fixture(); const lock = join(f.root, 'lock')
    fs.mkdirSync(lock)
    expect(() => io.unlockDead(lock)).toThrow(/refused/)
    fs.utimesSync(lock, new Date(0), new Date(0))
    expect(() => io.unlockDead(lock)).not.toThrow()
    expect(fs.existsSync(lock)).toBe(false)
  })
  it('R2-3 protects an old live owner and clears its stale ownerless release crash', () => {
    const f = fixture(); const lock = join(f.root, 'lock')
    io.takeLock(lock, { pid: process.pid, host: io.hostname(), nonce: 'live' })
    fs.utimesSync(lock, new Date(0), new Date(0))
    expect(() => io.unlockDead(lock)).toThrow(/refused/)
    expect(fs.existsSync(lock)).toBe(true)
    fs.unlinkSync(join(lock, 'owner.json'))
    fs.utimesSync(lock, new Date(0), new Date(0))
    expect(() => io.unlockDead(lock)).not.toThrow()
    expect(fs.existsSync(lock)).toBe(false)
  })
  it('R2-4 serializes unlockers before observing the writer lock', () => {
    const f = fixture(); const lock = join(f.root, 'lock')
    io.takeLock(lock, { pid: 2147483647, host: io.hostname(), nonce: 'dead' })
    const read = fs.readFileSync
    let nested = false
    let refused = false
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const data = Reflect.apply(read, fs, [file, ...args])
      if (file === join(lock, 'owner.json') && !nested) {
        nested = true
        try { io.unlockDead(lock) } catch { refused = true }
        if (!fs.existsSync(lock)) io.takeLock(lock, { pid: process.pid, host: io.hostname(), nonce: 'new-live' })
      }
      return data
    }) as typeof fs.readFileSync)
    try { io.unlockDead(lock) } catch { /* A contending unlock must fail closed. */ }
    expect(refused).toBe(true)
    expect(fs.existsSync(`${lock}.unlocking`)).toBe(false)
  })
  it('R2-4 refuses a live unlock mutex and reclaims a stale ownerless unlock mutex', () => {
    const f = fixture(); const lock = join(f.root, 'lock')
    fs.mkdirSync(lock); fs.utimesSync(lock, new Date(0), new Date(0))
    io.takeLock(`${lock}.unlocking`, { pid: process.pid, host: io.hostname(), nonce: 'live' })
    expect(() => io.unlockDead(lock)).toThrow(/unlock/)
    expect(fs.existsSync(lock)).toBe(true)
    fs.rmSync(`${lock}.unlocking`, { recursive: true })
    fs.mkdirSync(`${lock}.unlocking`); fs.utimesSync(`${lock}.unlocking`, new Date(0), new Date(0))
    expect(() => io.unlockDead(lock)).not.toThrow()
    expect(fs.existsSync(lock)).toBe(false)
  })
  it.each(['live', 'both'])('R2-5 rejects invalid UTF-8 replacing U+FFFD in %s day bytes', (which) => {
    const f = fixture(); const ctx = context(f)
    api.appendJournal(ctx, value({ text: 'Valid replacement \uFFFD' }))
    const file = join(ctx.store, 'days', '2026-06-02.ndjson')
    const bytes = fs.readFileSync(file)
    const index = bytes.indexOf(Buffer.from('\uFFFD'))
    const changed = Buffer.concat([bytes.subarray(0, index), Buffer.from([0xff]), bytes.subarray(index + 3)])
    fs.writeFileSync(file, changed)
    if (which === 'both') fs.writeFileSync(join(ctx.archive, 'days', '2026-06-02.ndjson'), changed)
    const verified = api.verifyJournal(ctx)
    expect(verified.ok).toBe(false)
    expect(verified.errors.join('; ')).toContain('invalid UTF-8')
  })
  it('R2-6 retirement retries append each stable history link once after an interrupted batch', () => {
    const { file, ctx } = retirementFixture()
    const original = fs.readFileSync(file)
    const append = io.append
    let historyWrites = 0
    vi.spyOn(io, 'append').mockImplementation((target: string, data: string) => {
      if (target.startsWith(join(ctx.store, 'days')) && data.includes('"kind":"history"') && ++historyWrites === 2) throw new Error('simulated crash')
      append(target, data)
    })
    expect(() => retireProgress(ctx)).toThrow(/simulated crash/)
    expect(fs.readFileSync(file)).toEqual(original)
    vi.restoreAllMocks()
    retireProgress(ctx)
    const lines = api.verifyJournal(ctx).lines
    const history = lines.filter((line: { kind: string }) => line.kind === 'history')
    expect(history).toHaveLength(2)
    expect(new Set(history.map((line: { link: string }) => line.link)).size).toBe(2)
    expect(lines.filter((line: { kind: string }) => line.kind === 'retired-progress')).toHaveLength(1)
    expect(fs.readFileSync(file, 'utf8')).toBe('')
  })
  it.each([false, true])('R2-7 preserves the moved file when an old open descriptor appends after the first hash check (alias: %s)', (alias) => {
    const { f, file: source, ctx } = retirementFixture()
    const projectAlias = join(f.root, 'project-alias')
    if (alias) fs.symlinkSync(ctx.root, projectAlias, 'junction')
    const file = alias ? join(projectAlias, '.claude', 'progress.md') : source
    const original = fs.readFileSync(file, 'utf8')
    const fd = fs.openSync(file, 'a')
    const exclusive = io.exclusiveWrite
    let appended = false
    vi.spyOn(io, 'exclusiveWrite').mockImplementation((target: string, data: string) => {
      exclusive(target, data)
      // The journal uses native realpaths; temporary paths may use an OS alias.
      if (fs.realpathSync.native(target) === fs.realpathSync.native(file)) {
        fs.writeSync(fd, 'Late descriptor append\n')
        appended = true
      }
    })
    try {
      expect(() => retireProgress(ctx)).toThrow(/preserved/)
      expect(appended).toBe(true)
      const moved = fs.readdirSync(join(ctx.root, '.claude')).find((name) => name.includes('.retiring-'))!
      expect(fs.readFileSync(join(ctx.root, '.claude', moved), 'utf8')).toBe(`${original}Late descriptor append\n`)
      expect(fs.readFileSync(file, 'utf8')).toBe('')
    } finally { fs.closeSync(fd) }
  })
  it.each(['darwin', 'win32'])('R2-13 keeps distinct on-disk profile case separate on %s', (platform) => {
    const f = fixture()
    vi.spyOn(io, 'platform').mockReturnValue(platform)
    // Model a case-sensitive volume independently of the test runner's filesystem.
    vi.spyOn(io, 'canonical').mockImplementation((file: string) => file)
    const first = api.resolveJournal({}, { ...f.env, CLAUDE_CONFIG_DIR: join(f.root, 'Profile') })
    const second = api.resolveJournal({}, { ...f.env, CLAUDE_CONFIG_DIR: join(f.root, 'profile') })
    expect(first.store).not.toBe(second.store)
    expect(api.resolveJournal({}, { ...f.env, CLAUDE_CONFIG_DIR: join(f.root, 'Profile') }).store).toBe(first.store)
  })
  it('R2-13 canonicalizes aliases with the native on-disk realpath', () => {
    const f = fixture()
    const native = vi.spyOn(fs.realpathSync, 'native')
    io.canonical(f.project)
    expect(native).toHaveBeenCalledWith(f.project)
  })
})
