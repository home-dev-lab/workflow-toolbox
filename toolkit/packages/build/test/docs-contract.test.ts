// docs-contract.test.ts — mechanical doc↔impl alignment gate (Tier 1 of the
// doc-alignment defence).
//
// The skills are the operative behavior an authoring LLM "compiles", and the
// public docs are the consumers' contract — drift between them and the
// implementation produces wrongly-built workflows and wrong questions asked of
// users, silently. This gate extends the repo's byte-identity philosophy
// (artifact-identity, plugin-bundle-identity, golden scaffold) to the PROSE
// ANCHORS a doc can drift on without any compile error:
//
//   a. every inline-code identifier/path a doc surface mentions still exists
//      (catches renames, removals, post-split moves),
//   b. every value a doc quotes (caps, agentType names, pattern count) equals
//      the source constant — imported, not re-typed,
//   c. every public VALUE export of patterns/runtime/build is documented in at
//      least one authoring surface (types travel with their functions via TS),
//   d. the composer's raw templates pass the workflow linter.
//
// Remedy on failure: either the doc is stale (fix the doc) or the rename is
// real (update the doc AND, if the old name was public API, flag the breaking
// change). Only add to an allowlist below when the token is genuinely owned by
// an external system — each list states whose vocabulary it is.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LEAN_AGENT_TYPE, LEAF_AGENT_TYPE } from '@workflow-toolbox/patterns'
import { PATTERN_NAMES } from '@workflow-toolbox/scaffold'
import { MAX_STAGES, MAX_PIPELINE_DEPTH } from '@workflow-toolbox/pipeline-spec'
import { MAX_WORKFLOW_BYTES, lintWorkflowSource } from '../src/lint.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

// ---------------------------------------------------------------------------
// Doc surfaces under contract — the always-read authoring/consumer surfaces.
// ADRs are deliberately excluded: they are archives and receive "superseded by"
// annotations instead of edits.
// ---------------------------------------------------------------------------
const SURFACES = [
  'CLAUDE.md',
  'README.md',
  'toolkit/README.md',
  // Published npm packages' own README.md — their npm registry page, and under
  // contract like every other consumer-facing surface (card #1818564790587491673).
  ...['std', 'patterns', 'runtime', 'build', 'pipeline-spec', 'comm'].map(
    (pkg) => `toolkit/packages/${pkg}/README.md`,
  ),
  ...readdirSync(join(REPO_ROOT, 'docs/public'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/public/${f}`),
  ...readdirSync(join(REPO_ROOT, 'plugin/skills')).map((d) => `plugin/skills/${d}/SKILL.md`),
  ...readdirSync(join(REPO_ROOT, 'plugin/skills/workflow-composer/references')).map(
    (f) => `plugin/skills/workflow-composer/references/${f}`,
  ),
]

// ---------------------------------------------------------------------------
// Source corpus — where a doc-mentioned identifier must exist. Handwritten
// sources only; skill/reference .md files are NOT corpus (a doc must not
// satisfy its own contract), but plugin/agents/*.md are (agent definitions are
// source: their frontmatter IS the shipped configuration).
// ---------------------------------------------------------------------------
const CORPUS_ROOTS = [
  'toolkit/packages',
  'toolkit/bin',
  'toolkit/examples',
  'toolkit/pipelines',
  'toolkit/scripts',
  'plugin/agents',
  'plugin/bin',
  'plugin/hooks',
  'plugin/workflows',
  'plugin/.claude-plugin',
  'plugin/skills/workflow-composer/assets',
]

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else yield p
  }
}

function buildCorpus(): string {
  let corpus = ''
  for (const root of CORPUS_ROOTS) {
    const abs = join(REPO_ROOT, root)
    if (!existsSync(abs)) continue
    for (const f of walk(abs)) {
      if (/\.(ts|js|mjs|cjs|json|md|yml|yaml)$/.test(f)) corpus += readFileSync(f, 'utf8') + '\n'
    }
  }
  return corpus
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Inline backticked tokens only — fenced blocks are full snippets, covered by
 *  the template-lint check and the study-asset identity gates, not per-token. */
function inlineCodeTokens(md: string): string[] {
  const noFences = md.replace(/```[\s\S]*?```/g, '')
  return [...noFences.matchAll(/`([^`\n]+)`/g)].map((m) => (m[1] ?? '').trim())
}

// ---------------------------------------------------------------------------
// Allowlists — every entry names WHOSE vocabulary it is. Adding here must be
// rarer than fixing the doc; an entry for a toolkit-owned symbol is a bug.
// ---------------------------------------------------------------------------

/** Identifiers owned by external systems the docs legitimately describe:
 *  Claude Code hook fields, third-party product APIs. */
const EXTERNAL_VOCABULARY = new Set([
  'additionalContext', // Claude Code hook output field (architecture.md's Stop-hook note)
  'waitForApproval', // durable-execution product API cited as a comparison (P8 / HITL)
])

/** Identifiers owned by Workflow Observatory (the closed-source companion —
 *  split out of this repo): public docs may describe its behavior, but its
 *  symbols cannot exist in this corpus. */
const COMPANION_VOCABULARY = new Set([
  'spikeDir', // observatory per-source pipeline/gate state dir (known-issues #4)
  'OBSERVE_WORKFLOWS_DIR', // env var the observatory server reads; launcher only forwards it
])

/** Repo-relative path bases a doc may resolve from — its own dir, the repo
 *  root, and the conventional homes prose abbreviates from. */
const PATH_BASES = [
  '',
  'toolkit',
  'toolkit/packages',
  'plugin',
  'plugin/skills',
  'plugin/skills/workflow-composer',
]

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

describe('docs-contract — surfaces', () => {
  it('every contracted surface exists (a missing surface is a silent scope hole)', () => {
    const missing = SURFACES.filter((s) => !existsSync(join(REPO_ROOT, s)))
    expect(missing, `missing doc surfaces: ${missing.join(', ')}`).toEqual([])
    // Sanity floor: the contract covers the two READMEs + CLAUDE.md + public
    // docs + 6 skills + composer references. Falling under 15 means a whole
    // directory silently vanished from the glob, not a normal doc change.
    expect(SURFACES.length).toBeGreaterThanOrEqual(15)
  })
})

describe('docs-contract — inline identifiers resolve against the implementation', () => {
  const corpus = buildCorpus()
  const corpusHas = (token: string) => new RegExp(`\\b${escapeRe(token)}\\b`).test(corpus)

  const packageJsons = new Map<string, { exports?: Record<string, unknown> }>(
    readdirSync(join(REPO_ROOT, 'toolkit/packages')).map((d) => {
      const pj = JSON.parse(
        readFileSync(join(REPO_ROOT, 'toolkit/packages', d, 'package.json'), 'utf8'),
      ) as { name: string; exports?: Record<string, unknown> }
      return [pj.name, pj]
    }),
  )

  const pluginSlugs = new Set([
    ...readdirSync(join(REPO_ROOT, 'plugin/agents')).map((f) => f.replace(/\.md$/, '')),
    ...readdirSync(join(REPO_ROOT, 'plugin/skills')),
    ...readdirSync(join(REPO_ROOT, 'plugin/workflows')).map((f) => f.replace(/\.js$/, '')),
  ])

  // Placeholder-looking tokens are illustrative, not references.
  const PLACEHOLDER = /<[^>]+>|YOUR_|\bfoo\b|\bhello\b|\bx\.y\.z\b|\*/

  const failures: string[] = []

  for (const surface of SURFACES.filter((s) => existsSync(join(REPO_ROOT, s)))) {
    const md = readFileSync(join(REPO_ROOT, surface), 'utf8')
    for (const token of new Set(inlineCodeTokens(md))) {
      // 1. @workflow-toolbox package (+ optional exports subpath)
      let m = token.match(/^(@workflow-toolbox\/[\w-]+)((?:\/[\w-]+)*)$/)
      if (m) {
        const [, pkgName = '', subpath = ''] = m
        const pj = packageJsons.get(pkgName)
        if (!pj) failures.push(`${surface}: \`${token}\` — package does not exist in this repo`)
        else if (subpath && !(pj.exports && `.${subpath}` in pj.exports))
          failures.push(`${surface}: \`${token}\` — subpath .${subpath} not in ${pkgName} exports`)
        continue
      }
      // 2. workflow-toolbox:<slug> — plugin agents / skills / bundled workflows
      m = token.match(/^workflow-toolbox:([\w-]+)$/)
      if (m) {
        if (!pluginSlugs.has(m[1] ?? ''))
          failures.push(`${surface}: \`${token}\` — no such plugin agent/skill/workflow`)
        continue
      }
      // 3. SCREAMING_SNAKE constants / env vars
      if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(token)) {
        if (!corpusHas(token) && !EXTERNAL_VOCABULARY.has(token) && !COMPANION_VOCABULARY.has(token))
          failures.push(`${surface}: \`${token}\` — constant/env name not found in sources`)
        continue
      }
      // 4. bare camelCase identifiers (options, functions, fields)
      if (/^[a-z][a-zA-Z0-9]*$/.test(token) && /[A-Z]/.test(token)) {
        if (!corpusHas(token) && !EXTERNAL_VOCABULARY.has(token) && !COMPANION_VOCABULARY.has(token))
          failures.push(`${surface}: \`${token}\` — identifier not found in sources`)
        continue
      }
      // 5. call shapes — the called identifier must exist
      m = token.match(/^([a-z][a-zA-Z0-9]*)\(/)
      if (m) {
        const callee = m[1] ?? ''
        if (!corpusHas(callee) && !EXTERNAL_VOCABULARY.has(callee) && !COMPANION_VOCABULARY.has(callee))
          failures.push(`${surface}: \`${token}\` — called \`${callee}\` not found in sources`)
        continue
      }
      // 6. repo paths (must contain '/', no placeholder) — resolvable from a base
      if (/^[\w@./-]+\.(ts|js|mjs|md|json)$/.test(token) && token.includes('/') && !PLACEHOLDER.test(token)) {
        const resolvable = [...PATH_BASES, dirname(surface)].some((b) =>
          existsSync(join(REPO_ROOT, b, token)),
        )
        if (!resolvable) failures.push(`${surface}: \`${token}\` — path not found from any base`)
      }
    }
  }

  it('every doc-mentioned identifier, package, plugin slug, and path still exists', () => {
    expect(failures, `\n${failures.join('\n')}\n`).toEqual([])
  })
})

describe('docs-contract — value anchors (imported, never re-typed)', () => {
  const read = (s: string) => readFileSync(join(REPO_ROOT, s), 'utf8')
  const apiReference = read('plugin/skills/workflow-composer/references/api-reference.md')

  it('script-size cap: MAX_WORKFLOW_BYTES is 512 KB and the docs quote it', () => {
    expect(MAX_WORKFLOW_BYTES).toBe(512 * 1024)
    expect(apiReference).toMatch(/512 KB/)
    expect(apiReference).toMatch(/524\s?288/)
    expect(read('CLAUDE.md')).toMatch(/512 KB/)
  })

  it('harness caps quoted by api-reference match the pinned facts', () => {
    // These are HARNESS facts (the Workflow tool's own limits), not toolkit
    // constants — there is nothing to import, so they are pinned here and the
    // doc is held to the pin. Re-ground the pin against the tool description
    // before changing it.
    const HARNESS_LIMITS = { concurrentAgents: 16, lifetimeAgents: 1000, itemsPerCall: 4096 }
    const caps = apiReference.slice(apiReference.indexOf('## Caps and limits'))
    expect(caps).toMatch(new RegExp(`\\b${HARNESS_LIMITS.concurrentAgents}\\b`))
    expect(caps).toMatch(/\b1,?000\b/)
    expect(caps).toMatch(/\b4,?096\b/)
  })

  it('pipeline caps quoted by the pipelines reference match the source constants', () => {
    const pipelinesDoc = read('plugin/skills/workflow-composer/references/orchestrator-pipelines.md')
    expect(pipelinesDoc).toContain(`\`MAX_STAGES\` (${MAX_STAGES})`)
    expect(pipelinesDoc).toContain(`\`MAX_PIPELINE_DEPTH\` (${MAX_PIPELINE_DEPTH})`)
  })

  it('agentType constants match the shipped agent definitions and the routing doc', () => {
    for (const [constant, slug] of [
      [LEAN_AGENT_TYPE, 'lean'],
      [LEAF_AGENT_TYPE, 'leaf'],
    ] as const) {
      expect(constant).toBe(`workflow-toolbox:${slug}`)
      const frontmatter = read(`plugin/agents/${slug}.md`)
      expect(frontmatter).toMatch(new RegExp(`^name: ${slug}$`, 'm'))
    }
    const routing = read('plugin/skills/workflow-composer/references/model-and-agent-routing.md')
    expect(routing).toContain(LEAN_AGENT_TYPE)
    expect(routing).toContain(LEAF_AGENT_TYPE)
  })

  it('every "<N> patterns" claim across the surfaces matches PATTERN_NAMES.length', () => {
    const WORD_COUNTS: Record<string, number> = {
      seven: 7,
      eight: 8,
      nine: 9,
      ten: 10,
      eleven: 11,
    }
    const wrong: string[] = []
    for (const surface of SURFACES.filter((s) => existsSync(join(REPO_ROOT, s)))) {
      const md = read(surface)
      // [\s-]+ tolerates hyphenated forms ("all-seven-patterns fixture") — a
      // spelled count drifted unseen behind hyphens once (architecture.md).
      for (const m of md.matchAll(/\b(seven|eight|nine|ten|eleven|\d+)[\s-]+patterns\b/gi)) {
        const count = m[1] ?? ''
        const n = WORD_COUNTS[count.toLowerCase()] ?? Number(count)
        if (n === PATTERN_NAMES.length) continue
        // Subset claims ("the eight patterns that fan out") count a qualified
        // subset, not the full set — the "that"-clause exempts them.
        if (/^\s+that\b/.test(md.slice((m.index ?? 0) + m[0].length))) continue
        // Historical narrative (run logs, changelogs) states what was true at
        // the time; an explicit <!-- wt:historical --> marker on the same line
        // acknowledges the claim is dated, not stale.
        const lineStart = md.lastIndexOf('\n', m.index ?? 0) + 1
        const lineEnd = md.indexOf('\n', m.index ?? 0)
        const line = md.slice(lineStart, lineEnd === -1 ? md.length : lineEnd)
        if (line.includes('wt:historical')) continue
        wrong.push(`${surface}: "${m[0]}" (source has ${PATTERN_NAMES.length})`)
      }
    }
    expect(wrong, `\n${wrong.join('\n')}\n`).toEqual([])
  })

  it('every "<N> example compositions / shipped examples" claim matches the artifact count', () => {
    // Spelled-out counts are invisible to digit-anchor checks — this claim
    // class drifted THREE surfaces at once when the 22nd composition landed
    // ("thirteen" ×2 + "twenty-one"). Narrow lexicon: a count outside it
    // simply doesn't match (extend it when the fleet grows past it).
    const WORD_COUNTS: Record<string, number> = {
      thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
      eighteen: 18, nineteen: 19, twenty: 20, 'twenty-one': 21, 'twenty-two': 22,
      'twenty-three': 23, 'twenty-four': 24, 'twenty-five': 25,
    }
    const artifactCount = readdirSync(join(REPO_ROOT, 'toolkit/workflows'))
      .filter((f) => f.endsWith('.js')).length
    const wrong: string[] = []
    // The lexicon must cover the current fleet size, or spelled-out claims
    // silently stop matching — fail LOUD instead of going quiet at 26.
    const lexiconMax = Math.max(...Object.values(WORD_COUNTS))
    if (artifactCount > lexiconMax) {
      wrong.push(
        `WORD_COUNTS lexicon tops out at ${lexiconMax} but toolkit/workflows has ` +
        `${artifactCount} artifacts — extend the lexicon so spelled-out count claims stay checkable`,
      )
    }
    const NUM = Object.keys(WORD_COUNTS).join('|')
    // Full-set phrasings only: a qualified subset ("five core-pattern
    // compositions") has a non-matching word between the number and the noun.
    const CLAIM = new RegExp(
      `\\b(${NUM}|\\d+)\\s+(?:runnable\\s+|built\\s+|shipped\\s+)*(?:example\\s+)?compositions\\b` +
      `|\\b(${NUM}|\\d+)\\s+shipped examples\\b`,
      'gi',
    )
    for (const surface of SURFACES.filter((s) => existsSync(join(REPO_ROOT, s)))) {
      const md = read(surface)
      for (const m of md.matchAll(CLAIM)) {
        const count = m[1] ?? m[2] ?? ''
        const n = WORD_COUNTS[count.toLowerCase()] ?? Number(count)
        if (n === artifactCount) continue
        if (/^\s+that\b/.test(md.slice((m.index ?? 0) + m[0].length))) continue
        const lineStart = md.lastIndexOf('\n', m.index ?? 0) + 1
        const lineEnd = md.indexOf('\n', m.index ?? 0)
        const line = md.slice(lineStart, lineEnd === -1 ? md.length : lineEnd)
        if (line.includes('wt:historical')) continue
        wrong.push(`${surface}: "${m[0]}" (toolkit/workflows has ${artifactCount})`)
      }
    }
    expect(wrong, `\n${wrong.join('\n')}\n`).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Inverse (code → docs) checks. Everything above holds the DOCS to the code
// (a cited anchor must exist); the checks below hold the CODE to the docs —
// every public surface the code grows (exports, operator env vars, CLI verbs)
// must be documented somewhere or carry a REASONED exemption. Inventory
// semantics: each run re-enumerates the current surface, so there is no
// historical-debt class — a surface added years ago fails the same as one
// added today.
// ---------------------------------------------------------------------------

/** Doc corpus for the inverse checks: the concatenated contract surfaces. */
const docCorpus = SURFACES.filter((s) => existsSync(join(REPO_ROOT, s)))
  .map((s) => readFileSync(join(REPO_ROOT, s), 'utf8'))
  .join('\n')

describe('docs-contract — public exports are documented', () => {
  /** Value exports deliberately NOT documented in the authoring surfaces —
   *  each entry says why. An entry without a reason is a doc gap, not an
   *  exemption. */
  const DELIBERATELY_UNDOCUMENTED = new Map<string, string>([
    ['applyCap', 'pattern-internal envelope machinery, exported for composed patterns'],
    ['emitDigest', 'pattern-internal digest emission, exported for composed patterns'],
    ['DIGEST_PREFIX', 'digest wire protocol shared with Workflow Observatory'],
    ['LOOP_STAGE', 'loop-digest wire protocol shared with Workflow Observatory (its known-issues doc moved to that repo, 2026-07-13)'],
    ['LOOP_ITER_MARKER', 'loop-digest wire protocol shared with Workflow Observatory (same)'],
    ['isLoopIterLabel', 'loop-digest wire protocol shared with Workflow Observatory (same)'],
    ['formatDigest', 'digest wire protocol shared with Workflow Observatory'],
    ['parseDigest', 'digest wire protocol shared with Workflow Observatory'],
    ['PROMPT_TAG_PREFIX', 'prompt-tag wire protocol; the author surface is withPromptTags/parsePromptTag'],
    ['buildPromptTag', 'prompt-tag wire protocol; the author surface is withPromptTags/parsePromptTag'],
    ['normalizeArgs', 'bundler plumbing invoked by the emitted artifact, never by authors'],
    // debugger / scaffold are private packages: their library surface is
    // consumed by Workflow Observatory and the plugin CLIs through direct
    // imports, not by authors following a doc. Their AUTHOR-facing pieces
    // (parseJournal, diagnoseRun, scaffoldWorkflow, PATTERN_NAMES…) are
    // documented and NOT exempted — only the plumbing is.
    ['agentEvents', 'debugger journal plumbing consumed by Workflow Observatory imports (private package)'],
    ['formatDiagnosis', 'debugger CLI rendering plumbing (private package); the author surface is the wt-debug CLI itself'],
    ['buildAuditReport', 'debugger audit plumbing consumed by the Stop hook and Workflow Observatory (private package)'],
    ['formatAuditReportMarkdown', 'debugger audit rendering plumbing (private package, same consumers)'],
    ['assertSpecShape', 'scaffold CLI plumbing (private package); the author surface is the documented scaffoldWorkflow'],
    ['assertAgentSpecShape', 'scaffold CLI plumbing (private package); the author surface is the documented scaffoldAgent'],
    ['MINIMAL_TSCONFIG', 'scaffold CLI plumbing (private package): the tsconfig content the scaffolder writes'],
  ])

  // Shared exemption reasons for the type allowlist — a NEW public type export
  // either gets documented or lands below under one of these (or its own,
  // stated) reasons.
  const R_OPTIONS =
    'options parameter type of a same-named documented function; TS surfaces it at the call site'
  const R_ENVELOPE =
    "result-envelope member type; the authoring surface is the documented parent function's result fields"
  const R_SANDBOX =
    'sandbox global signature type; the documented surface is the global itself (agent/pipeline/parallel/…)'
  const R_WIRE =
    'wire-protocol type shared with Workflow Observatory (same family as the DIGEST_PREFIX value exemptions)'
  const R_RETURN = 'return type of a documented function; authors consume fields, never name the type'

  /** Exported TYPES deliberately not documented. The original check skipped
   *  types wholesale ("types travel with their functions"); that blanket is
   *  now a per-entry, reasoned exemption like every other allowlist here. */
  const TYPES_DELIBERATELY_UNDOCUMENTED = new Map<string, string>([
    // @workflow-toolbox/build
    ['LintResult', R_RETURN],
    ['BundleResult', R_RETURN],
    ['BundlePipelineResult', R_RETURN],
    // @workflow-toolbox/patterns — pattern option bags
    ['ClassifyAndActOptions', R_OPTIONS],
    ['GenerateAndFilterOptions', R_OPTIONS],
    ['FanOutAndSynthesizeOptions', R_OPTIONS],
    ['AdversarialVerificationOptions', R_OPTIONS],
    ['TournamentOptions', R_OPTIONS],
    ['LoopUntilDoneOptions', R_OPTIONS],
    ['PlanAndExecuteOptions', R_OPTIONS],
    ['ScoreAndRankOptions', R_OPTIONS],
    ['ChunkedAnalysisOptions', R_OPTIONS],
    ['ChunkingOptions', R_OPTIONS],
    ['WithLeafFenceOptions', R_OPTIONS],
    ['WithLeanRoutingOptions', R_OPTIONS],
    ['ProbeAgentTypeOptions', R_OPTIONS],
    // @workflow-toolbox/patterns — result-envelope members
    ['PatternStats', R_ENVELOPE],
    ['AgentTypeProbe', R_ENVELOPE],
    ['AgentTypeProbeReport', R_ENVELOPE],
    ['LeafFenceReport', R_ENVELOPE],
    ['LeanRoutingReport', R_ENVELOPE],
    ['VerifierVote', R_ENVELOPE],
    ['VerifiedClaim', R_ENVELOPE],
    ['Verdict', R_ENVELOPE],
    ['RankedAttempt', R_ENVELOPE],
    ['LoopStopConditions', R_OPTIONS],
    ['LoopTick', R_ENVELOPE],
    ['LoopOutcome', R_ENVELOPE],
    ['LoopStoppedBy', R_ENVELOPE],
    ['PlannedSubtask', R_ENVELOPE],
    ['ScoreDimension', R_OPTIONS],
    ['ScoreCutoff', R_OPTIONS],
    ['ScoredItem', R_ENVELOPE],
    ['ChunkedAnalysisResult', R_RETURN],
    // @workflow-toolbox/runtime
    ['AgentFn', R_SANDBOX],
    ['PipelineStage', R_SANDBOX],
    ['PipelineFn', R_SANDBOX],
    ['ParallelFn', R_SANDBOX],
    ['WorkflowFn', R_SANDBOX],
    ['PhaseDigest', R_WIRE],
    ['TypedPhaseDigest', R_WIRE],
    ['PatternCounts', R_WIRE],
    ['PromptTagFields', R_WIRE],
    ['FakeRuntimeOptions', R_OPTIONS],
    ['AgentDefaults', R_OPTIONS],
    ['AgentCall', 'FakeRuntime introspection record; the test-authoring surface is the documented FakeRuntime itself'],
    ['PatternName', 'the pattern names are the documented vocabulary (patterns.md); the union type is TS plumbing'],
  ])

  // Every package with a src/index.ts barrel is under contract — published
  // and private alike (private surfaces are consumed by the plugin skills and
  // this repo's own docs). smoke ships subpath-only entries (no barrel): its
  // two entry points are upgrade-canary plumbing, deliberately out of contract.
  const PACKAGES = readdirSync(join(REPO_ROOT, 'toolkit/packages'))
    .filter((d) => existsSync(join(REPO_ROOT, 'toolkit/packages', d, 'src/index.ts')))
    .sort()

  /** Collect exported names from a barrel, following `export * from` ONE
   *  level (std and pipeline-spec are star-barrels over declaration files). */
  function collectExports(file: string, depth = 0): { values: Set<string>; types: Set<string> } {
    const src = readFileSync(file, 'utf8')
    const values = new Set<string>()
    const types = new Set<string>()
    for (const m of src.matchAll(/export\s+(type\s+)?\{([^}]+)\}/g)) {
      for (const part of (m[2] ?? '').split(',')) {
        const trimmed = part.trim()
        if (trimmed === '') continue
        const isType = m[1] !== undefined || trimmed.startsWith('type ')
        const alias = trimmed.replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim() ?? ''
        if (alias !== '') (isType ? types : values).add(alias)
      }
    }
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g))
      values.add(m[1] ?? '')
    for (const m of src.matchAll(/export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)/g)) types.add(m[1] ?? '')
    if (depth === 0) {
      for (const m of src.matchAll(/export\s*\*\s*from\s*'([^']+)'/g)) {
        const target = join(dirname(file), (m[1] ?? '').replace(/\.js$/, '.ts'))
        if (!existsSync(target)) continue
        const nested = collectExports(target, 1)
        for (const v of nested.values) values.add(v)
        for (const t of nested.types) types.add(t)
      }
    } else if (/export\s*\*\s*from/.test(src)) {
      // A star-barrel pointing at another star-barrel would silently drop the
      // second level's exports from the contract — fail loud instead (extend
      // the collector when a real two-level barrel appears).
      throw new Error(`${file}: nested \`export * from\` beyond one level — extend collectExports`)
    }
    return { values, types }
  }

  // Union across packages — the allowlist-hygiene checks below need it.
  const allValues = new Set<string>()
  const allTypes = new Set<string>()

  for (const pkg of PACKAGES) {
    const barrel = join(REPO_ROOT, 'toolkit/packages', pkg, 'src/index.ts')
    const { values, types } = collectExports(barrel)
    for (const v of values) allValues.add(v)
    for (const t of types) allTypes.add(t)

    it(`every @workflow-toolbox/${pkg} value export appears in a doc surface`, () => {
      expect(values.size, `${pkg}/src/index.ts yielded no value exports — collector anchor moved?`).toBeGreaterThan(0)
      const missing = [...values].filter(
        (n) => !DELIBERATELY_UNDOCUMENTED.has(n) && !new RegExp(`\\b${n}\\b`).test(docCorpus),
      )
      expect(missing, `undocumented ${pkg} exports: ${missing.join(', ')}`).toEqual([])
    })

    // Private packages are exempt from TYPE coverage by rule: not installable,
    // their types are consumed through direct TS imports (this repo + the
    // Observatory), never by an author following a doc. Their VALUE exports
    // stay under contract above — a new private function still forces the
    // "document or exempt?" question.
    const isPrivate =
      (JSON.parse(readFileSync(join(REPO_ROOT, 'toolkit/packages', pkg, 'package.json'), 'utf8')) as {
        private?: boolean
      }).private === true

    it.skipIf(isPrivate)(`every @workflow-toolbox/${pkg} type export appears in a doc surface`, () => {
      // A package may legitimately export no types from its barrel — the
      // value-export check above already guards against a silent parse miss.
      const missing = [...types].filter(
        (n) => !TYPES_DELIBERATELY_UNDOCUMENTED.has(n) && !new RegExp(`\\b${n}\\b`).test(docCorpus),
      )
      expect(missing, `undocumented ${pkg} type exports: ${missing.join(', ')}`).toEqual([])
    })
  }

  // Allowlist hygiene (review finding, run wf_c58c5b18-d8b): an exemption whose
  // export was since renamed/removed is a dead entry that silently misstates
  // the contract — each key must still name a real export.
  it('every DELIBERATELY_UNDOCUMENTED entry still names a real value export', () => {
    const dead = [...DELIBERATELY_UNDOCUMENTED.keys()].filter((k) => !allValues.has(k))
    expect(dead, `stale value exemptions (export gone?): ${dead.join(', ')}`).toEqual([])
  })

  it('every TYPES_DELIBERATELY_UNDOCUMENTED entry still names a real type export', () => {
    const dead = [...TYPES_DELIBERATELY_UNDOCUMENTED.keys()].filter((k) => !allTypes.has(k))
    expect(dead, `stale type exemptions (type gone?): ${dead.join(', ')}`).toEqual([])
  })
})

describe('docs-contract — operator env vars are documented', () => {
  /** Env reads that are deliberately NOT documented — each entry says why. */
  const ENV_DELIBERATELY_UNDOCUMENTED = new Map<string, string>([
    ['OBSERVE_LAUNCH_PLUGIN_DIRS', 'launcher→server plumbing: set BY wt-observe for the delegated session, never by an operator'],
    ['CANARY_CAPTURE', 'upgrade-canary fixture-capture knob — repo-dev tooling, not operator surface'],
    ['SDK_PROBE_SENTINEL_DIR', 'smoke-battery probe plumbing, set by the battery itself'],
  ])

  /** Platform/harness-ambient vocabulary — someone else's surface, not ours. */
  const AMBIENT_ENV = new Set([
    'PATH', 'HOME', 'NODE_ENV', 'CI', 'TMPDIR', 'TEMP', 'TMP', 'SHELL', 'TERM',
    'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE',
  ])

  // Shipped sources only: package src trees, the toolkit bin entries, and the
  // plugin hooks. toolkit/scripts (repo-dev tooling) and test files are not
  // operator surface; plugin/bin and plugin/workflows are bundled artifacts of
  // the same package sources (counting them would double-report).
  const ENV_SOURCE_ROOTS = ['toolkit/packages', 'toolkit/bin', 'plugin/hooks']

  const reads = new Map<string, string>()
  for (const root of ENV_SOURCE_ROOTS) {
    const abs = join(REPO_ROOT, root)
    if (!existsSync(abs)) continue
    for (const f of walk(abs)) {
      if (!/\.(ts|mjs|cjs)$/.test(f) || /\.test\.ts$/.test(f) || /[/\\]test[/\\]/.test(f)) continue
      const text = readFileSync(f, 'utf8')
      // Direct reads plus SCREAMING_SNAKE reads through a passed-around env
      // object (the debugger's xdgOverride(env, …) style).
      for (const m of text.matchAll(
        /process\.env(?:\.([A-Za-z_]\w*)|\[['"]([A-Za-z_]\w*)['"]\])|\benv\[['"]([A-Z][A-Z0-9_]+)['"]\]/g,
      )) {
        const name = m[1] ?? m[2] ?? m[3] ?? ''
        if (name !== '' && !reads.has(name)) reads.set(name, f.slice(REPO_ROOT.length))
      }
    }
  }

  it('every env var the shipped sources read is documented or exempted', () => {
    expect(reads.size, 'no env reads found — enumeration anchor moved?').toBeGreaterThan(0)
    const missing = [...reads.entries()].filter(
      ([n]) =>
        !AMBIENT_ENV.has(n) && !ENV_DELIBERATELY_UNDOCUMENTED.has(n) &&
        !new RegExp(`\\b${escapeRe(n)}\\b`).test(docCorpus),
    )
    expect(
      missing.map(([n, f]) => `${n} (read in ${f})`),
      '\nundocumented operator env vars — document or exempt with a reason\n',
    ).toEqual([])
  })

  it('every ENV_DELIBERATELY_UNDOCUMENTED entry still names a real env read', () => {
    const dead = [...ENV_DELIBERATELY_UNDOCUMENTED.keys()].filter((k) => !reads.has(k))
    expect(dead, `stale env exemptions (read gone?): ${dead.join(', ')}`).toEqual([])
  })
})

describe('docs-contract — wt-observe CLI verbs are documented', () => {
  // plugin/bin/wt-observe.mjs is a bundled ARTIFACT; the dispatch source of
  // truth is the debugger package's observe-cli.ts main() (`cmd === '<verb>'`)
  // plus parseConfigAction's action literals in observe-lifecycle.ts.
  const cliSrc = readFileSync(join(REPO_ROOT, 'toolkit/packages/debugger/src/observe-cli.ts'), 'utf8')

  it('every dispatched verb appears in a doc surface as `wt-observe <verb>`', () => {
    const mainStart = cliSrc.indexOf('export async function main')
    expect(mainStart, 'observe-cli.ts main() anchor moved — update this check').toBeGreaterThanOrEqual(0)
    const verbs = new Set(['status']) // `argv[0] ?? 'status'` — the no-verb default
    for (const m of cliSrc.slice(mainStart).matchAll(/\bcmd === '([a-z-]+)'/g)) verbs.add(m[1] ?? '')
    expect(verbs.size, 'verb dispatch anchor moved — update this check').toBeGreaterThanOrEqual(7)
    const missing = [...verbs].filter(
      (v) => !new RegExp(`wt-observe(?:\\.mjs)?[ \`]+${v}\\b`).test(docCorpus),
    )
    expect(missing, `\nCLI verbs no doc surface shows: ${missing.join(', ')}\n`).toEqual([])
  })

  it('every config sub-action appears in a doc surface', () => {
    const lifecycle = readFileSync(
      join(REPO_ROOT, 'toolkit/packages/debugger/src/observe-lifecycle.ts'),
      'utf8',
    )
    const fnStart = lifecycle.indexOf('function parseConfigAction')
    expect(fnStart, 'parseConfigAction anchor moved — update this check').toBeGreaterThanOrEqual(0)
    const fnEnd = lifecycle.indexOf('\nexport function', fnStart + 1)
    const body = lifecycle.slice(fnStart, fnEnd === -1 ? undefined : fnEnd)
    // Sub-actions appear as `sub === '<action>'` comparisons (add-source and
    // remove-source are constructed dynamically as `action: sub`, so matching
    // on action literals under-enumerates).
    const actions = new Set([...body.matchAll(/\bsub === '([a-z-]+)'/g)].map((m) => m[1] ?? ''))
    expect(actions.size, 'config sub-action anchor moved — update this check').toBeGreaterThanOrEqual(4)
    const missing = [...actions].filter((a) => !new RegExp(`config\\s+${a}\\b`).test(docCorpus))
    expect(missing, `\nconfig sub-actions no doc surface shows: ${missing.join(', ')}\n`).toEqual([])
  })

  // Inverse of the two checks above (review finding, run wf_c58c5b18-d8b): the
  // verb names are anchored, but a doc could cite a --flag the CLI never had.
  // Every --flag a doc line mentions next to wt-observe must exist in the
  // dispatch sources (observe-cli.ts literals / flagValue names, or the
  // add-remote flag map in observe-lifecycle.ts).
  it('every --flag the docs cite on a wt-observe line exists in the CLI source', () => {
    const lifecycleSrc = readFileSync(
      join(REPO_ROOT, 'toolkit/packages/debugger/src/observe-lifecycle.ts'),
      'utf8',
    )
    const cliCorpus = cliSrc + lifecycleSrc
    const cited = new Set<string>()
    for (const surface of SURFACES.filter((s) => existsSync(join(REPO_ROOT, s)))) {
      for (const line of readFileSync(join(REPO_ROOT, surface), 'utf8').split('\n')) {
        if (!line.includes('wt-observe')) continue
        for (const m of line.matchAll(/--([a-z][a-z0-9-]*)/g)) cited.add(m[1] ?? '')
      }
    }
    const missing = [...cited].filter(
      (f) => !cliCorpus.includes(`'--${f}'`) && !cliCorpus.includes(`'${f}'`),
    )
    expect(missing, `\ndoc-cited wt-observe flags absent from the CLI source: ${missing.join(', ')}\n`).toEqual([])
  })
})

describe('docs-contract — composer templates lint clean', () => {
  const templatesDir = join(REPO_ROOT, 'plugin/skills/workflow-composer/assets/templates')
  const templates = readdirSync(templatesDir).filter((f) => f.endsWith('.template.js'))

  it('the template set is non-empty', () => {
    expect(templates.length).toBeGreaterThan(0)
  })

  for (const t of templates) {
    it(`${t} passes the workflow linter`, () => {
      const result = lintWorkflowSource(readFileSync(join(templatesDir, t), 'utf8'))
      expect(result.errors, result.errors.join('\n')).toEqual([])
    })
  }
})
