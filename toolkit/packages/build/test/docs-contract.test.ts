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
      for (const m of md.matchAll(/\b(seven|eight|nine|ten|eleven|\d+)\s+patterns\b/gi)) {
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
    const NUM = Object.keys(WORD_COUNTS).join('|')
    // Full-set phrasings only: a qualified subset ("five core-pattern
    // compositions") has a non-matching word between the number and the noun.
    const CLAIM = new RegExp(
      `\\b(${NUM}|\\d+)\\s+(?:runnable\\s+|built\\s+|shipped\\s+)*(?:example\\s+)?compositions\\b` +
      `|\\b(${NUM}|\\d+)\\s+shipped examples\\b`,
      'gi',
    )
    const wrong: string[] = []
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

describe('docs-contract — public value exports are documented', () => {
  /** Exports deliberately NOT documented in the authoring surfaces — each
   *  entry says why. An entry without a reason is a doc gap, not an exemption. */
  const DELIBERATELY_UNDOCUMENTED = new Map<string, string>([
    ['applyCap', 'pattern-internal envelope machinery, exported for composed patterns'],
    ['emitDigest', 'pattern-internal digest emission, exported for composed patterns'],
    ['DIGEST_PREFIX', 'digest wire protocol shared with Workflow Observatory'],
    ['formatDigest', 'digest wire protocol shared with Workflow Observatory'],
    ['parseDigest', 'digest wire protocol shared with Workflow Observatory'],
    ['PROMPT_TAG_PREFIX', 'prompt-tag wire protocol; the author surface is withPromptTags/parsePromptTag'],
    ['buildPromptTag', 'prompt-tag wire protocol; the author surface is withPromptTags/parsePromptTag'],
    ['normalizeArgs', 'bundler plumbing invoked by the emitted artifact, never by authors'],
  ])

  const docCorpus = SURFACES.filter((s) => existsSync(join(REPO_ROOT, s)))
    .map((s) => readFileSync(join(REPO_ROOT, s), 'utf8'))
    .join('\n')

  for (const pkg of ['patterns', 'runtime', 'build']) {
    it(`every @workflow-toolbox/${pkg} value export appears in a doc surface`, () => {
      const idx = readFileSync(join(REPO_ROOT, 'toolkit/packages', pkg, 'src/index.ts'), 'utf8')
      const values = new Set<string>()
      for (const m of idx.matchAll(/export\s*\{([^}]+)\}/g)) {
        if (/^export\s+type\s*\{/.test(m[0])) continue
        for (const part of (m[1] ?? '').split(',')) {
          const n = part.trim().split(/\s+as\s+/).pop()?.trim()
          if (n && !n.startsWith('type ')) values.add(n)
        }
      }
      expect(values.size).toBeGreaterThan(0)
      const missing = [...values].filter(
        (n) => !DELIBERATELY_UNDOCUMENTED.has(n) && !new RegExp(`\\b${n}\\b`).test(docCorpus),
      )
      expect(missing, `undocumented ${pkg} exports: ${missing.join(', ')}`).toEqual([])
    })
  }
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
