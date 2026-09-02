// rules-rationale-referential.test.ts — permanent referential-integrity gate over the
// shipped-rules split (2026-09-02 static-prefix cut).
//
// A frozen byte-for-byte baseline (the FIRST design of this gate) proves a migration is
// lossless AT THE MOMENT of the cut, but it is the wrong shape for a PERMANENT lock: it
// forbids ever deleting a baseline line from both files again, which means a legitimate
// future rewrite or retirement of a sentence in a shipped rule fails this suite forever
// unless the dead text is kept alive in the rationale doc just to satisfy the comparison.
// That one-off verification now lives in `toolkit/scripts/verify-rules-rationale-split.mjs`,
// run by hand against a frozen pre-cut directory at cut time (counts recorded in the
// CHANGELOG entry) — it is NOT part of `pnpm test`.
//
// What THIS test locks instead, and keeps meaningful as content evolves:
//   (a) every "Rationale and field cases:" / "Enforced by ... Rationale and field cases:"
//       pointer line in a plugin/rules/wt-*.md names a `§<heading>` that exists as a
//       "## <heading>" line in the matching plugin/docs/rules-rationale/<rule>.md — a
//       pointer never dangles.
//   (b) every "## <heading>" in a rationale doc is referenced by at least one §pointer
//       somewhere in its rule — no orphan section nobody points at.
//   (c) a rationale doc file exists for every rule file, one-to-one — no rule without a
//       doc, no doc without a rule.
//   (d) no non-comment line in a rationale doc is duplicated verbatim in its rule (the
//       "BOTH" check from the original split-verifier — this half stays meaningful
//       indefinitely, since a genuine duplication is always a defect, not an evolution).
//
// Remedy on failure: (a) fix or remove the dangling pointer; (b) either point a pointer at
// the orphan section or fold it back into the rule; (c) add the missing doc/rule; (d) the
// duplicated line belongs in exactly one of the two files — remove it from the other.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const RULES_DIR = join(REPO_ROOT, 'plugin/rules')
const DOCS_DIR = join(REPO_ROOT, 'plugin/docs/rules-rationale')

const POINTER_RE = /§(.+)\.\s*$/
const HEADING_RE = /^##\s+(.+?)\s*$/

function ruleNames(): string[] {
  return readdirSync(RULES_DIR)
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .map((f) => f.slice(0, -3))
    .sort()
}

function extractPointerHeadings(ruleText: string): string[] {
  const out: string[] = []
  for (const line of ruleText.split('\n')) {
    const m = POINTER_RE.exec(line)
    if (m && m[1] !== undefined) out.push(m[1].trim())
  }
  return out
}

function extractDocHeadings(docText: string): string[] {
  const out: string[] = []
  for (const line of docText.split('\n')) {
    const m = HEADING_RE.exec(line)
    if (m && m[1] !== undefined) out.push(m[1].trim())
  }
  return out
}

describe('rules-rationale-referential (shipped-rules cut, 2026-09-02)', () => {
  const names = ruleNames()

  it('every rule file has exactly one matching rationale doc, and vice versa', () => {
    const docNames = readdirSync(DOCS_DIR)
      .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
      .map((f) => f.slice(0, -3))
      .sort()
    expect(docNames).toEqual(names)
  })

  for (const name of names) {
    it(`${name}: every pointer §heading resolves, every doc heading is referenced, no verbatim duplication`, () => {
      const ruleText = readFileSync(join(RULES_DIR, `${name}.md`), 'utf8')
      const docText = readFileSync(join(DOCS_DIR, `${name}.md`), 'utf8')

      const pointerHeadings = extractPointerHeadings(ruleText)
      const docHeadings = extractDocHeadings(docText)

      // (a) every pointer names a heading that exists in the doc
      const danglingPointers = pointerHeadings.filter((h) => !docHeadings.includes(h))
      expect(danglingPointers, `pointer(s) naming a §heading absent from the rationale doc: ${danglingPointers.join(' | ')}`).toHaveLength(0)

      // (b) every doc heading is referenced by at least one pointer
      const orphanHeadings = docHeadings.filter((h) => !pointerHeadings.includes(h))
      expect(orphanHeadings, `rationale-doc heading(s) with no pointer referencing them: ${orphanHeadings.join(' | ')}`).toHaveLength(0)

      // (d) no non-comment doc line is duplicated verbatim in the rule
      const ruleLines = new Set(ruleText.split('\n').filter((l) => l.trim()))
      const duplicated = docText
        .split('\n')
        .filter((l) => l.trim() && !l.trimStart().startsWith('#'))
        .filter((l) => ruleLines.has(l))
      expect(duplicated, `rationale-doc line(s) duplicated verbatim in the rule: ${duplicated.slice(0, 3).join(' | ')}`).toHaveLength(0)
    })
  }
})
