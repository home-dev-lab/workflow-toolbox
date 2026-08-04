// fidelity-checker-protocol.test.ts — TEST-LOCKS for cards #1833712098392147080 and
// #1833715548525954228.
//
// Card A locks the routing invariant, not exact prose: a miss on one phrasing is NOT evidence
// of absence; before `NOT ROUTABLE`, the protocol must require a second attempt in the store's
// language or a synonym. This was measured ONCE on one bilingual pair (`exposure` vs
// `fenetre d'exposition`); the test only guards that the warning stays present.
//
// Card B locks the division of labour: coverage comes FROM the probe, is never silently
// re-derived by the checker, and missing probe output forces an explicit UNVERIFIED/capped
// state. Routing and hook quality stay in the protocol because they are judgment, not counting.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const DEF_COPIES = [
  join(REPO_ROOT, 'plugin/agents/fidelity-checker.md'),
  join(REPO_ROOT, 'plugin/launch-agents/agents/fidelity-checker.md'),
]

describe('fidelity-checker protocol — routing language guard and probe dependency stay explicit', () => {
  for (const path of DEF_COPIES) {
    const rel = path.slice(REPO_ROOT.length)
    describe(rel, () => {
      const def = readFileSync(path, 'utf8')

      it('states that a negative search for one phrasing is not evidence of absence', () => {
        expect(def).toContain('A negative search for one phrasing is not evidence of absence.')
      })

      it('requires a second routing attempt in the store language or a synonym before NOT ROUTABLE', () => {
        expect(def).toMatch(/Before you conclude\s+`NOT ROUTABLE`, try at least one second phrasing that matches the store's actual language or a\s+near synonym/i)
        expect(def).toContain('report both attempts')
      })

      it('treats coverage-probe output as an input to judgment, not something the checker silently regenerates', () => {
        expect(def).toMatch(/The probe's output is\s+an INPUT to your judgment, not a thing you silently regenerate in your own\s+turn\./)
        expect(def).not.toContain('If none was supplied**, run it yourself before reading anything else')
        expect(def).not.toContain('there is no reason to count by hand instead:')
      })

      it('forces the missing-probe case to stay explicit: UNVERIFIED source line, no silent hand count, capped verdict', () => {
        expect(def).toContain('coverage is **UNVERIFIED**')
        expect(def).toContain('Coverage probe (wt-memory-index-check.mjs): UNREACHABLE')
        expect(def).toMatch(/never silently re-run the probe, never silently fall back to counting\s+fiches by hand/i)
        expect(def).toContain('if ANY source above is')
        expect(def).toContain('you may NOT write a bare `(A) Resumable? yes`')
      })

      it('requires the UNVERIFIED reason to distinguish a spawner omission from an unreadable store', () => {
        // Both cap the verdict, so the cap alone cannot tell them apart — and they call for
        // opposite actions. Without this, a spawn brief that forgot the flag reads as a defective
        // store: a guard firing on a correct state, which is how guards get switched off.
        expect(def).toContain('not supplied by the spawner')
        expect(def).toContain('probe could not run')
      })
    })
  }
})
