// provenance-gate-drift.test.ts — DRIFT-LOCK: the local external-CLI signature registry in
// @workflow-toolbox/patterns MUST stay byte-identical to the canonical registry shipped in
// @workflow-toolbox/debugger/external-delegation. patterns (published) cannot depend on
// debugger (private) at runtime, so it holds a deliberate COPY; this test — a devDependency on
// the workspace debugger — fails the moment the two diverge (a changed regex, a new external
// bridge added to the shipped registry but not the copy, or vice versa). If this fails after a
// legitimate signature change, port the change to BOTH, or (better) hoist the registry into a
// shared published package.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { DELEGATION_EXPECTATIONS } from '@workflow-toolbox/debugger/external-delegation'
import { EXTERNAL_CLI_SIGNATURES } from '../src/provenance-gate.js'

/** Extract the text STRICTLY between the matchesOpencodeRun drift-lock markers of a source file.
 *  Compares FILE TEXT (not `.toString()`) so it is immune to transpiler formatting — the three
 *  copies (debugger, patterns, hook) must hold byte-identical source. */
function extractMatcherBody(relUrl: string): string {
  const text = readFileSync(fileURLToPath(new URL(relUrl, import.meta.url)), 'utf8')
  const START = '// --- wt-drift-lock:matchesOpencodeRun START'
  const END = '// --- wt-drift-lock:matchesOpencodeRun END ---'
  const s = text.indexOf(START)
  const e = text.indexOf(END)
  if (s === -1 || e === -1) throw new Error(`matcher markers not found in ${relUrl}`)
  return text.slice(text.indexOf('\n', s) + 1, e)
}

describe('external-CLI signature registry drift-lock', () => {
  it('the local copy is byte-identical to the shipped registry (same entries, same regexes)', () => {
    const shipped = DELEGATION_EXPECTATIONS.map((e) => ({
      id: e.id,
      typeReSource: e.typeRe.source,
      typeReFlags: e.typeRe.flags,
      commandReSource: e.commandRe.source,
      commandReFlags: e.commandRe.flags,
    }))
    const local = EXTERNAL_CLI_SIGNATURES.map((e) => ({
      id: e.id,
      typeReSource: e.typeRe.source,
      typeReFlags: e.typeRe.flags,
      commandReSource: e.commandRe.source,
      commandReFlags: e.commandRe.flags,
    }))
    // Same count (catches a new external bridge added upstream but not copied here) AND same
    // per-entry regexes (catches a signature edit on either side).
    expect(local).toEqual(shipped)
  })

  it('the matchesOpencodeRun body is byte-identical to the shipped debugger copy', () => {
    // The opencode signature now carries an EXECUTABLE linear matcher (matchCommand). Its source
    // must stay byte-identical across debugger (canonical) + patterns (this copy) + the hook —
    // the checker's embedded scanner inlines this exact body via `.toString()`. A regex-only
    // drift-lock would miss a divergence in the matcher's logic, so assert the source region too.
    const canonical = extractMatcherBody('../../debugger/src/external-delegation.ts')
    const copy = extractMatcherBody('../src/provenance-gate.ts')
    expect(copy).toBe(canonical)
    expect(copy).toContain('function matchesOpencodeRun(')
    // The registry entry actually wires the matcher (not a dangling function).
    expect(EXTERNAL_CLI_SIGNATURES.find((e) => e.id === 'opencode')?.matchCommand).toBeTypeOf('function')
  })
})
