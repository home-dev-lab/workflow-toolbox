import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findJournalByTaskId, listRuns, resolveConfigDir, resolveDir } from '../src/source.js'

// resolveConfigDir is the single home of "which Claude config dir am I under?" —
// CLAUDE_CONFIG_DIR ?? ~/.claude, absolutized and realpath'd so two spellings of
// the same dir (relative path, trailing slash, symlink) canonicalize identically.
// This matters on a machine running TWO config dirs at once (e.g. ~/.claude +
// ~/.claude-work): any consumer deriving a slug/pidfile key from the dir
// must see ONE canonical string per real dir.

let tmp: string

beforeEach(() => {
  // realpath'd for the same reason as defaultConfigDir below: on macOS tmpdir()
  // lives under /var → /private/var (a symlink), so the raw mkdtemp path would
  // spuriously mismatch resolveDir's canonicalized return (CI-caught, first
  // cross-os matrix run 2026-07-08).
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wt-configdir-')))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

// The HOME-derived default, canonicalized the same way the implementation does —
// on a machine whose home (or ~/.claude) is a symlink, the raw join() would
// spuriously mismatch the realpath'd return value.
function defaultConfigDir(): string {
  const raw = join(homedir(), '.claude')
  try {
    return realpathSync(raw)
  } catch {
    return raw
  }
}

describe('resolveConfigDir', () => {
  it('defaults to ~/.claude when CLAUDE_CONFIG_DIR is unset', () => {
    expect(resolveConfigDir({})).toBe(defaultConfigDir())
  })

  it('defaults to ~/.claude when CLAUDE_CONFIG_DIR is empty', () => {
    expect(resolveConfigDir({ CLAUDE_CONFIG_DIR: '' })).toBe(defaultConfigDir())
  })

  it('uses CLAUDE_CONFIG_DIR when set to an absolute path', () => {
    const dir = join(tmp, 'claude-work')
    mkdirSync(dir)
    expect(resolveConfigDir({ CLAUDE_CONFIG_DIR: dir })).toBe(dir)
  })

  it('absolutizes a relative CLAUDE_CONFIG_DIR against the cwd', () => {
    expect(resolveConfigDir({ CLAUDE_CONFIG_DIR: 'rel/config' })).toBe(resolve('rel/config'))
  })

  it('normalizes a trailing slash', () => {
    const dir = join(tmp, 'claude-work')
    mkdirSync(dir)
    expect(resolveConfigDir({ CLAUDE_CONFIG_DIR: `${dir}/` })).toBe(dir)
  })

  it('resolves a symlinked CLAUDE_CONFIG_DIR to its real path', () => {
    const real = join(tmp, 'real-config')
    const link = join(tmp, 'link-config')
    mkdirSync(real)
    symlinkSync(real, link)
    expect(resolveConfigDir({ CLAUDE_CONFIG_DIR: link })).toBe(resolveConfigDir({ CLAUDE_CONFIG_DIR: real }))
  })

  it('keeps the absolutized path when the dir does not exist (no throw)', () => {
    const ghost = join(tmp, 'not-created')
    expect(resolveConfigDir({ CLAUDE_CONFIG_DIR: ghost })).toBe(ghost)
  })
})

// multi-observe I5 — resolveDir is the canonicalization CORE resolveConfigDir already used
// internally (absolutize + realpath-with-fallback), extracted so an ARBITRARY path (not just
// one read from CLAUDE_CONFIG_DIR) can be canonicalized the same way — needed for
// OBSERVE_SOURCES (dev-api.ts, colon-separated paths) and wt-observe start's --source /
// auto-discovered candidates (observe-cli.ts). resolveConfigDir is now a thin wrapper: pick
// CLAUDE_CONFIG_DIR or the ~/.claude default, then hand it to resolveDir — so this and
// resolveConfigDir's own suite exercise the SAME underlying logic, never two copies.
describe('resolveDir', () => {
  it('absolutizes a relative path against the cwd', () => {
    expect(resolveDir('rel/config')).toBe(resolve('rel/config'))
  })

  it('normalizes a trailing slash', () => {
    const dir = join(tmp, 'claude-work')
    mkdirSync(dir)
    expect(resolveDir(`${dir}/`)).toBe(dir)
  })

  it('resolves a symlink to its real path', () => {
    const real = join(tmp, 'real-config')
    const link = join(tmp, 'link-config')
    mkdirSync(real)
    symlinkSync(real, link)
    expect(resolveDir(link)).toBe(resolveDir(real))
  })

  it('keeps the absolutized path when the dir does not exist (no throw)', () => {
    const ghost = join(tmp, 'not-created')
    expect(resolveDir(ghost)).toBe(ghost)
  })

  it('resolveConfigDir(CLAUDE_CONFIG_DIR) is exactly resolveDir applied to that same path — one shared canonicalization core', () => {
    const dir = join(tmp, 'claude-work')
    mkdirSync(dir)
    expect(resolveConfigDir({ CLAUDE_CONFIG_DIR: dir })).toBe(resolveDir(dir))
  })
})

// The consumers' threading of the resolved dir: the explicit opts.configDir override
// (findJournalByTaskId is the one resolver its sibling test files do NOT already cover)
// and the default binding — resolveConfigDir(process.env) — reached with NO override,
// through the real env var. Both against a throwaway fixture tree.
describe('config-dir threading', () => {
  function plantJournal(configDir: string, body: unknown): void {
    const wfDir = join(configDir, 'projects', '-threading-proj', 'sess-t', 'workflows')
    mkdirSync(wfDir, { recursive: true })
    writeFileSync(join(wfDir, 'wf_threading.json'), JSON.stringify(body))
  }

  it('findJournalByTaskId honours an explicit opts.configDir', () => {
    plantJournal(tmp, { runId: 'wf_threading', status: 'completed', taskId: 'task-42' })
    const r = findJournalByTaskId('task-42', { configDir: tmp, project: '-threading-proj' })
    expect(r).not.toBeNull()
    expect(r!.runId).toBe('wf_threading')
  })

  it('resolvers fall back to CLAUDE_CONFIG_DIR from process.env when no configDir is given', () => {
    plantJournal(tmp, { runId: 'wf_threading', status: 'completed' })
    vi.stubEnv('CLAUDE_CONFIG_DIR', tmp)
    try {
      const runs = listRuns({ project: '-threading-proj' })
      expect(runs.map((r) => r.runId)).toEqual(['wf_threading'])
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
