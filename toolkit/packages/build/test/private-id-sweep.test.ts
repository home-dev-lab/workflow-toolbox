// private-id-sweep.test.ts — no private tracker identifier on a shipped surface.
//
// This repo's task tracker (a self-hosted Planka board) assigns 19-digit numeric
// ids that all start with "18" at present (card #1832959703479486329 documents
// the range). An id is not a secret — the board is private and self-hosted, it
// opens no access — but citing one in shipped, normative text is a DOCUMENTATION
// defect: the id is a bare identifier with no referent an outside reader can
// resolve (same family as "a bare identifier is not a reference"). A fix on
// 2026-08-02 (commit c1eb57b) removed ONE such id from
// plugin/agent-templates/pilot-orchestrator.md; the blast-radius check that
// followed found 40 more, in 21 shipped files. This gate closes the class going
// forward.
//
// SCOPE, BY CONSTRUCTION: every file under plugin/ and docs/public/, plus the
// repo-root README.md — walked fresh on every run, never a fixed file list, so a
// 22nd file added later is covered automatically (an enumerating guard would stay
// green on it; see the memory fiche `test-lock-invariant-not-enumeration`).
//
// Remedy on failure: replace the id with its SUBSTANCE (what was measured,
// found, or fixed — usually already spelled out in the surrounding prose),
// never delete the sentence outright. See the commit above for the shape.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

// A private tracker id: 19 digits, "18" + 17 more digits (the range in force
// for this board today — see the card cited above). Bare form and `card #`/
// `cards #`-prefixed form are the SAME regex target: the id itself, wherever it
// appears, `\b`-bounded so it never partial-matches inside a longer number.
const PRIVATE_ID = /\b18\d{17}\b/g

// Extensions worth scanning as text. A private id can only appear in something
// authored as prose/code; skipping known-binary kinds avoids a false hit on
// incidental byte sequences without narrowing the scope of TEXT surfaces (any
// text extension not listed here still can't hide a 19-digit run past this
// list without a corresponding real file appearing — extend if one ever does).
const BINARY_EXT = /\.(png|jpg|jpeg|gif|ico|webp|woff2?|ttf|eot|otf|pdf|zip)$/i

const SCAN_ROOTS = ['plugin', 'docs/public']
const SCAN_FILES = ['README.md']

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else yield p
  }
}

function scanFile(absPath: string, relPath: string): string[] {
  if (BINARY_EXT.test(absPath)) return []
  let text: string
  try {
    text = readFileSync(absPath, 'utf8')
  } catch {
    return [] // unreadable (e.g. a symlink target gone) — not this gate's concern
  }
  const hits: string[] = []
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    const matches = line.match(PRIVATE_ID)
    if (matches) for (const m of matches) hits.push(`${relPath}:${i + 1}: ${m}`)
  })
  return hits
}

describe('private-id-sweep — no private tracker id on a shipped surface', () => {
  it('the scan roots exist (a moved/renamed dir would silently empty the scope)', () => {
    for (const root of SCAN_ROOTS) {
      expect(statSync(join(REPO_ROOT, root)).isDirectory(), `${root} is not a directory`).toBe(true)
    }
    for (const f of SCAN_FILES) {
      expect(statSync(join(REPO_ROOT, f)).isFile(), `${f} is not a file`).toBe(true)
    }
  })

  it('no 19-digit private tracker id (bare or "card #"-prefixed) appears under plugin/, docs/public/, or README.md', () => {
    const hits: string[] = []
    for (const root of SCAN_ROOTS) {
      const abs = join(REPO_ROOT, root)
      for (const f of walk(abs)) hits.push(...scanFile(f, relative(REPO_ROOT, f)))
    }
    for (const f of SCAN_FILES) {
      const abs = join(REPO_ROOT, f)
      hits.push(...scanFile(abs, f))
    }
    expect(
      hits,
      `\nprivate tracker id(s) found on a shipped surface — replace with their substance, never delete outright:\n${hits.join('\n')}\n`,
    ).toEqual([])
  })
})
