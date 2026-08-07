import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const LIB = join(REPO_ROOT, 'plugin/bin/lib/guard-journal.mjs')

let journalDir: string

beforeEach(() => {
  journalDir = mkdtempSync(join(tmpdir(), 'wt-guard-journal-test-'))
})

afterEach(() => {
  rmSync(journalDir, { recursive: true, force: true })
})

/** Runs a tiny inline script that imports the library and calls recordGuardEvent once. */
function record(
  args: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
) {
  const script = `
    import { recordGuardEvent } from ${JSON.stringify(LIB)}
    recordGuardEvent(${JSON.stringify(args)})
  `
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, WT_GUARD_JOURNAL_DIR: journalDir, ...env },
  })
}

function journalFiles(): string[] {
  if (!existsSync(journalDir)) return []
  return readdirSync(journalDir).filter((f) => f.endsWith('.ndjson'))
}

function readAllEntries(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const f of journalFiles()) {
    const lines = readFileSync(join(journalDir, f), 'utf8').split('\n').filter(Boolean)
    for (const l of lines) out.push(JSON.parse(l))
  }
  return out
}

describe('guard-journal — recordGuardEvent', () => {
  it('RED->GREEN: writes one NDJSON line for a blocked decision', () => {
    const res = record({ guard: 'wt-example-guard-hook.mjs', decision: 'blocked', class: 'x', reason: 'because' })
    expect(res.status).toBe(0)
    const entries = readAllEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      guard: 'wt-example-guard-hook.mjs',
      decision: 'blocked',
      class: 'x',
      reason: 'because',
    })
    expect(typeof entries[0]!.ts).toBe('string')
  })

  it('writes one NDJSON line for a warned decision', () => {
    record({ guard: 'wt-example-guard-hook.mjs', decision: 'warned' })
    const entries = readAllEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.decision).toBe('warned')
  })

  it('never writes for a decision that is neither blocked nor warned (e.g. allow/journal)', () => {
    record({ guard: 'wt-example-guard-hook.mjs', decision: 'allowed-journaled' })
    expect(journalFiles()).toHaveLength(0)
  })

  it('never writes with no guard name', () => {
    record({ decision: 'blocked' })
    expect(journalFiles()).toHaveLength(0)
  })

  it('appends — two events land as two lines in the same file, never overwriting', () => {
    record({ guard: 'wt-example-guard-hook.mjs', decision: 'blocked' })
    record({ guard: 'wt-example-guard-hook.mjs', decision: 'warned' })
    expect(journalFiles()).toHaveLength(1)
    expect(readAllEntries()).toHaveLength(2)
  })

  it('two concurrent processes both land their line — the file is never clobbered by the second writer', () => {
    // Simulates two sessions writing at "the same time": both writes are independent
    // fs.appendFileSync calls, no shared lock — the property under test is that append
    // survives without truncation, not true atomicity of interleaved bytes.
    const a = record({ guard: 'wt-guard-a.mjs', decision: 'blocked' })
    const b = record({ guard: 'wt-guard-b.mjs', decision: 'warned' })
    expect(a.status).toBe(0)
    expect(b.status).toBe(0)
    const entries = readAllEntries()
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.guard).sort()).toEqual(['wt-guard-a.mjs', 'wt-guard-b.mjs'])
  })

  it('rotates weekly: a forced past week and a forced future week land in DIFFERENT files', () => {
    record({ guard: 'wt-example-guard-hook.mjs', decision: 'blocked' }, { WT_GUARD_JOURNAL_NOW: '2024-01-01T00:00:00Z' })
    record({ guard: 'wt-example-guard-hook.mjs', decision: 'blocked' }, { WT_GUARD_JOURNAL_NOW: '2024-07-01T00:00:00Z' })
    expect(journalFiles()).toHaveLength(2)
  })

  it('the same week produces the same file regardless of which day within it', () => {
    record({ guard: 'wt-example-guard-hook.mjs', decision: 'blocked' }, { WT_GUARD_JOURNAL_NOW: '2024-01-01T00:00:00Z' }) // Monday
    record({ guard: 'wt-example-guard-hook.mjs', decision: 'blocked' }, { WT_GUARD_JOURNAL_NOW: '2024-01-07T23:00:00Z' }) // Sunday, same ISO week
    expect(journalFiles()).toHaveLength(1)
    expect(readAllEntries()).toHaveLength(2)
  })

  it('FAIL-OPEN: a directory that cannot be created never throws — the call always returns', () => {
    // Point the journal at a path segment that is actually a FILE, so mkdirSync must fail.
    const blockerFile = join(journalDir, 'not-a-dir')
    mkdirSync(journalDir, { recursive: true })
    writeFileSync(blockerFile, 'x')
    const res = record(
      { guard: 'wt-example-guard-hook.mjs', decision: 'blocked' },
      { WT_GUARD_JOURNAL_DIR: join(blockerFile, 'journal') },
    )
    expect(res.status).toBe(0)
    expect(res.stderr).toBe('')
  })

  it('reason is truncated so one enormous command never blows up the journal file', () => {
    const huge = 'x'.repeat(5000)
    record({ guard: 'wt-example-guard-hook.mjs', decision: 'blocked', reason: huge })
    const entries = readAllEntries()
    expect((entries[0]!.reason as string).length).toBeLessThanOrEqual(400)
  })
})
