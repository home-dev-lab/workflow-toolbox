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
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, symlinkSync } from 'node:fs'
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
  it('refuses to run the real migration — only --dry-run exists', () => {
    const claudeDir = mkDir()
    const { out, status } = run(['--migrate', '--dir', join(claudeDir, 'wt')])
    expect(status).not.toBe(0)
    expect(out).toMatch(/only --migrate --dry-run is implemented/)
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
