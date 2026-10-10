import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { journalFixture } from './fixtures/work-journal.js'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/host/
import * as io from '../../../../plugin/bin/lib/host/work-journal-io.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import * as api from '../../../../plugin/bin/lib/work-journal.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { stopCheck } from '../../../../plugin/bin/lib/work-journal-lifecycle.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { loadRecorders } from '../../../../plugin/bin/lib/work-journal-recorders.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { captureGit, gitActs, pushActs } from '../../../../plugin/bin/lib/work-journal-git.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { retireProgress } from '../../../../plugin/bin/lib/work-journal-commands.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { postTool } from '../../../../plugin/bin/lib/work-journal-hook-core.mjs'

const fixtures: ReturnType<typeof journalFixture>[] = []
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) f.cleanup() })
function fixture() { const f = journalFixture(); fixtures.push(f); return f }
function context(f: ReturnType<typeof fixture>) { return api.resolveJournal({}, f.env) }
function call(f: ReturnType<typeof fixture>, command: string, id = 'call') { return { cwd: f.project, tool_name: 'Bash', tool_use_id: id, tool_input: { command } } }
const value = (extra = {}) => ({ kind: 'commit', subject: 'feature', text: 'Change', link: `repo@${'a'.repeat(40)}`, ...extra })
const user = () => `${JSON.stringify({ type: 'user', message: { content: 'Current turn' } })}\n`
const tool = (id: string, bytes = 0) => `${JSON.stringify({ type: 'assistant', message: { content: [...(bytes ? [{ type: 'text', text: 'x'.repeat(bytes) }] : []), { type: 'tool_use', id, name: 'Bash', input: { command: 'pnpm publish' } }] } })}\n`
// These locks test ledger semantics, not the hook's production latency budget.
function gitDeadline() { return performance.now() + 20_000 }
function padding(file: string, megabytes: number) {
  const line = `${JSON.stringify({ type: 'progress', data: 'x'.repeat(1024 * 1024) })}\n`
  for (let i = 0; i < megabytes; i++) fs.appendFileSync(file, line)
}
function retirementFixture() {
  const f = fixture(); f.board()
  const file = join(f.project, '.claude', 'progress.md')
  fs.writeFileSync(file, '## 2026-05-01\nFirst\n## 2026-05-02\nSecond\n')
  return { f, file, ctx: context(f) }
}
function remoteFixture() {
  const f = fixture(); f.init(); f.hook('SessionStart')
  const remote = join(f.root, 'remote.git')
  expect(spawnSync('git', ['init', '--bare', remote], { env: f.env }).status).toBe(0)
  f.git('remote', 'add', 'origin', remote); f.git('commit', '--allow-empty', '-m', 'base')
  f.git('push', '-u', 'origin', 'feature'); f.git('commit', '--allow-empty', '-m', 'next')
  // A URL push updates the remote without updating origin's tracking ref.
  f.git('push', remote, 'feature')
  return f
}

describe('work journal review regression locks', () => {
  it('R2-1 bounds transcript IO by the current turn and keeps chunk-spanning calls', () => {
    const f = fixture(); const ctx = context(f)
    fs.writeFileSync(f.transcript, user() + tool('old'))
    padding(f.transcript, 20)
    fs.appendFileSync(f.transcript, user())
    padding(f.transcript, 4)
    fs.appendFileSync(f.transcript, tool('current', 80 * 1024))
    const read = vi.spyOn(fs, 'readFileSync')
    const ranges = vi.spyOn(fs, 'readSync')
    const warning = stopCheck(ctx, { transcript_path: f.transcript }, loadRecorders(f.project))
    expect(warning).toContain('current/release: missing outcome')
    expect(warning).not.toContain('old/release')
    expect(read.mock.calls.some(([file]) => file === f.transcript)).toBe(false)
    expect((ranges.mock.calls as unknown[][]).reduce((sum, args) => sum + Number(args[3]), 0)).toBeLessThan(6 * 1024 * 1024)
  })
  it('R2-1 reports the 16 MiB window and still checks complete calls inside it', () => {
    const f = fixture()
    fs.writeFileSync(f.transcript, user() + tool('outside'))
    padding(f.transcript, 18)
    fs.appendFileSync(f.transcript, tool('inside'))
    const ranges = vi.spyOn(fs, 'readSync')
    const warning = stopCheck(context(f), { transcript_path: f.transcript }, loadRecorders(f.project))
    expect(warning).toContain('turn exceeded the 16 MiB transcript window')
    expect(warning).toContain('inside/release: missing outcome')
    expect(warning).not.toContain('outside/release')
    expect((ranges.mock.calls as unknown[][]).reduce((sum, args) => sum + Number(args[3]), 0)).toBeLessThanOrEqual(16 * 1024 * 1024)
  })
  it('R2-2 reads outcomes only for today and the previous calendar day', () => {
    const f = fixture(); const ctx = context(f); api.initializeJournal(ctx)
    for (const date of ['2026-05-01', '2026-06-01', '2026-06-02']) {
      fs.writeFileSync(join(ctx.store, 'outcomes', `${date}.ndjson`), `${JSON.stringify({ src: date })}\n`)
    }
    expect(api.readOutcomes(ctx).map((item: { src: string }) => item.src)).toEqual(['2026-06-01', '2026-06-02'])
  })
  it('R2-2 reads only the last two ledger days for git dedup and retains indexed older shas', () => {
    const f = fixture(); f.init()
    const ctx = context(f)
    const snapshot = captureGit(call(f, 'git commit'), gitDeadline())
    f.git('commit', '--allow-empty', '-m', 'base')
    const sha = f.git('rev-parse', 'HEAD')
    for (const [date, hash] of [['2026-05-01', sha], ['2026-06-01', 'b'.repeat(40)], ['2026-06-02', 'c'.repeat(40)]]) api.appendJournal(api.resolveJournal({}, { ...f.env, WT_WORK_JOURNAL_NOW: `${date}T12:00:00Z` }), value({ link: `repo@${hash}` }))
    const old = join(ctx.store, 'days', '2026-05-01.ndjson')
    const read = vi.spyOn(io, 'read')
    const bytes = vi.spyOn(io, 'readBytes')
    expect(gitActs(ctx, snapshot, gitDeadline())).toEqual([])
    expect(read.mock.calls.some(([file]: unknown[]) => file === old)).toBe(false)
    expect(bytes.mock.calls.some(([file]: unknown[]) => file === old)).toBe(false)
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
  it('R2-8 follows checkout reflog entries to attribute commits to the branch active at that act', () => {
    const f = fixture(); f.init(); f.git('commit', '--allow-empty', '-m', 'base'); f.git('branch', 'card/B')
    const ctx = context(f)
    const snapshot = captureGit(call(f, 'git switch card/B && git commit --allow-empty -m change'), gitDeadline())
    f.git('switch', 'card/B'); f.git('commit', '--allow-empty', '-m', 'change'); f.git('switch', 'feature'); f.git('commit', '--allow-empty', '-m', 'another')
    expect(gitActs(ctx, snapshot, gitDeadline()).map((act: { subject: string }) => act.subject)).toEqual(['B', 'feature'])
  })
  it('R2-9 overlapping hooks deduplicate the same merge reflog act by sha', () => {
    const f = fixture(); f.init(); f.hook('SessionStart')
    f.git('commit', '--allow-empty', '-m', 'base'); f.git('checkout', '-b', 'topic'); f.git('commit', '--allow-empty', '-m', 'topic'); f.git('checkout', 'feature')
    f.hook('PreToolUse', call(f, 'git merge topic', 'first')); f.hook('PreToolUse', call(f, 'git merge topic', 'second'))
    f.git('merge', 'topic')
    f.hook('PostToolUse', call(f, 'git merge topic', 'first')); f.hook('PostToolUse', call(f, 'git merge topic', 'second'))
    expect(api.verifyJournal(context(f)).lines.filter((line: { kind: string }) => line.kind === 'merge')).toHaveLength(1)
  })
  it.each(['--dry-run', '-n'])('R2-10 never records a %s push whose tracking ref is moved by fetch', (flag) => {
    const f = remoteFixture()
    const command = `git push ${flag} origin feature; git fetch origin`
    const snapshot = captureGit(call(f, command), gitDeadline())
    f.hook('PreToolUse', call(f, command)); f.git('push', flag, 'origin', 'feature'); f.git('fetch', 'origin'); f.hook('PostToolUse', call(f, command))
    expect(pushActs(context(f), snapshot, gitDeadline()).map((act: { outcome: string }) => act.outcome)).toEqual(['unknown'])
    expect(api.verifyJournal(context(f)).lines.filter((line: { kind: string }) => line.kind === 'push')).toHaveLength(0)
    expect(api.readOutcomes(context(f)).at(-1).outcome).toBe('unknown')
  })
  it.each(['fetch origin', 'pull --ff-only origin feature', 'remote update'])('R2-10 treats push plus %s as unknown despite matching tracking movement', (other) => {
    const f = remoteFixture(); const command = `git push origin feature; git ${other}`
    const snapshot = captureGit(call(f, command), gitDeadline())
    f.hook('PreToolUse', call(f, command)); f.git('push', 'origin', 'feature'); f.hook('PostToolUse', call(f, command))
    expect(pushActs(context(f), snapshot, gitDeadline()).map((act: { outcome: string }) => act.outcome)).toEqual(['unknown'])
    expect(api.verifyJournal(context(f)).lines.filter((line: { kind: string }) => line.kind === 'push')).toHaveLength(0)
    expect(api.readOutcomes(context(f)).at(-1).outcome).toBe('unknown')
  })
  it('R2-11 concurrent duplicate detections converge on the winner\'s ids and one line', () => {
    const f = fixture(); const ctx = context(f); api.initializeJournal(ctx)
    const recorder = { id: 'send', kind: 'tool', tag: 'message', actors: ['unknown'], subject: 'chat', sentence: 'Sent message', link: 'https://example.test/message' }
    const input = { session_id: 'session', tool_use_id: 'send', tool_name: 'mcp__chat__send' }
    const nonce = io.nonce
    let entered = false
    vi.spyOn(io, 'nonce').mockImplementation(() => {
      if (!entered) { entered = true; postTool(ctx, input, [recorder]) }
      return nonce()
    })
    postTool(ctx, input, [recorder])
    const lines = api.verifyJournal(ctx).lines
    expect(lines).toHaveLength(1)
    const detectionDir = join(ctx.store, 'detections')
    const detection = JSON.parse(fs.readFileSync(join(detectionDir, fs.readdirSync(detectionDir)[0]!), 'utf8'))
    expect(detection.map((act: { id: string }) => act.id)).toEqual(lines.map((line: { id: string }) => line.id))
  })
  it.each(['(git commit --allow-empty -m subshell)', "bash -c 'git commit --allow-empty -m subshell'"])('R2-12 records a project-root commit hidden in %s', (command) => {
    const f = fixture(); f.init(); f.hook('SessionStart')
    f.hook('PreToolUse', call(f, command)); f.git('commit', '--allow-empty', '-m', 'subshell'); f.hook('PostToolUse', call(f, command))
    expect(api.verifyJournal(context(f)).lines.map((line: { kind: string }) => line.kind)).toEqual(['commit'])
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
