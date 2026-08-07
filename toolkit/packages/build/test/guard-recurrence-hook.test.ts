// guard-recurrence-hook.test.ts — behaviour lock for the SessionStart surface that turns a
// guard's recorded firing COUNT into something a session meets unasked (plugin/bin/
// wt-guard-recurrence-hook.mjs, card 1836526445959054631 — the card's second closure criterion:
// "crossing a threshold surfaces the count itself, not a reminder to reflect").
//
// Drives the REAL hook as a child process against an isolated WT_GUARD_JOURNAL_DIR, never the
// real journal — same technique as env-prerequisite-drift-hook.test.ts and the other SessionStart
// hook locks in this file's directory.
//
// What each silence case is FOR, since a list of assertions does not say it on its own: this
// hook runs at every session start. A false positive here (speaking when nothing crossed) gets
// it switched off, taking its real recurrence case with it — so the silence cases are not
// padding, they are what decides whether the mechanism survives its first week.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-guard-recurrence-hook.mjs')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function mkJournalDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wt-guard-recurrence-'))
  dirs.push(d)
  return d
}

/** Writes ONE week-file (the file is selected regardless of its literal name, since the
 *  default `weeks: 1` window just takes the newest — or only — .ndjson file present). */
function writeWeek(dir: string, lines: Array<Record<string, unknown>>): void {
  writeFileSync(join(dir, '2026-W32.ndjson'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

function event(guard: string, opts: { decision?: string; class?: string } = {}): Record<string, unknown> {
  return { ts: '2026-08-05T10:00:00.000Z', guard, decision: opts.decision ?? 'blocked', ...(opts.class ? { class: opts.class } : {}) }
}

function run(journalDir: string | undefined): { out: string; err: string; code: number | null } {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: REPO_ROOT }),
    encoding: 'utf8',
    env: { ...process.env, WT_GUARD_JOURNAL_DIR: journalDir ?? join(mkdtempSync(join(tmpdir(), 'wt-gr-empty-')), 'nope') },
  })
  return { out: res.stdout ?? '', err: res.stderr ?? '', code: res.status }
}

describe('guard-recurrence-hook — the SessionStart count surface', () => {
  it('is SILENT when the journal directory does not exist at all (no guard has ever fired)', () => {
    const { out, code } = run(undefined)
    expect(out).toBe('')
    expect(code).toBe(0)
  })

  it('is SILENT when a guard fired exactly twice this week (the threshold is MORE than twice)', () => {
    const dir = mkJournalDir()
    writeWeek(dir, [event('wt-main-guard-hook.mjs', { class: 'publish' }), event('wt-main-guard-hook.mjs', { class: 'publish' })])
    const { out, code } = run(dir)
    expect(out).toBe('')
    expect(code).toBe(0)
  })

  it('SPEAKS when a guard fired 3+ times for the SAME class this week, naming the guard and the count — not a reminder to reflect', () => {
    const dir = mkJournalDir()
    writeWeek(dir, [
      event('wt-main-guard-hook.mjs', { class: 'publish' }),
      event('wt-main-guard-hook.mjs', { class: 'publish' }),
      event('wt-main-guard-hook.mjs', { class: 'publish' }),
    ])
    const { out, code } = run(dir)
    expect(out).toContain('wt-main-guard-hook.mjs')
    expect(out).toContain('publish')
    expect(out).toContain('3 firings')
    // The card's own wording: the count itself, never an instruction to reflect.
    expect(out).not.toMatch(/reflect on|consider whether|think about/i)
    expect(out).toContain('not a reminder to reflect')
    expect(code).toBe(0)
  })

  it('does NOT merge two DIFFERENT classes on the same guard — 2+2 stays below threshold per class', () => {
    const dir = mkJournalDir()
    writeWeek(dir, [
      event('wt-main-guard-hook.mjs', { class: 'publish' }),
      event('wt-main-guard-hook.mjs', { class: 'publish' }),
      event('wt-main-guard-hook.mjs', { class: 'force-push' }),
      event('wt-main-guard-hook.mjs', { class: 'force-push' }),
    ])
    const { out } = run(dir)
    expect(out).toBe('')
  })

  it('groups UNCLASSED firings of one guard into a single bucket, and that bucket alone can cross the threshold', () => {
    const dir = mkJournalDir()
    writeWeek(dir, [event('wt-lane-saturation-hook.mjs'), event('wt-lane-saturation-hook.mjs'), event('wt-lane-saturation-hook.mjs')])
    const { out } = run(dir)
    expect(out).toContain('wt-lane-saturation-hook.mjs')
    expect(out).toContain('(unclassed)')
    expect(out).toContain('3 firings')
  })

  it('carries BOTH bounds on the number: event-count-not-defect-count, and only-wired-guards-appear', () => {
    const dir = mkJournalDir()
    writeWeek(dir, [
      event('wt-main-guard-hook.mjs', { class: 'publish' }),
      event('wt-main-guard-hook.mjs', { class: 'publish' }),
      event('wt-main-guard-hook.mjs', { class: 'publish' }),
    ])
    const { out } = run(dir)
    expect(out).toMatch(/not a confirmed-defect count/)
    expect(out).toMatch(/only guards wired to this journal/i)
  })

  it('counts BLOCKED and WARNED together toward the same threshold', () => {
    const dir = mkJournalDir()
    writeWeek(dir, [
      event('wt-x-hook.mjs', { class: 'c', decision: 'blocked' }),
      event('wt-x-hook.mjs', { class: 'c', decision: 'warned' }),
      event('wt-x-hook.mjs', { class: 'c', decision: 'blocked' }),
    ])
    const { out } = run(dir)
    expect(out).toContain('wt-x-hook.mjs')
    expect(out).toContain('3 firings')
  })

  it('is SILENT when the journal directory exists but is UNREADABLE — degrades to silence, never an error', () => {
    const dir = mkJournalDir()
    // A file where a directory is expected makes readdirSync throw ENOTDIR inside
    // readGuardJournal(), which maps to its ok:false/exitCode:3 outcome — this hook must
    // treat that exactly like "nothing to report", per the brief's invariant 5.
    const notADir = join(dir, 'not-a-dir-journal')
    writeFileSync(notADir, 'x')
    const { out, code } = run(notADir)
    expect(out).toBe('')
    expect(code).toBe(0)
  })

  it('is SILENT on a mix of malformed and below-threshold lines — a bad line never crashes the read', () => {
    const dir = mkJournalDir()
    writeFileSync(
      join(dir, '2026-W32.ndjson'),
      [
        'not json at all',
        JSON.stringify(event('wt-main-guard-hook.mjs', { class: 'publish' })),
        '{"missing":"guard field"}',
        JSON.stringify(event('wt-main-guard-hook.mjs', { class: 'publish' })),
      ].join('\n') + '\n',
    )
    const { out, code } = run(dir)
    expect(out).toBe('')
    expect(code).toBe(0)
  })

  it('reads ONLY the current week window (weeks: 1) — an older week-file never contributes to the count', () => {
    const dir = mkJournalDir()
    // Two week-files: the (lexicographically) older one alone would not cross the threshold,
    // and must not be summed in with the newer one to manufacture a false crossing.
    writeFileSync(
      join(dir, '2026-W20.ndjson'),
      [event('wt-main-guard-hook.mjs', { class: 'publish' }), event('wt-main-guard-hook.mjs', { class: 'publish' })]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n',
    )
    writeFileSync(
      join(dir, '2026-W32.ndjson'),
      [event('wt-main-guard-hook.mjs', { class: 'publish' })].map((l) => JSON.stringify(l)).join('\n') + '\n',
    )
    const { out } = run(dir)
    expect(out).toBe('')
  })

  it('exits 0 even when it speaks — a warning light, never a gate', () => {
    const dir = mkJournalDir()
    writeWeek(dir, [
      event('wt-main-guard-hook.mjs', { class: 'publish' }),
      event('wt-main-guard-hook.mjs', { class: 'publish' }),
      event('wt-main-guard-hook.mjs', { class: 'publish' }),
    ])
    expect(run(dir).code).toBe(0)
  })

  it('a fail-open self-test still exits 0 and leaves exactly one stderr trace, never a stdout finding', () => {
    const dir = mkJournalDir()
    writeWeek(dir, [
      event('wt-main-guard-hook.mjs', { class: 'publish' }),
      event('wt-main-guard-hook.mjs', { class: 'publish' }),
      event('wt-main-guard-hook.mjs', { class: 'publish' }),
    ])
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ cwd: REPO_ROOT }),
      encoding: 'utf8',
      env: { ...process.env, WT_GUARD_JOURNAL_DIR: dir, WT_FAIL_OPEN_TRACE_SELF_TEST: 'wt-guard-recurrence-hook.mjs' },
    })
    expect(res.status).toBe(0)
    expect(res.stdout ?? '').toBe('')
    expect(res.stderr).toContain('wt-guard-recurrence-hook.mjs: FAILED OPEN')
  })
})
