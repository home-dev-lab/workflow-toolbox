import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { journalFixture } from './fixtures/work-journal.js'

// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import * as api from '../../../../plugin/bin/lib/work-journal.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import * as commands from '../../../../plugin/bin/lib/work-journal-commands.mjs'
const fixtures: ReturnType<typeof journalFixture>[] = []
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup() })
function fixture() { const f = journalFixture(); fixtures.push(f); return f }
function ctx(f: ReturnType<typeof fixture>) { return api.resolveJournal({}, f.env) }
function taskFile(f: ReturnType<typeof fixture>, text = '# Work\n\n## 2026-05-01\nCompleted the initial change\n') {
  mkdirSync(join(f.project, '.claude'), { recursive: true })
  const file = join(f.project, '.claude', 'progress.md')
  writeFileSync(file, text)
  return file
}

describe('work journal CLI and retirement', () => {
  it('can import the CLI without consuming stdin or printing a usage message', () => {
    const f = fixture()
    const url = pathToFileURL(join(import.meta.dirname, '../../../../plugin/bin/wt-work-journal.mjs')).href
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], { input: '', encoding: 'utf8', env: f.env })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })
  it('refuses every command outside a Claude Code process', () => {
    const f = fixture()
    expect(f.cli(['digest'], '', { CLAUDECODE: '' }).status).toBe(2)
  })
  it('stores full unsynced detail before the index line, lists it, and resolves by hash', () => {
    const f = fixture()
    expect(f.cli(['unsynced', 'Board unavailable'], 'Full task narrative\n').status).toBe(0)
    const lines = api.verifyJournal(ctx(f)).lines
    expect(lines).toHaveLength(1)
    expect(lines[0].kind).toBe('unsynced')
    expect(f.cli(['unsynced', '--list']).stdout).toContain('Full task narrative')
    expect(f.cli(['resolve', lines[0].hash]).status).toBe(0)
    expect(f.cli(['unsynced', '--list']).stdout).not.toContain('Full task narrative')
  })
  it('refuses an empty unsynced detail without creating a line', () => {
    const f = fixture()
    expect(f.cli(['unsynced', 'Missing detail'], '').status).toBe(1)
    expect(api.verifyJournal(ctx(f)).lines).toHaveLength(0)
  })
  it('archives before onboarding without a board and never empties in archive-only mode', () => {
    const f = fixture(); const file = taskFile(f); const original = readFileSync(file, 'utf8')
    expect(f.cli(['retire-progress', '--archive-only']).status).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(original)
    const retired = join(ctx(f).archive, 'retired')
    expect(readFileSync(join(retired, readdirSync(retired)[0]!), 'utf8')).toBe(original)
    expect(api.verifyJournal(ctx(f)).lines.map((line: { kind: string }) => line.kind)).toEqual(['history', 'retired-progress'])
  })
  it('requires a parsed board pointer, not mere file existence', () => {
    const f = fixture(); const file = taskFile(f)
    writeFileSync(join(f.project, '.claude', 'planka.json'), '{}')
    expect(f.cli(['retire-progress']).status).toBe(1)
    expect(readFileSync(file, 'utf8')).toContain('Completed')
  })
  it('empties only after verified archive and chained retirement, idempotently by sha', () => {
    const f = fixture(); const file = taskFile(f); f.board()
    expect(f.cli(['retire-progress', '--archive-only']).status).toBe(0)
    expect(f.cli(['retire-progress']).status).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe('')
    expect(api.verifyJournal(ctx(f)).lines).toHaveLength(2)
    expect(f.cli(['retire-progress']).status).toBe(0)
    expect(api.verifyJournal(ctx(f)).lines).toHaveLength(2)
  })
  it('refuses an archive copy that no longer hashes to the original', () => {
    const f = fixture(); const file = taskFile(f); f.board()
    f.cli(['retire-progress', '--archive-only'])
    const retired = join(ctx(f).archive, 'retired')
    writeFileSync(join(retired, readdirSync(retired)[0]!), 'Corrupted')
    expect(f.cli(['retire-progress']).status).toBe(1)
    expect(readFileSync(file, 'utf8')).toContain('Completed')
  })
  it('never empties when history could only go to pending', () => {
    const f = fixture(); const file = taskFile(f); f.board()
    mkdirSync(join(ctx(f).store, 'lock'), { recursive: true })
    expect(f.cli(['retire-progress']).status).toBe(1)
    expect(readFileSync(file, 'utf8')).toContain('Completed')
  })
  it('sha-checks the atomically renamed source and preserves a concurrent edit', () => {
    const f = fixture(); const file = taskFile(f); f.board()
    expect(() => commands.retireProgress(ctx(f), { beforeSwap: () => writeFileSync(file, 'Concurrent edit') })).toThrow(/changed/)
    expect(readFileSync(file, 'utf8')).toBe('Concurrent edit')
  })
  it('keeps both originals if a writer recreates the task file during the swap', () => {
    const f = fixture(); const file = taskFile(f); f.board()
    expect(() => commands.retireProgress(ctx(f), { afterSwap: () => writeFileSync(file, 'Writer recreation') })).toThrow(/both paths/)
    expect(readFileSync(file, 'utf8')).toBe('Writer recreation')
    expect(readdirSync(join(f.project, '.claude')).some((name) => name.includes('.retiring-'))).toBe(true)
  })
  it('resolves the Done list with an injected board client, outside hooks', async () => {
    const f = fixture(); f.board()
    await commands.setupBoard(ctx(f), { listIdOf: async (name: string) => name === 'Done' ? 'done-id' : null })
    expect(JSON.parse(readFileSync(join(ctx(f).store, 'board.json'), 'utf8')).doneId).toBe('done-id')
  })
  it('exports only closed days, refuses live corruption and refuses an inside-repo destination', () => {
    const f = fixture()
    expect(f.cli(['unsynced', 'Earlier'], 'detail', { WT_WORK_JOURNAL_NOW: '2026-06-01T12:00:00Z' }).status).toBe(0)
    expect(f.cli(['unsynced', 'Today'], 'detail today').status).toBe(0)
    const destination = join(f.root, 'snapshot')
    expect(f.cli(['export-closed', '--to', destination]).status).toBe(0)
    expect(readdirSync(destination)).toEqual(['2026-06-01.ndjson'])
    expect(f.cli(['export-closed', '--to', join(f.project, 'snapshot')]).status).toBe(1)
    expect(existsSync(join(f.project, 'snapshot'))).toBe(false)
    const quiet = fixture()
    expect(quiet.cli(['unsynced', 'Yesterday'], 'full detail', { WT_WORK_JOURNAL_NOW: '2026-06-01T12:00:00Z' }).status).toBe(0)
    const closedDay = join(ctx(quiet).store, 'days', '2026-06-01.ndjson')
    const before = readFileSync(closedDay, 'utf8')
    expect(quiet.cli(['export-closed', '--to', join(quiet.root, 'snapshot')]).status).toBe(0)
    expect(quiet.cli(['unsynced', 'Clock moved back'], 'later detail', { WT_WORK_JOURNAL_NOW: '2026-06-01T13:00:00Z' }).status).toBe(0)
    expect(readFileSync(closedDay, 'utf8')).toBe(before)
  })
})
