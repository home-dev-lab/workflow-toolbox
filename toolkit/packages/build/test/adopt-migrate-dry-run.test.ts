// adopt-migrate-dry-run.test.ts — card 1835727457 (rules/wt/ subfolder migration).
//
// Locks TWO things this card's scope split requires, both proven red before green:
//   1. the drift-guard (--check) does not report "nothing adopted" on a healthy,
//      un-migrated flat install (the false negative the card warns against) — it must
//      DETECT the flat copy and name it as migration-pending.
//   2. an already-migrated install (files under rules/wt/, nothing left at the flat root)
//      is NOT flagged — --check reads clean, no migration-pending noise.
//
// A third group locks `adopt:migrate --dry-run` itself: it never writes to disk, reports
// moves/stays/before-after counts, and exits non-zero exactly when it would produce a
// duplicate (a locally-edited copy left at the root while a fresh one would land at the
// new default location).

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, symlinkSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'plugin/skills/adopt/scripts/install.mjs')
const RULE = 'wt-delegation-ladder.md'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function mkDir(): string {
  const r = mkdtempSync(join(tmpdir(), 'wt-adopt-migrate-'))
  roots.push(r)
  return r
}
function run(args: string[]): { out: string; status: number | null } {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  return { out: (res.stdout ?? '') + (res.stderr ?? ''), status: res.status }
}

/** Write a CLEAN (unedited) managed copy of RULE directly under `dir` — same recipe as the
 *  installer's own --install would produce, computed independently via a real --install
 *  round-trip into a throwaway dir so the fixture is never hand-typed content that could
 *  silently diverge from what classify() actually expects (mirrors fixture-from-real-output
 *  discipline). */
function writeCleanFlatCopy(claudeDir: string): void {
  const scratch = mkDir()
  const res = spawnSync(process.execPath, [SCRIPT, '--set', 'rules', '--install', '--dir', join(scratch, 'wt')], {
    encoding: 'utf8',
  })
  if (res.status !== 0) throw new Error(`fixture setup failed: ${res.stdout}${res.stderr}`)
  const body = readFileSync(join(scratch, 'wt', RULE), 'utf8')
  mkdirSync(claudeDir, { recursive: true })
  writeFileSync(join(claudeDir, RULE), body)
}

describe('adopt --check: legacy flat-root fallback (rules/wt/ migration, card 1835727457)', () => {
  it('DETECTS an un-migrated flat install — never reads as "nothing adopted"', () => {
    const claudeDir = mkDir()
    writeCleanFlatCopy(claudeDir) // <claudeDir>/wt-delegation-ladder.md, no wt/ subdir
    const wtDir = join(claudeDir, 'wt')
    expect(existsSync(join(wtDir, RULE)), 'fixture sanity: nothing at the new default location').toBe(false)

    const { out } = run(['--set', 'rules', '--check', '--dir', wtDir])
    expect(out).toContain('MIGRATION-PENDING')
    expect(out).toContain(claudeDir)
    // The false negative this test exists to close: it must NOT read as a clean slate.
    expect(out).not.toMatch(/adopt: nothing to do\./)
    expect(out).toMatch(/item\(s\) found only at the pre-migration rules\/ location/)
  })

  it('an already-migrated install (files under rules/wt/, root empty) is NOT flagged', () => {
    const claudeDir = mkDir()
    const wtDir = join(claudeDir, 'wt')
    writeCleanFlatCopy(wtDir) // the managed file lives ONLY under wt/ — fully migrated
    expect(existsSync(join(claudeDir, RULE)), 'fixture sanity: nothing left at the flat root').toBe(false)

    const { out } = run(['--set', 'rules', '--check', '--dir', wtDir])
    expect(out).not.toContain('MIGRATION-PENDING')
    expect(out).not.toMatch(/pre-migration rules\/ location/)
    expect(out).toContain('UP-TO-DATE')
  })
})

describe('adopt:migrate --dry-run', () => {
  it('bare --migrate (neither --dry-run nor --execute) refuses, naming both flags', () => {
    const claudeDir = mkDir()
    const { out, status } = run(['--migrate', '--dir', join(claudeDir, 'wt')])
    expect(status).not.toBe(0)
    expect(out).toMatch(/needs --dry-run .* or --execute/)
  })

  it('--dry-run and --execute together refuse (ambiguous)', () => {
    const claudeDir = mkDir()
    const { out, status } = run(['--migrate', '--dry-run', '--execute', '--dir', join(claudeDir, 'wt')])
    expect(status).not.toBe(0)
    expect(out).toMatch(/pass exactly one of --dry-run or --execute/)
  })

  it('writes NOTHING to disk (read-only by construction)', () => {
    const claudeDir = mkDir()
    writeCleanFlatCopy(claudeDir)
    const wtDir = join(claudeDir, 'wt')
    const before = readdirSync(claudeDir).sort()
    run(['--migrate', '--dry-run', '--dir', wtDir])
    expect(existsSync(wtDir), 'dry-run must never create the destination dir').toBe(false)
    expect(readdirSync(claudeDir).sort()).toEqual(before)
  })

  it('reports the move (clean copy at the flat root, nothing at the destination)', () => {
    const claudeDir = mkDir()
    writeCleanFlatCopy(claudeDir)
    const wtDir = join(claudeDir, 'wt')
    const { out, status } = run(['--migrate', '--dry-run', '--dir', wtDir])
    expect(status).toBe(0)
    expect(out).toContain(`MOVE ${RULE}: ${join(claudeDir, RULE)} -> ${join(wtDir, RULE)}`)
    expect(out).toMatch(/duplicate-after-migration risk: no/)
  })

  it('a locally-edited copy STAYS, is named with a reason, and exits non-zero (duplicate risk)', () => {
    const claudeDir = mkDir()
    writeCleanFlatCopy(claudeDir)
    const p = join(claudeDir, RULE)
    writeFileSync(p, readFileSync(p, 'utf8') + '\nMY LOCAL EDIT\n')
    const wtDir = join(claudeDir, 'wt')
    const { out, status } = run(['--migrate', '--dry-run', '--dir', wtDir])
    expect(out).toContain(`STAY ${RULE}: ${p}`)
    expect(out).toMatch(/locally edited/)
    expect(out).toMatch(/duplicate-after-migration risk: YES/)
    expect(status).not.toBe(0)
  })

  it('a hand-authored file (no toolbox banner) stays, with a hand-authored reason, no duplicate risk', () => {
    const claudeDir = mkDir()
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(join(claudeDir, 'my-own-rule.md'), '# my own rule\nnever adopted\n')
    const wtDir = join(claudeDir, 'wt')
    const { out } = run(['--migrate', '--dry-run', '--dir', wtDir])
    expect(out).toContain('STAY my-own-rule.md')
    expect(out).toMatch(/hand-authored/)
    expect(out).toMatch(/duplicate-after-migration risk: no/)
  })

  it('reports the loaded set before/after in file count and bytes', () => {
    const claudeDir = mkDir()
    writeCleanFlatCopy(claudeDir)
    const wtDir = join(claudeDir, 'wt')
    const { out } = run(['--migrate', '--dry-run', '--dir', wtDir])
    expect(out).toMatch(/before: 1 file\(s\), \d+ byte\(s\)/)
    expect(out).toMatch(/after \(projected.*\): 1 file\(s\), \d+ byte\(s\)/)
  })

  it('without --secondary-dir, documents the symlink design decision instead of scanning', () => {
    const claudeDir = mkDir()
    writeCleanFlatCopy(claudeDir)
    const wtDir = join(claudeDir, 'wt')
    const { out } = run(['--migrate', '--dry-run', '--dir', wtDir])
    expect(out).toMatch(/DESIGN DECISION/)
    expect(out).toMatch(/directory symlink/)
  })

  it('with --secondary-dir, names a stale per-file symlink whose target moved', () => {
    const claudeDir = mkDir()
    writeCleanFlatCopy(claudeDir)
    const wtDir = join(claudeDir, 'wt')
    const secondary = mkDir()
    mkdirSync(secondary, { recursive: true })
    symlinkSync(join(claudeDir, RULE), join(secondary, RULE))
    const { out } = run(['--migrate', '--dry-run', '--dir', wtDir, '--secondary-dir', secondary])
    expect(out).toContain(join(secondary, RULE))
    expect(out).toMatch(/STALE after migration/)
    expect(out).toMatch(/directory symlink/)
  })
})

// --- adopt:migrate --execute --------------------------------------------------------------
//
// Consumes the SAME plan planMigrationItems() computes for --dry-run (see install.mjs's own
// comment above executeMigration()) — these locks exist to catch the two computing different
// answers, not just to exercise --execute in isolation.

describe('adopt:migrate --execute', () => {
  it('--install never triggers a migration, even with a wt-shaped --dir', () => {
    const claudeDir = mkDir()
    writeCleanFlatCopy(claudeDir)
    const wtDir = join(claudeDir, 'wt')
    const before = readdirSync(claudeDir).sort()
    run(['--set', 'rules', '--install', '--dir', wtDir])
    // --install legitimately WRITES into wtDir (that is its own job) — what must NOT happen
    // is the flat-root file being moved/removed as a side effect of --install.
    expect(existsSync(join(claudeDir, RULE)), '--install must not remove the flat-root file').toBe(true)
    expect(readdirSync(claudeDir).filter((f) => f !== 'wt').sort()).toEqual(before.filter((f) => f !== 'wt').sort())
  })

  it('actually moves a clean file, byte-identical, and reports the count', () => {
    const claudeDir = mkDir()
    writeCleanFlatCopy(claudeDir)
    const wtDir = join(claudeDir, 'wt')
    const originalBytes = readFileSync(join(claudeDir, RULE))

    const { out, status } = run(['--migrate', '--execute', '--dir', wtDir])
    expect(status).toBe(0)
    expect(existsSync(join(claudeDir, RULE)), 'source must be gone after the move').toBe(false)
    expect(existsSync(join(wtDir, RULE)), 'destination must exist after the move').toBe(true)
    expect(readFileSync(join(wtDir, RULE)).equals(originalBytes), 'moved content must be byte-identical').toBe(true)
    expect(out).toMatch(/1 of 1 planned file\(s\) moved/)
    expect(out).toMatch(/1 of 1 confirmed present at destination/)
    expect(out).toContain(wtDir)
  })

  it('refuses when the file is present at BOTH the old and the new location, and moves nothing', () => {
    const claudeDir = mkDir()
    writeCleanFlatCopy(claudeDir)
    const wtDir = join(claudeDir, 'wt')
    mkdirSync(wtDir, { recursive: true })
    writeFileSync(join(wtDir, RULE), 'already something else here\n')
    const beforeFlat = readFileSync(join(claudeDir, RULE))
    const beforeWt = readFileSync(join(wtDir, RULE))

    const { out, status } = run(['--migrate', '--execute', '--dir', wtDir])
    expect(status).not.toBe(0)
    expect(out).toMatch(/REFUSING/)
    expect(out).toContain(RULE)
    expect(readFileSync(join(claudeDir, RULE)).equals(beforeFlat), 'nothing must move on refusal').toBe(true)
    expect(readFileSync(join(wtDir, RULE)).equals(beforeWt), 'destination must be untouched on refusal').toBe(true)
  })

  it('refuses on an unreadable source and moves nothing', () => {
    const claudeDir = mkDir()
    writeCleanFlatCopy(claudeDir)
    const wtDir = join(claudeDir, 'wt')
    const p = join(claudeDir, RULE)
    chmodSync(p, 0o000)
    try {
      const { out, status } = run(['--migrate', '--execute', '--dir', wtDir])
      expect(status).not.toBe(0)
      expect(out).toMatch(/REFUSING/)
      expect(out).toMatch(/unreadable/)
      expect(existsSync(wtDir), 'destination dir must not even be created on refusal').toBe(false)
    } finally {
      chmodSync(p, 0o644) // restore so the fixture temp dir cleans up
    }
  })

  it('a locally-edited copy refuses the whole run too (future-duplicate risk), moves nothing', () => {
    const claudeDir = mkDir()
    writeCleanFlatCopy(claudeDir)
    const p = join(claudeDir, RULE)
    writeFileSync(p, readFileSync(p, 'utf8') + '\nMY LOCAL EDIT\n')
    const wtDir = join(claudeDir, 'wt')
    const before = readFileSync(p)

    const { out, status } = run(['--migrate', '--execute', '--dir', wtDir])
    expect(status).not.toBe(0)
    expect(out).toMatch(/REFUSING/)
    expect(readFileSync(p).equals(before)).toBe(true)
    expect(existsSync(wtDir)).toBe(false)
  })

  it('a hand-authored file is left in place, reported, and does not block the run', () => {
    const claudeDir = mkDir()
    writeCleanFlatCopy(claudeDir)
    writeFileSync(join(claudeDir, 'my-own-rule.md'), '# my own rule\nnever adopted\n')
    const wtDir = join(claudeDir, 'wt')

    const { out, status } = run(['--migrate', '--execute', '--dir', wtDir])
    expect(status).toBe(0)
    expect(existsSync(join(claudeDir, 'my-own-rule.md')), 'hand-authored file stays put').toBe(true)
    expect(existsSync(join(wtDir, RULE)), 'the clean managed file still moves').toBe(true)
    expect(out).toContain('STAY my-own-rule.md')
  })

  it('running it a second time is a no-op that says so, never an error', () => {
    const claudeDir = mkDir()
    writeCleanFlatCopy(claudeDir)
    const wtDir = join(claudeDir, 'wt')
    const first = run(['--migrate', '--execute', '--dir', wtDir])
    expect(first.status).toBe(0)

    const second = run(['--migrate', '--execute', '--dir', wtDir])
    expect(second.status).toBe(0)
    expect(second.out).toMatch(/nothing to move/)
    expect(existsSync(join(wtDir, RULE)), 'file stays at the destination after the no-op re-run').toBe(true)
  })
})
