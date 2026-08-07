// adopt-changelog-span-drift.test.ts — the duplication lock between
// plugin/skills/adopt/scripts/changelog-span.mjs and its inlined byte-identical copy in
// plugin/skills/adopt/scripts/install.mjs.
//
// install.mjs must stay a single relocatable script (its own tests copy it alone into a
// synthetic plugin root — a runtime import of a sibling module breaks it there,
// ERR_MODULE_NOT_FOUND, measured across six test files by an earlier duplication:
// UNIVERSAL_ENV_REQUIREMENTS vs plugin/bin/lib/env-prerequisites.mjs, kept honest by
// env-prerequisite-drift-hook.test.ts's own text-equality check). This test is that same
// discipline applied to the changelog-span CORE block: both files carry the identical
// text between the `CHANGELOG-SPAN CORE START`/`END` markers, and this asserts it —
// so an edit to one copy that forgets the other fails loudly here instead of drifting
// silently into two different behaviours.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const STANDALONE = join(REPO_ROOT, 'plugin/skills/adopt/scripts/changelog-span.mjs')
const INSTALLER = join(REPO_ROOT, 'plugin/skills/adopt/scripts/install.mjs')

const START_MARKER = '// === CHANGELOG-SPAN CORE START'
const END_MARKER = '// === CHANGELOG-SPAN CORE END ==='

function extractCore(source: string, label: string): string {
  const startIdx = source.indexOf(START_MARKER)
  const endIdx = source.indexOf(END_MARKER)
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`${label}: could not locate the CHANGELOG-SPAN CORE markers`)
  }
  // Start reading AFTER the marker's own comment line (the marker line's wording is
  // free to differ between the two files — a pointer to the other copy on one side
  // and a pointer back on the other — only the CODE below it must match).
  const afterStartLine = source.indexOf('\n', startIdx) + 1
  return source.slice(afterStartLine, endIdx)
}

describe('changelog-span CORE — install.mjs and changelog-span.mjs stay byte-identical', () => {
  it('the code between the CORE markers is IDENTICAL text in both files', () => {
    const standaloneSource = readFileSync(STANDALONE, 'utf8')
    const installerSource = readFileSync(INSTALLER, 'utf8')
    const standaloneCore = extractCore(standaloneSource, 'changelog-span.mjs')
    const installerCore = extractCore(installerSource, 'install.mjs')

    // Non-emptiness first: a marker rename on one side that still "matches" by accident
    // (e.g. both indexOf calls returning -1 handled above) must not let an empty-vs-empty
    // comparison pass as agreement.
    expect(standaloneCore.trim().length, 'changelog-span.mjs CORE block must not be empty').toBeGreaterThan(0)
    expect(installerCore.trim().length, 'install.mjs CORE block must not be empty').toBeGreaterThan(0)
    expect(installerCore).toBe(standaloneCore)
  })
})
