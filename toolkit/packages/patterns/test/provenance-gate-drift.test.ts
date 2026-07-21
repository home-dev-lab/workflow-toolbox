// provenance-gate-drift.test.ts — DRIFT-LOCK: the local external-CLI signature registry in
// @workflow-toolbox/patterns MUST stay byte-identical to the canonical registry shipped in
// @workflow-toolbox/debugger/external-delegation. patterns (published) cannot depend on
// debugger (private) at runtime, so it holds a deliberate COPY; this test — a devDependency on
// the workspace debugger — fails the moment the two diverge (a changed regex, a new external
// bridge added to the shipped registry but not the copy, or vice versa). If this fails after a
// legitimate signature change, port the change to BOTH, or (better) hoist the registry into a
// shared published package.

import { describe, it, expect } from 'vitest'
import { DELEGATION_EXPECTATIONS } from '@workflow-toolbox/debugger/external-delegation'
import { EXTERNAL_CLI_SIGNATURES } from '../src/provenance-gate.js'

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
})
