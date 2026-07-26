// embedded-copy-sync.test.ts — byte-identity gate over marker-delimited embedded copies
// anywhere under plugin/.
//
// A delegated (Path B / server-launched) agent runs with settingSources: [] — no ambient
// rules reach it. Only its OWN agent definition does. So any rule clause a delegated agent
// must actually follow has to be duplicated INTO the agent definition — which means the
// clause now exists in two places and can drift in silence: the rule file gets amended,
// gated, committed, and the embedded copy is never touched. Nothing short of a mechanical
// comparison catches that, because the amendment itself is correct at its own location.
//
// The fix is not "write more carefully" — it's "make the duplication explicit and
// comparable". Any block wrapped in matching
//   <!-- embedded-copy:<id>:start -->  …  <!-- embedded-copy:<id>:end -->
// markers under plugin/rules/ is CANONICAL for that <id>. Any block under the SAME markers
// anywhere else under plugin/ is an EMBEDDED COPY and must be byte-identical to the
// canonical block. This is an INVARIANT over the marker convention itself, not a hardcoded
// list of known copies: a future 4th embedded copy (or a second synced clause, under a new
// <id>) is picked up automatically by grep, with no edit to this file — only a copy that
// skips the marker convention entirely escapes detection, which is the honest, stated limit
// of a textual gate.
//
// Remedy on failure: edit the canonical block in plugin/rules/<file>.md, then copy the
// exact text (between the same markers) into every FAILING embedded copy this test names.
// Never edit an embedded copy's wording independently of its canonical source.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PLUGIN_ROOT = join(REPO_ROOT, 'plugin')
const RULES_DIR = join(PLUGIN_ROOT, 'rules')

const MARKER_RE = /<!--\s*embedded-copy:([\w.-]+):start\s*-->\n([\s\S]*?)<!--\s*embedded-copy:\1:end\s*-->/g

interface Block {
  file: string // repo-relative path
  id: string
  body: string
}

// Scoped to .md files, well-formed markers only (start immediately followed by a
// newline, matching \1 end). Every embedded copy in this plugin today is an agent/rule
// definition (.md); a marker in a non-.md file, or one malformed enough that the regex
// doesn't match, is NOT discovered — an accepted, stated limit of a textual gate, not a
// silent one: this comment is that statement. Widen `walkMd`'s extension filter if a
// synced clause is ever ported into a non-.md shipped surface.
function* walkMd(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walkMd(p)
    else if (e.name.endsWith('.md')) yield p
  }
}

function extractBlocks(dir: string): Block[] {
  const blocks: Block[] = []
  for (const abs of walkMd(dir)) {
    const text = readFileSync(abs, 'utf8')
    for (const m of text.matchAll(MARKER_RE)) {
      blocks.push({ file: relative(REPO_ROOT, abs), id: m[1] ?? '', body: m[2] ?? '' })
    }
  }
  return blocks
}

describe('embedded-copy-sync — marker-delimited duplicates stay identical to their source', () => {
  const canonicalBlocks = extractBlocks(RULES_DIR)
  const allBlocks = extractBlocks(PLUGIN_ROOT)
  // `walkMd(PLUGIN_ROOT)` yields ABSOLUTE paths, so `b.file` (repo-relative) is always
  // prefixed `plugin/rules/…` for a canonical block — never bare `rules/…`. Compute the
  // exclusion prefix from RULES_DIR itself (not a re-typed literal) so this stays correct
  // if the rules directory ever moves.
  const RULES_PREFIX = `${relative(REPO_ROOT, RULES_DIR)}/`
  const embeddedBlocks = allBlocks.filter((b) => !b.file.startsWith(RULES_PREFIX))

  it('has at least one canonical block declared under plugin/rules/ (sanity floor)', () => {
    // If this drops to zero, either the ladder's markers were deleted from the rule file
    // (the whole gate would otherwise silently pass on nothing) or the convention moved —
    // either way this must fail loudly, not go green on an empty set.
    expect(canonicalBlocks.length).toBeGreaterThanOrEqual(1)
  })

  it('never counts a canonical file as its own embedded copy', () => {
    // Regression lock: a wrong exclusion prefix (e.g. bare 'rules/' against a
    // 'plugin/rules/…'-relative path) lets the canonical file self-compare — always
    // trivially "identical" — which both pollutes the floor count below and hides a real
    // scenario where every genuine embedded copy was deleted but the gate still reports
    // >=2 "embedded" blocks (the canonical file's own N marker ids, if it ever had more
    // than one). Fails before the RULES_PREFIX fix, passes after.
    const leaked = embeddedBlocks.filter((b) => canonicalBlocks.some((c) => c.file === b.file))
    expect(leaked, `canonical file(s) leaked into embeddedBlocks: ${JSON.stringify(leaked.map((b) => b.file))}`).toEqual([])
  })

  it('has no duplicate canonical id (exactly one source of truth per marker id)', () => {
    const counts = new Map<string, number>()
    for (const b of canonicalBlocks) counts.set(b.id, (counts.get(b.id) ?? 0) + 1)
    const dupes = [...counts.entries()].filter(([, n]) => n > 1)
    expect(dupes, `ids with >1 canonical source: ${JSON.stringify(dupes)}`).toEqual([])
  })

  it('finds at least two embedded copies to actually check (a floor, not a fixed list)', () => {
    // Not "these 3/4 named files" — just "the convention is in active use". A future copy
    // (or a future synced clause) raises this count with zero edits to this test; a count
    // stuck at the current floor after the file that carried them was deleted is the signal
    // this check exists to catch.
    expect(embeddedBlocks.length).toBeGreaterThanOrEqual(2)
  })

  it('every embedded copy is byte-identical to its canonical source', () => {
    const canonicalById = new Map(canonicalBlocks.map((b) => [b.id, b]))
    const failures: string[] = []

    for (const embedded of embeddedBlocks) {
      const canonical = canonicalById.get(embedded.id)
      if (!canonical) {
        failures.push(
          `${embedded.file}: marker id "${embedded.id}" has no canonical source under plugin/rules/ — ` +
            `either the source was renamed/removed, or this copy uses an id that was never declared`,
        )
        continue
      }
      if (embedded.body !== canonical.body) {
        failures.push(
          `${embedded.file}: DRIFT on "${embedded.id}" — content differs from the canonical block in ` +
            `${canonical.file}. Copy the canonical block verbatim (between the same markers) into this file.`,
        )
      }
    }

    expect(failures, `\n${failures.join('\n')}\n`).toEqual([])
  })
})
