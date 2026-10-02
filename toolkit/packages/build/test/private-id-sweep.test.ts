// private-id-sweep.test.ts — no private tracker identifier and no machine home path on a shipped surface.
//
// This repo's task tracker (a self-hosted Planka board) assigns 19-digit numeric
// ids. An id is not a secret — the board is private and self-hosted, it opens no
// access — but citing one in shipped, normative text is a DOCUMENTATION defect: the
// id is a bare identifier with no referent an outside reader can resolve (same
// family as "a bare identifier is not a reference"). A fix on 2026-08-02 (commit
// c1eb57b) removed ONE such id from plugin/agent-templates/pilot-orchestrator.md;
// the blast-radius check that followed found 40 more, in 21 shipped files. This
// gate closes the class going forward. The home directory of the machine running
// the gate is checked beside it: an absolute path under it names a person's
// machine layout, never something an outside reader can use.
//
// SCOPE, BY CONSTRUCTION: every file git would ship (tracked, or new and not
// ignored) under plugin/, plugins/, docs/public/ and .claude-plugin/, plus the
// repo-root README.md — listed fresh on every run, never a fixed file list, so a
// file or a whole plugin added later is covered automatically (an enumerating
// guard would stay green on it; see the memory fiche
// `test-lock-invariant-not-enumeration`). Git-ignored local output (eval results,
// build leftovers) never ships and is not scanned. Each plugin under plugins/ gets
// its own case below, generated from that listing, so no plugin depends on someone
// remembering to register it; and every plugin the marketplace declares must sit
// inside a scanned root.
//
// Remedy on failure: replace the id with its SUBSTANCE (what was measured,
// found, or fixed — usually already spelled out in the surrounding prose), never
// delete the sentence outright; write a home path as `~/...`. See the commit above
// for the shape.

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

// A private tracker id: a run of exactly 19 digits. Bounded by non-digits only, so an
// id glued to a letter or an underscore (`card_<id>`) is still caught and the check
// survives the board's ids leaving their current leading digits. A run after a `.` is
// a decimal fraction, never an id.
const PRIVATE_ID = /(?<![\d.])\d{19}(?!\d)/g

// 19-digit literals that are provably not tracker ids. Each entry names what it is.
const NOT_AN_ID = new Set([
  '9223372036854775807', // 2^63 - 1, the signed 64-bit maximum, used as an upper bound
])

function accountHome(): string {
  try {
    return userInfo().homedir
  } catch {
    return '' // no account entry for this uid (some containers): HOME alone is checked
  }
}

// Derived from the machine the gate RUNS on, never written down: a literal home path in
// this file would be the very thing it exists to keep out of a public repository. Both
// the HOME variable and the account's own entry are read, so a gate that swaps HOME for
// a temporary directory still checks the real one. A home of `/` (or empty) would match
// every absolute path, so it is not checked.
const HOMES = [...new Set([homedir(), accountHome()])].filter((home) => home.length > 1)
const HOME_PATTERNS = HOMES.map((home) => new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`))

// Extensions worth scanning as text. A private id can only appear in something
// authored as prose/code; skipping known-binary kinds avoids a false hit on
// incidental byte sequences without narrowing the scope of TEXT surfaces.
const BINARY_EXT = /\.(png|jpg|jpeg|gif|ico|webp|woff2?|ttf|eot|otf|pdf|zip)$/i

const SCAN_ROOTS = ['plugin', 'docs/public', '.claude-plugin']
const PLUGINS_ROOT = 'plugins'
const SCAN_FILES = ['README.md']

// What would ship: tracked files plus new files git does not ignore. A failure to list
// is a red test, never an empty scope.
function shippedFiles(): string[] {
  const res = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...SCAN_ROOTS, PLUGINS_ROOT, ...SCAN_FILES], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (res.status !== 0) throw new Error(`git ls-files failed (${res.status}): ${res.stderr || res.error}`)
  return [...new Set(res.stdout.split('\0').filter(Boolean))].sort()
}

function readText(relPath: string): string | undefined {
  if (BINARY_EXT.test(relPath)) return undefined
  try {
    return readFileSync(join(REPO_ROOT, relPath), 'utf8')
  } catch {
    return undefined // listed but unreadable (a deleted file not yet staged, a symlink) — nothing ships from it
  }
}

function idHits(text: string, relPath: string): string[] {
  const hits: string[] = []
  text.split('\n').forEach((line, i) => {
    for (const m of line.match(PRIVATE_ID) ?? []) if (!NOT_AN_ID.has(m)) hits.push(`${relPath}:${i + 1}: ${m}`)
  })
  return hits
}

function homeHits(text: string, relPath: string): string[] {
  const hits: string[] = []
  text.split('\n').forEach((line, i) => {
    if (HOME_PATTERNS.some((pattern) => pattern.test(line))) hits.push(`${relPath}:${i + 1}: machine home path`)
  })
  return hits
}

function scan(relPaths: string[], check: (text: string, rel: string) => string[]): string[] {
  const hits: string[] = []
  for (const rel of relPaths) {
    const text = readText(rel)
    if (text !== undefined) hits.push(...check(text, rel))
  }
  return hits
}

const files = shippedFiles()
const sharedSurface = files.filter((f) => !f.startsWith(`${PLUGINS_ROOT}/`))
const pluginNames = [...new Set(files.filter((f) => f.startsWith(`${PLUGINS_ROOT}/`)).map((f) => f.split('/')[1]))].sort()

const remedy = (kind: string, hits: string[]) =>
  `\n${kind} found on a shipped surface — replace an id with its substance and a home path with ~/..., never delete the sentence outright:\n${hits.join('\n')}\n`

describe('private-id-sweep — no private tracker id or machine home path on a shipped surface', () => {
  it('every scan root ships files, plugins/ holds at least one plugin, and a home path is checked (an empty scope would pass silently)', () => {
    for (const root of [...SCAN_ROOTS, PLUGINS_ROOT]) {
      expect(files.some((f) => f.startsWith(`${root}/`)), `${root}/ lists no shipped file`).toBe(true)
    }
    for (const f of SCAN_FILES) expect(files, `${f} is not listed`).toContain(f)
    expect(pluginNames.length, `${PLUGINS_ROOT}/ holds no plugin`).toBeGreaterThan(0)
    expect(HOMES.length, 'no home directory could be read on this machine').toBeGreaterThan(0)
  })

  it('every plugin the marketplace declares lives inside a scanned root', () => {
    const marketplace = JSON.parse(readFileSync(join(REPO_ROOT, '.claude-plugin', 'marketplace.json'), 'utf8')) as {
      plugins: { name: string; source: string }[]
    }
    const outside = marketplace.plugins
      .map((p) => ({ name: p.name, source: posix.normalize(p.source).replace(/^\.\//, '') }))
      .filter(({ source }) => {
        if (source === 'plugin' || source.startsWith('plugin/')) return false
        const [root, name] = source.split('/')
        return !(root === PLUGINS_ROOT && name !== undefined && pluginNames.includes(name))
      })
    expect(outside, 'marketplace plugin(s) outside the scanned roots').toEqual([])
  })

  it('no 19-digit private tracker id appears under plugin/, docs/public/, .claude-plugin/, or README.md', () => {
    const hits = scan(sharedSurface, idHits)
    expect(hits, remedy('private tracker id(s)', hits)).toEqual([])
  })

  it('no machine home path appears under plugin/, docs/public/, .claude-plugin/, or README.md', () => {
    const hits = scan(sharedSurface, homeHits)
    expect(hits, remedy('machine home path(s)', hits)).toEqual([])
  })

  for (const name of pluginNames) {
    it(`plugins/${name} carries no private tracker id or machine home path`, () => {
      const own = files.filter((f) => f.startsWith(`${PLUGINS_ROOT}/${name}/`))
      const hits = [...scan(own, idHits), ...scan(own, homeHits)]
      expect(hits, remedy('private data', hits)).toEqual([])
    })
  }
})
