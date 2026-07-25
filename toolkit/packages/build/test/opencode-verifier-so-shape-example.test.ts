// opencode-verifier-so-shape-example.test.ts — TEST-LOCK for card #1826482683635566557.
//
// Bug (forensics: audit-fail-forensics.md §2, run wf_6f63845d-100, 2026-07-24): the haiku
// Extract wrapper's `opencode` CLI call succeeds (valid claims JSON produced), then the
// wrapper's OWN `StructuredOutput` tool call nests that JSON under a spurious top-level
// wrapper key (`parameter`, `input`, or `schema`+`data`) instead of the schema's bare
// fields (e.g. `claims`) — the identical validation error then repeats; some agents
// self-correct in 1-2 tries, at least one burned its full 5-attempt retry cap, another was
// still stuck when the run died. This is a DISTINCT class from the maxTurns card
// (#1826435622940706740) and from the taskfile-location bug already locked by
// opencode-verifier-taskfile.test.ts.
//
// Fix (route (a) of the card, the cheapest): a WORKED EXAMPLE in the schema-relay step (7)
// that shows the exact correct shape and names the three observed wrong shapes verbatim, so
// the model has a concrete negative example to pattern-match against instead of inferring
// the convention from the abstract schema alone. This is a PROMPT-ONLY change — this test
// locks its PRESENCE and well-formedness on BOTH in-repo copies; it cannot prove efficacy
// (see the report's efficacy-measurement section for that).
//
// Byte-identity between the two copies is already enforced by launch-agents-identity.test.ts;
// this test asserts the invariant directly on EACH copy (same pattern as
// opencode-verifier-taskfile.test.ts) so the fix can never silently regress on either path.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const DEF_COPIES = [
  join(REPO_ROOT, 'plugin/agents/opencode-verifier.md'),
  join(REPO_ROOT, 'plugin/launch-agents/agents/opencode-verifier.md'),
]

describe('opencode-verifier bridge — SCHEMA-RELAY worked example guards the parasite-key mistake', () => {
  for (const path of DEF_COPIES) {
    const rel = path.slice(REPO_ROOT.length)
    describe(rel, () => {
      const def = readFileSync(path, 'utf8')

      it('carries a worked-example section for the schema-relay top-level shape', () => {
        expect(def).toContain('Worked example (the top-level-shape mistake to avoid)')
      })

      it('shows the CORRECT bare-schema call shape', () => {
        expect(def).toContain('`{"claims": [...]}`')
      })

      it('names all three observed WRONG wrapper-key shapes verbatim (parameter / input / schema+data)', () => {
        expect(def).toContain('{"parameter": {"claims": [...]}}')
        expect(def).toContain('{"input": {"claims": [...]}}')
        expect(def).toContain('{"schema": {...}, "data": {"claims": [...]}}')
      })

      it('states the invariant generally — parameter/input/schema/data are never real schema property names', () => {
        expect(def).toContain('never real property names of the schema you were handed')
      })

      it('tells the model what to do when it catches itself mid-mistake (re-read required/properties, call again bare)', () => {
        expect(def).toContain('re-read the schema')
        expect(def).toContain('call again with the bare fields')
      })

      it('does NOT carry an internal date or run-provenance string (shipped-docs-boundary: plugin/ is shipped surface)', () => {
        // The fix must state the durable rule only — no absolute date, no internal run id,
        // tied to when/where the bug was observed (memory fiche shipped-docs-boundary).
        expect(def).not.toMatch(/\b2026-\d{2}-\d{2}\b/)
        expect(def).not.toMatch(/wf_[0-9a-f]{8}-[0-9a-f]{3}/)
      })

      it('places the worked example inside the schema-relay step, right after the Valid bullet (so it reads in context)', () => {
        const validIdx = def.indexOf('call the `StructuredOutput` tool with THAT object, copying each value verbatim')
        const exampleIdx = def.indexOf('Worked example (the top-level-shape mistake to avoid)')
        const malformedIdx = def.indexOf('**Malformed**')
        expect(validIdx).toBeGreaterThan(-1)
        expect(exampleIdx).toBeGreaterThan(validIdx)
        expect(malformedIdx).toBeGreaterThan(exampleIdx)
      })
    })
  }
})
