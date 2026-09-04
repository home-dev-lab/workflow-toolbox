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
 *  copies (debugger, patterns, hook) must hold byte-identical source.
 *
 *  ⚠ Until 2026-08-27 this comment named THREE copies and the body read TWO: the hook was never
 *  opened, so the one copy that actually EXECUTES was the one nothing locked. The two it did
 *  compare are library sources; the hook is registered PreToolUse/PostToolUse in both plugin
 *  manifests and runs in every session of every adopting project. The drift-lock guarded the
 *  copies that cannot misbehave at runtime and skipped the one that can.
 *
 *  ⚠ DELIBERATELY EXCLUDED — `plugin/bin/wt-stop-hook.mjs` carries the same registry inline but is
 *  a deterministic BUILD ARTIFACT of the debugger source (its header names it, and it is
 *  byte-identical to its mirror `toolkit/bin/wt-stop-hook.mjs`). It cannot drift independently;
 *  asserting on it would lock a generated file and go red on every legitimate rebuild.
 *
 *  ⚠ NOT COVERED, named rather than implied: the observe-ui delegation panel in the private
 *  `workflow-observatory` repo is cited by `provenance-gate.ts` as another consumer of this
 *  registry. It is outside this repository, so nothing here can lock it. */
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

  // Its OWN test rather than another assertion in the one above: this is the copy that EXECUTES,
  // and a drift here should fail under a name that says so instead of inside a test about library
  // sources. It also makes the count move, which is how a merge that silently dropped this is
  // caught.
  it('the HOOK copy — the one that actually runs — is byte-identical to the shipped debugger copy', () => {
    const canonical = extractMatcherBody('../../debugger/src/external-delegation.ts')
    // Resolved from import.meta.url, not cwd, so it holds in a worktree as well as the main
    // checkout — a cwd-relative path here would SKIP silently in every worktree gate.
    const hook = extractMatcherBody('../../../../plugin/bin/wt-verifier-cli-guard-hook.mjs')
    expect(hook, 'the executing hook copy has drifted from the canonical debugger source').toBe(
      canonical,
    )
    expect(hook).toContain('function matchesOpencodeRun(')
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
