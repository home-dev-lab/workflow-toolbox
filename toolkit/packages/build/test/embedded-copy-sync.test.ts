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
// list of known copies: a future additional embedded copy (or a second synced clause, under a new
// <id>) is picked up automatically by grep, with no edit to this file — only a copy that
// skips the marker convention entirely escapes detection, which is the honest, stated limit
// of a textual gate.
//
// Remedy on failure: edit the canonical block in plugin/rules/<file>.md, then copy the
// exact text (between the same markers) into every FAILING embedded copy this test names.
// Never edit an embedded copy's wording independently of its canonical source.

import { describe, it, expect } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const ACTIVE_ROOT = process.env.EMBEDDED_COPY_SYNC_ROOT ?? REPO_ROOT
const PLUGIN_ROOT = join(REPO_ROOT, 'plugin')

const MARKER_RE = /<!--\s*embedded-copy:([\w.-]+):start\s*-->\n([\s\S]*?)<!--\s*embedded-copy:\1:end\s*-->/g

interface Block {
  file: string // repo-relative path
  id: string
  body: string
}

interface ClauseRequirement {
  id: string
  description: string
  pattern: RegExp
}

// ⚠ THE LIMIT OF THIS LIST, stated because it is the one a reader will over-credit.
// This is a DECLARED set, and a declared set protects exactly what it declares: a clause
// that is not listed here can be deleted from the canonical block and every copy without
// this gate noticing. Its green means "the declared clauses survive", never "the block is
// intact".
//
// That is deliberate rather than a shortcut. A deletion is a change in the SET, so only
// something holding the expected set can see it — no invariant over the text can. The cost
// is that the list must be extended by hand when a new load-bearing clause appears, and
// nothing here can remind you: an undeclared clause is simply unguarded, silently.
//
// So the honest reading of a pass is narrow, and widening it is a human act.
const REQUIRED_CLAUSES: Record<string, ClauseRequirement[]> = {
  'proportionate-verification-ladder': [
    {
      id: 'unconditional-gates',
      description: 'every rung still says the gates and diff-read are unconditional',
      pattern: /Gates\s+\(test\/typecheck\/lint by exit code\) and your own diff-read are unconditional at every rung/i,
    },
    {
      id: 'mutation-red-proof',
      description: 'method diversity still requires proving each fix red in isolation',
      pattern: /every fix is proven RED\s+in isolation before it is accepted as green/i,
    },
    {
      id: 'axis-disclosure',
      description: 'the report still has to say which axes it actually varied',
      pattern: /An unstated axis reads as an axis covered\./i,
    },
    {
      id: 'parallel-isolation',
      description: 'independence still cannot be spent on inter-agent debate',
      pattern: /Verdicts are collected in PARALLEL and in ISOLATION\./i,
    },
    {
      id: 'breadth-axis',
      description: 'breadth still remains an independent verification axis',
      pattern: /Depth and breadth are independent: assess both, and neither substitutes for the other\./i,
    },
  ],
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

function extractBlocks(root: string, dir: string): Block[] {
  const blocks: Block[] = []
  for (const abs of walkMd(dir)) {
    const text = readFileSync(abs, 'utf8')
    for (const m of text.matchAll(MARKER_RE)) {
      blocks.push({ file: relative(root, abs), id: m[1] ?? '', body: m[2] ?? '' })
    }
  }
  return blocks
}

function inspectEmbeddedCopies(root: string) {
  const pluginRoot = join(root, 'plugin')
  const rulesDir = join(pluginRoot, 'rules')
  const canonicalBlocks = extractBlocks(root, rulesDir)
  const allBlocks = extractBlocks(root, pluginRoot)
  const rulesPrefix = `${relative(root, rulesDir)}/`
  const embeddedBlocks = allBlocks.filter((b) => !b.file.startsWith(rulesPrefix))
  const failures: string[] = []

  if (canonicalBlocks.length < 1) {
    failures.push(
      'plugin/rules/: expected at least one canonical embedded-copy block under plugin/rules/; the marker convention moved or the canonical block was deleted.',
    )
  }

  const leaked = embeddedBlocks.filter((b) => canonicalBlocks.some((c) => c.file === b.file))
  if (leaked.length > 0) {
    failures.push(`canonical file(s) leaked into embeddedBlocks: ${JSON.stringify(leaked.map((b) => b.file))}`)
  }

  const counts = new Map<string, number>()
  for (const b of canonicalBlocks) counts.set(b.id, (counts.get(b.id) ?? 0) + 1)
  const dupes = [...counts.entries()].filter(([, n]) => n > 1)
  if (dupes.length > 0) {
    failures.push(`ids with >1 canonical source: ${JSON.stringify(dupes)}`)
  }

  if (embeddedBlocks.length < 1) {
    failures.push(
      'plugin/: expected at least one marked embedded copy outside plugin/rules/; otherwise this gate would go green on canonical text alone.',
    )
  }

  for (const canonical of canonicalBlocks) {
    for (const clause of REQUIRED_CLAUSES[canonical.id] ?? []) {
      if (!clause.pattern.test(canonical.body)) {
        failures.push(
          `${canonical.file}: canonical "${canonical.id}" is missing required clause "${clause.id}" (${clause.description}). ` +
            'If this deletion is intentional, update REQUIRED_CLAUSES in toolkit/packages/build/test/embedded-copy-sync.test.ts.',
        )
      }
    }
  }

  const canonicalById = new Map(canonicalBlocks.map((b) => [b.id, b]))
  for (const embedded of embeddedBlocks) {
    const canonical = canonicalById.get(embedded.id)
    if (!canonical) {
      failures.push(
        `${embedded.file}: marker id "${embedded.id}" has no canonical source under plugin/rules/ — ` +
          'either the source was renamed/removed, or this copy uses an id that was never declared',
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

  return { canonicalBlocks, embeddedBlocks, failures }
}

function expectClean(root: string) {
  const { failures } = inspectEmbeddedCopies(root)
  expect(failures, `\n${failures.join('\n')}\n`).toEqual([])
}

function withTempPluginFixture(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'embedded-copy-sync-'))
  cpSync(PLUGIN_ROOT, join(root, 'plugin'), { recursive: true })
  try {
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('embedded-copy-sync — marker-delimited duplicates stay identical to their source', () => {
  const { canonicalBlocks, embeddedBlocks, failures } = inspectEmbeddedCopies(ACTIVE_ROOT)
  // `walkMd(PLUGIN_ROOT)` yields ABSOLUTE paths, so `b.file` (repo-relative) is always
  // prefixed `plugin/rules/…` for a canonical block — never bare `rules/…`. Compute the
  // exclusion prefix from RULES_DIR itself (not a re-typed literal) so this stays correct
  // if the rules directory ever moves.

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
    // nonzero "embedded" blocks (the canonical file's own N marker ids, if it ever had more
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

  it('finds at least one embedded copy to actually check (sanity floor only, not copy-set proof)', () => {
    // This floor does ONE thing only: stop a vacuous green when no embedded copies remain.
    // It does NOT prove the full carrier set still exists; whole-file copy loss is out of
    // reach for a marker-only sweep unless some other declaration names the expected files.
    // That limit is deliberate and stated here so a green run is not over-credited.
    expect(embeddedBlocks.length).toBeGreaterThanOrEqual(1)
  })

  it('the canonical block still contains the declared load-bearing clauses', () => {
    const clauseFailures = failures.filter((failure) => failure.includes('missing required clause'))
    expect(clauseFailures, `\n${clauseFailures.join('\n')}\n`).toEqual([])
  })

  it('every embedded copy is byte-identical to its canonical source', () => {
    const copyFailures = failures.filter((failure) => !failure.includes('missing required clause'))
    expect(copyFailures, `\n${copyFailures.join('\n')}\n`).toEqual([])
  })

  it('fails if a declared clause is deleted from the canonical block and every copy', () => {
    withTempPluginFixture((root) => {
      const files = inspectEmbeddedCopies(root).canonicalBlocks.concat(inspectEmbeddedCopies(root).embeddedBlocks)
      for (const block of files) {
        const abs = join(root, block.file)
        const text = readFileSync(abs, 'utf8').replace('An unstated axis reads as an axis covered.\n', '')
        writeFileSync(abs, text)
      }

      const { failures } = inspectEmbeddedCopies(root)
      expect(failures).toContain(
        'plugin/rules/wt-proportionate-verification.md: canonical "proportionate-verification-ladder" is missing required clause "axis-disclosure" (the report still has to say which axes it actually varied). If this deletion is intentional, update REQUIRED_CLAUSES in toolkit/packages/build/test/embedded-copy-sync.test.ts.',
      )
    })
  })

  it('passes a legitimate propagated edit with no extra flag', () => {
    withTempPluginFixture((root) => {
      const files = inspectEmbeddedCopies(root).canonicalBlocks.concat(inspectEmbeddedCopies(root).embeddedBlocks)
      for (const block of files) {
        const abs = join(root, block.file)
        const text = readFileSync(abs, 'utf8').replace(
          'buying the expensive bottom.',
          'buying the expensive bottom first.',
        )
        writeFileSync(abs, text)
      }

      expectClean(root)
    })
  })

  it('picks up a newly added marked mirror automatically', () => {
    withTempPluginFixture((root) => {
      const canonical = inspectEmbeddedCopies(root).canonicalBlocks.find((b) => b.id === 'proportionate-verification-ladder')
      expect(canonical).toBeTruthy()
      const extraCopy = join(root, 'plugin/skills/embedded-copy-sync-fixture.md')
      writeFileSync(
        extraCopy,
        `<!-- cite: plugin/rules/wt-proportionate-verification.md#proportionate-verification-ladder sha256:test-fixture -->\n` +
          `<!-- embedded-copy:proportionate-verification-ladder:start -->\n${canonical!.body}<!-- embedded-copy:proportionate-verification-ladder:end -->\n`,
      )

      const inspected = inspectEmbeddedCopies(root)
      expectClean(root)
      expect(inspected.embeddedBlocks.map((b) => b.file)).toContain('plugin/skills/embedded-copy-sync-fixture.md')
    })
  })
})
