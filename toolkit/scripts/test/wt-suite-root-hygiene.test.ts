// GUARD (card: temp dirs leaking into the wt-suite umbrella root — never a git repo, so no
// .gitignore can hide them). Root cause investigated 2026-07-27: `os.tmpdir()` in a
// short-lived hook/tool process was observed resolving to
// `/home/doublefx/projects/wt-suite` instead of `/tmp` at least 4 times within one hour
// (marker files `wt-verifier-denies-*` written by plugin/bin/wt-verifier-cli-guard-hook.mjs's
// markerDir(), which trusts `process.env.TMPDIR || os.tmpdir()` unconditionally). The three
// live top-level `claude` CLI processes at investigation time all had a correct
// TMPDIR=/tmp — the offending process had already exited, so the exact upstream setter of a
// project-rooted TMPDIR could not be captured live. This test does NOT depend on finding that
// setter: it is a WHITELIST sweep of the root's actual contents, so any future producer
// (regardless of cause) trips it — the failure mode this closes is a narrow
// prefix-based check (e.g. only `prov-*`/`cap-reg-*`) that would have missed `tsx-1000` and
// `node-compile-cache`, the two entries that actually proved the os.tmpdir() misresolution.
//
// This machine-specific path only exists on doublefx's box — the test SKIPS (not fails) when
// it's absent, so it never breaks CI or another contributor's checkout.
import { describe, expect, it } from 'vitest'
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const WT_SUITE_ROOT = '/home/doublefx/projects/wt-suite'

// Whitelist: everything that has a legitimate, committed reason to live at the umbrella
// root. Anything else — a temp dir, a stray cache, a misrouted os.tmpdir() write — fails.
const ALLOWED = new Set([
  'CLAUDE.md',
  'CLAUDE.local.md',
  'docs',
  'opencode',
  'reports',
  'workflow-observatory',
  'workflow-toolbox',
  'worktrees',
])

// Editing CLAUDE.md / CLAUDE.local.md at this root leaves a dated backup alongside it
// (`<file>.bak-<YYYYMMDD-HHMM>`) — a deliberate, standing convention (see the files already
// present: CLAUDE.md.bak-20260723-1356, CLAUDE.local.md.bak-20260723-1406), not a stray temp
// artifact. Pattern-matched (not enumerated) since each backup's suffix is unique.
const BACKUP_RE = /^CLAUDE(\.local)?\.md\.bak-\d{8}-\d{4}$/

function isAllowed(name: string): boolean {
  if (ALLOWED.has(name)) return true
  if (BACKUP_RE.test(name)) return true
  // dotdirs/dotfiles (.claude, .idea, .serena, .gitignore-style local state, etc.) are
  // deliberately out of scope for this guard: they're IDE/tool state, not the
  // os.tmpdir()-misresolution class this guard exists to catch.
  if (name.startsWith('.')) return true
  return false
}

function sweepRoot(root: string): { name: string; mtime: Date }[] {
  return readdirSync(root)
    .filter((name) => !isAllowed(name))
    .map((name) => ({ name, mtime: statSync(join(root, name)).mtime }))
}

describe('wt-suite root hygiene', () => {
  it('has no unexpected (non-whitelisted) entries', () => {
    let entries: string[]
    try {
      entries = readdirSync(WT_SUITE_ROOT)
    } catch {
      // Machine-specific root absent (different checkout/CI box) — skip, never fail.
      return
    }
    void entries
    const intruders = sweepRoot(WT_SUITE_ROOT)
    if (intruders.length > 0) {
      const listing = intruders
        .map((i) => `  ${i.name}  (mtime: ${i.mtime.toISOString()})`)
        .join('\n')
      throw new Error(
        `Unexpected entries at the wt-suite umbrella root (not git-tracked — nothing ` +
          `ignores them). Each one's mtime names the run that likely produced it:\n${listing}\n` +
          `If legitimate, add it to ALLOWED in this test; if not, find what wrote it (a ` +
          `process whose os.tmpdir()/TMPDIR resolved here instead of /tmp) and fix that.`
      )
    }
    expect(intruders).toEqual([])
  })

  // Proves the guard actually fires (not just a trivially-green whitelist) — creates a
  // real intruder, asserts the sweep sees it, then cleans up regardless of outcome.
  it('flags a fabricated intruder directory (red-path proof)', () => {
    let hasRoot: boolean
    try {
      statSync(WT_SUITE_ROOT)
      hasRoot = true
    } catch {
      hasRoot = false
    }
    if (!hasRoot) return // machine-specific root absent — skip

    const intruderName = `wt-hygiene-guard-selftest-${process.pid}`
    const intruderPath = join(WT_SUITE_ROOT, intruderName)
    mkdirSync(intruderPath, { recursive: true })
    try {
      const intruders = sweepRoot(WT_SUITE_ROOT)
      expect(intruders.some((i) => i.name === intruderName)).toBe(true)
    } finally {
      rmSync(intruderPath, { recursive: true, force: true })
    }
  })
})
