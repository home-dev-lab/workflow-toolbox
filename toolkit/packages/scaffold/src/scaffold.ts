// @workflow-toolbox/scaffold — PURE workflow scaffolder.
//
// Turns a structured spec into a build-clean `.workflow.ts` SKELETON so authors never
// hand-roll the `defineWorkflow` boilerplate (the failure mode the toolkit exists to kill).
// Deliberately lightweight (arch P1/P6/L2): a tiny, deterministic spec → source emitter.
// The "what workflow do I want" → spec mapping is the author's job (the toolkit-scaffold
// SKILL.md guides it from the L1 use/don't-use table), NOT code.
//
// Emission invariants that keep the output build-clean AS-IS:
//   - imports `defineWorkflow` from the sandbox-pure '@workflow-toolbox/build/define' subpath (NOT '@workflow-toolbox/build');
//   - every emitted pattern call uses the MINIMAL valid options for that pattern (typechecks);
//   - `run: async (rt) => …` omits the unused `input` param (no-unused-vars clean);
//   - every `stepN` is referenced in the return (no unused locals);
//   - meta name/description/phase titles are emitted via JSON.stringify — double-quoted, escaped,
//     backtick-free — so the built artifact passes the linter's meta rules (no template literal /
//     no call inside the meta object); placeholder PROMPTS use template literals, but they live in
//     the `run` body where those rules do not apply;
//   - NO active `as const satisfies JsonSchema` consts (an unused schema would be lint-dirty); the
//     header points the author at adding them.
// The committed all-patterns golden fixture (test/fixtures/all-patterns.workflow.ts) is typechecked
// by `pnpm typecheck` and linted by `pnpm lint`, so these invariants are gate-enforced.

import { validateObserverDefinition } from '@workflow-toolbox/debugger/observer-def'
import type { ObserverDefinition } from '@workflow-toolbox/debugger/observer-def'
import { lintSidecarMachineAgnostic } from '@workflow-toolbox/debugger/capability-registry'
import type {
  CapabilitySidecar,
  CapabilitySidecarRole,
  CapabilitySidecarAgent,
  SkillOverrideMode,
} from '@workflow-toolbox/debugger/capability-registry'

export const PATTERN_NAMES = [
  'classifyAndAct',
  'fanOutAndSynthesize',
  'adversarialVerification',
  'generateAndFilter',
  'tournament',
  'loopUntilDone',
  'planAndExecute',
  'scoreAndRank',
  'chunkedAnalysis',
] as const

export type PatternName = (typeof PATTERN_NAMES)[number]

export interface ScaffoldStep {
  /** Which pattern this step calls — one of the nine canonical names. */
  pattern: PatternName
  /** The phase title shown in the /workflows UI; the step's agents are grouped under it. */
  phase: string
}

export interface ScaffoldSpec {
  meta: {
    /** Non-empty kebab-case identifier (mirrors defineWorkflow's own rule). */
    name: string
    /** One-line human summary. */
    description: string
  }
  /** Ordered patterns to chain in the `run` body; at least one. */
  steps: ScaffoldStep[]
}

// Mirrors KEBAB_RE in @workflow-toolbox/build define-workflow.ts so a scaffolded name never gets rejected by build.
const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** Emits the `run`-body lines (indent 4) for one step, given its binding name and phase title. */
type Emitter = (binding: string, phase: string) => string[]

const q = (s: string): string => JSON.stringify(s)

const EMITTERS: Record<PatternName, Emitter> = {
  classifyAndAct: (v, phase) => [
    `    const ${v} = await classifyAndAct(rt, {`,
    `      items: ['placeholder-item'],`,
    `      categories: ['category-a', 'category-b'],`,
    '      classifyPrompt: (item) => `Classify this item into category-a or category-b: ${item}`,',
    '      actions: {',
    "        'category-a': { prompt: (item) => `Handle the category-a item: ${item}` },",
    "        'category-b': { prompt: (item) => `Handle the category-b item: ${item}` },",
    '      },',
    `      phase: ${q(phase)},`,
    '    })',
  ],
  fanOutAndSynthesize: (v, phase) => [
    `    const ${v} = await fanOutAndSynthesize(rt, {`,
    `      tasks: ['placeholder-task'],`,
    '      taskPrompt: (task, index) => `Work item ${index}: ${task}`,',
    '      synthesisPrompt: (parts) => `Synthesize the ${parts.length} partial results.`,',
    `      phase: ${q(phase)},`,
    '    })',
  ],
  adversarialVerification: (v, phase) => [
    `    const ${v} = await adversarialVerification(rt, {`,
    `      claims: ['placeholder-claim'],`,
    '      renderClaim: (claim) => `Verify this claim, refuting if uncertain: ${claim}`,',
    `      phase: ${q(phase)},`,
    '    })',
  ],
  generateAndFilter: (v, phase) => [
    `    const ${v} = await generateAndFilter(rt, {`,
    '      count: 3,',
    '      generatePrompt: (index) => `Generate candidate number ${index}.`,',
    '      filterPrompt: (candidate) => `Keep this candidate? ${candidate}`,',
    `      phase: ${q(phase)},`,
    '    })',
  ],
  tournament: (v, phase) => [
    `    const ${v} = await tournament(rt, {`,
    `      angles: ['angle-a', 'angle-b'],`,
    '      attemptPrompt: (angle, index) => `Attempt ${index} from this angle: ${angle}`,',
    '      judgePrompt: (attempt) => `Score this attempt: ${attempt}`,',
    '      synthesisPrompt: (ranked) => `Synthesize the best of ${ranked.length} ranked attempts.`,',
    `      phase: ${q(phase)},`,
    '    })',
  ],
  // loopUntilDone has NO `phase` option — assign the phase via rt.phase() before the call.
  loopUntilDone: (v, phase) => [
    `    rt.phase(${q(phase)})`,
    `    const ${v} = await loopUntilDone(rt, {`,
    '      initial: { rounds: 0 },',
    '      maxIterations: 3,',
    '      body: async (rt, state, iteration) => {',
    '        await rt.agent(`Refinement iteration ${iteration}: improve the current draft.`)',
    '        // TODO: replace the done condition below with your real stop check (e.g. an evaluator verdict).',
    '        return { state: { rounds: state.rounds + 1 }, done: false }',
    '      },',
    '    })',
  ],
  planAndExecute: (v, phase) => [
    `    const ${v} = await planAndExecute(rt, {`,
    "      planPrompt: 'Break the goal into independent subtasks.',",
    '      workerPrompt: (subtask, index) => `Subtask ${index}: ${subtask.description}`,',
    '      synthesisPrompt: (results) => `Combine the ${results.length} worker results.`,',
    `      phase: ${q(phase)},`,
    '    })',
  ],
  scoreAndRank: (v, phase) => [
    `    const ${v} = await scoreAndRank(rt, {`,
    `      items: ['placeholder-item'],`,
    '      dimensions: [',
    "        { name: 'impact', prompt: (item) => `Score the impact of ${item} from 1 to 5.` },",
    "        { name: 'opportunity', prompt: (item) => `Score the opportunity in ${item} from 1 to 5.` },",
    '      ],',
    "      cutoff: { type: 'topK', k: 3 },",
    `      phase: ${q(phase)},`,
    '    })',
  ],
  chunkedAnalysis: (v, phase) => [
    '    // chunkedAnalysis fans out one agent per chunk of the input — size maxChars for',
    '    // the analyze model. Tune cost/quality per role with analyzeModel/analyzeEffort/',
    '    // analyzeType (+ the synthesize equivalents), or blanket-tune every agent in this',
    '    // run via the launch-time `perAgent` knob (args.perAgent -> parseConfig ->',
    '    // withAgentDefaults; see toolkit/examples/pr-review.workflow.ts for the idiom).',
    `    const ${v} = await chunkedAnalysis(rt, {`,
    `      input: 'placeholder-content-to-chunk',`,
    '      maxChars: 4000,',
    '      analyzePrompt: (chunk, index, total) => `Analyze chunk ${index + 1} of ${total}: ${chunk}`,',
    '      synthesizePrompt: (chunkResults) => `Synthesize these ${chunkResults.length} chunk analyses.`,',
    `      phase: ${q(phase)},`,
    '    })',
  ],
}

const HEADER = [
  '// Generated by workflow-toolbox scaffold — a STARTING POINT, not a finished workflow.',
  '// Replace the placeholder items/claims/tasks and prompt text with your own, and add',
  '// "as const satisfies JsonSchema" schemas at each consumed agent boundary (see the',
  '// workflow-composer skill). Then build and check:',
  '//   npx workflow-toolbox build <this-file>   &&   npx workflow-toolbox check workflows/<name>.js',
]

/**
 * Emit a build-clean `.workflow.ts` skeleton for the given spec. Pure: same spec → byte-identical
 * output, zero IO. Throws an actionable Error (never a bare TypeError) on a semantically invalid spec.
 */
export function scaffoldWorkflow(spec: ScaffoldSpec): string {
  if (spec.steps.length === 0) {
    throw new Error('scaffoldWorkflow: spec.steps is empty — add at least one { pattern, phase } step.')
  }
  if (!KEBAB_RE.test(spec.meta.name)) {
    throw new Error(
      `scaffoldWorkflow: invalid meta.name ${q(spec.meta.name)} — must be non-empty kebab-case (e.g. "my-workflow").`,
    )
  }
  if (spec.meta.description.trim() === '') {
    throw new Error('scaffoldWorkflow: meta.description is empty — provide a one-line summary.')
  }
  for (const step of spec.steps) {
    if (!PATTERN_NAMES.includes(step.pattern)) {
      throw new Error(
        `scaffoldWorkflow: unknown pattern ${q(step.pattern)} — valid: ${PATTERN_NAMES.join(', ')}.`,
      )
    }
  }

  // Imports: patterns deduped, in canonical order (stable output regardless of step order),
  // plus withLeafFence — the toolkit's default leaf-agent fence, always wired in (below).
  const usedPatterns = PATTERN_NAMES.filter((p) => spec.steps.some((s) => s.pattern === p))

  // Phases: 'Fence' first (the leaf-fence probe, always run), then deduped step phases in
  // first-seen order.
  const phases: string[] = ['Fence']
  for (const step of spec.steps) {
    if (!phases.includes(step.phase)) phases.push(step.phase)
  }

  const body: string[] = []
  spec.steps.forEach((step, i) => {
    if (i > 0) body.push('')
    body.push(...EMITTERS[step.pattern](`step${i + 1}`, step.phase))
  })
  body.push('')
  const returnFields = spec.steps.map((_, i) => `step${i + 1}: step${i + 1}.value`).join(', ')
  body.push(`    return { ${returnFields} }`)

  const lines = [
    ...HEADER,
    '',
    "import { defineWorkflow } from '@workflow-toolbox/build/define'",
    `import { ${usedPatterns.join(', ')}, withLeafFence } from '@workflow-toolbox/patterns'`,
    '',
    'export default defineWorkflow({',
    '  meta: {',
    `    name: ${q(spec.meta.name)},`,
    `    description: ${q(spec.meta.description)},`,
    `    phases: [${phases.map((p) => `{ title: ${q(p)} }`).join(', ')}],`,
    '  },',
    '  run: async (rt0) => {',
    "    // Default leaf-agent fence: every agent this workflow spawns denies SendMessage",
    "    // by default (see @workflow-toolbox/patterns' withLeafFence). Pass",
    "    // `{ disabled: true }` only if this workflow genuinely needs its agents to coordinate.",
    "    // Stages whose prompts are 100% inline (classify/score/dedup/synthesize, no",
    "    // 'read the repo/diff' instruction) can also shed the ambient tool/skill injection:",
    "    // route those call sites through withLeanRouting (selective, never blanket).",
    "    const { rt } = await withLeafFence(rt0, { phase: 'Fence' })",
    '',
    ...body,
    '  },',
    '})',
  ]

  return lines.join('\n') + '\n'
}

/** Narrow untrusted JSON to the spec shape, with an actionable message on the
 *  first defect. Shared by the in-repo scaffold CLI and the published
 *  `workflow-toolbox scaffold` subcommand. Pure. */
export function assertSpecShape(x: unknown): asserts x is ScaffoldSpec {
  const fail = (msg: string): never => {
    throw new Error(`workflow-toolbox scaffold: ${msg}`)
  }
  if (typeof x !== 'object' || x === null) fail('spec must be a JSON object { meta, steps }.')
  const spec = x as Record<string, unknown>
  const meta = spec['meta']
  if (typeof meta !== 'object' || meta === null) fail('spec.meta must be an object with name + description.')
  const m = meta as Record<string, unknown>
  if (typeof m['name'] !== 'string' || typeof m['description'] !== 'string') {
    fail('spec.meta.name and spec.meta.description must both be strings.')
  }
  if (!Array.isArray(spec['steps'])) fail('spec.steps must be an array of { pattern, phase }.')
  for (const [i, step] of (spec['steps'] as unknown[]).entries()) {
    if (typeof step !== 'object' || step === null) fail(`spec.steps[${i}] must be an object { pattern, phase }.`)
    const s = step as Record<string, unknown>
    if (typeof s['pattern'] !== 'string' || typeof s['phase'] !== 'string') {
      fail(`spec.steps[${i}].pattern and .phase must both be strings.`)
    }
  }
}

// ── agentType `.md` scaffolder ────────────────────────────────────────────────
// Emits a least-privilege agentType `.md` (the capability FENCE for a workflow leaf
// or an SDK agent): frontmatter `tools`/`disallowedTools`/`skills`/`model`/`effort`
// + a system-prompt body + optional "Do NOT …" non-goals backstop. Capability denial
// is the primary guard (a tool the agent lacks cannot be misused); the non-goals are
// only the backstop for what can't be cleanly denied (e.g. Bash). Frontmatter field
// set mirrors the current agent schema — kept honest by the canary drift check
// (card #1815347737189680613).

export interface AgentScaffoldSpec {
  /** kebab-case agent name — the `.md` filename AND the agentType key. */
  name: string
  /** One-line "when to use this agent" (the frontmatter `description`). */
  description: string
  /** The agent's system prompt (the `.md` body). */
  prompt: string
  /** Tools allowlist — the capability fence. Omit → the agent INHERITS ALL tools
   *  (a ⚠ warning is emitted into the body). */
  tools?: string[]
  /** Denylist, applied before `tools` (accepts `mcp__server` / `mcp__*` patterns). */
  disallowedTools?: string[]
  /** Skills the agent may invoke. */
  skills?: string[]
  /** Model alias (e.g. 'sonnet', 'haiku'). */
  model?: string
  /** Reasoning effort (low|medium|high|xhigh|max). */
  effort?: string
  /** Instruction backstop → "Do NOT <goal>." lines appended to the body. */
  nonGoals?: string[]
}

/** YAML-safe scalar: double-quote + escape only when the value could break an
 *  unquoted YAML scalar (over-quoting is harmless — double-quoted YAML is always
 *  valid — so this errs toward quoting). */
function yamlScalar(s: string): string {
  const needsQuote =
    s === '' ||
    /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(s) || // leading YAML indicator
    /:\s|\s#/.test(s) || // mid colon-space / space-hash
    /[\n\t"\\]/.test(s) || // control / quote / backslash
    /\s$/.test(s) // trailing space
  return needsQuote ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s
}

/**
 * Emit a least-privilege agentType `.md` from a capability spec. Pure: same spec →
 * byte-identical output, zero IO. Throws an actionable Error on an invalid spec.
 */
export function scaffoldAgent(spec: AgentScaffoldSpec): string {
  if (!KEBAB_RE.test(spec.name)) {
    throw new Error(
      `scaffoldAgent: invalid name ${q(spec.name)} — must be non-empty kebab-case (e.g. "locked-reviewer").`,
    )
  }
  if (spec.description.trim() === '') {
    throw new Error('scaffoldAgent: description is empty — provide a one-line "when to use" summary.')
  }
  if (spec.prompt.trim() === '') {
    throw new Error('scaffoldAgent: prompt is empty — provide the agent’s system prompt.')
  }

  const fm: string[] = ['---', `name: ${spec.name}`, `description: ${yamlScalar(spec.description)}`]
  if (spec.tools && spec.tools.length > 0) fm.push(`tools: ${spec.tools.join(', ')}`)
  if (spec.disallowedTools && spec.disallowedTools.length > 0) fm.push(`disallowedTools: ${spec.disallowedTools.join(', ')}`)
  if (spec.skills && spec.skills.length > 0) fm.push(`skills: ${spec.skills.join(', ')}`)
  if (spec.model !== undefined && spec.model !== '') fm.push(`model: ${spec.model}`)
  if (spec.effort !== undefined && spec.effort !== '') fm.push(`effort: ${spec.effort}`)
  fm.push('---')

  const body: string[] = ['', spec.prompt.trim(), '']
  if (!spec.tools || spec.tools.length === 0) {
    body.push(
      '> ⚠ No `tools:` allowlist in the frontmatter — this agent INHERITS ALL tools',
      '> (Write/Edit/Bash/MCP included). For a least-privilege fence, add a `tools:` line',
      '> listing ONLY what it needs — capability denial beats instruction (a tool it lacks',
      '> cannot be misused).',
      '',
    )
  }
  if (spec.nonGoals && spec.nonGoals.length > 0) {
    body.push(
      '## Non-goals (instruction backstop — the frontmatter capability fence is the PRIMARY guard)',
      ...spec.nonGoals.map((g) => `- Do NOT ${g.replace(/[.]\s*$/, '')}.`),
      '',
    )
  }
  return [...fm, ...body].join('\n') + '\n'
}

/** Narrow untrusted JSON to the agent-spec shape, actionable message on first defect. Pure. */
export function assertAgentSpecShape(x: unknown): asserts x is AgentScaffoldSpec {
  const fail = (msg: string): never => {
    throw new Error(`workflow-toolbox scaffold agent: ${msg}`)
  }
  if (typeof x !== 'object' || x === null) fail('spec must be a JSON object { name, description, prompt, ... }.')
  const s = x as Record<string, unknown>
  for (const k of ['name', 'description', 'prompt'] as const) {
    if (typeof s[k] !== 'string') fail(`spec.${k} must be a string.`)
  }
  for (const k of ['tools', 'disallowedTools', 'skills', 'nonGoals'] as const) {
    const v = s[k]
    if (v !== undefined && (!Array.isArray(v) || v.some((e) => typeof e !== 'string'))) {
      fail(`spec.${k}, if present, must be an array of strings.`)
    }
  }
  for (const k of ['model', 'effort'] as const) {
    if (s[k] !== undefined && typeof s[k] !== 'string') fail(`spec.${k}, if present, must be a string.`)
  }
}

// ── observer definition scaffolder ────────────────────────────────────────────
// Emits a WORKFLOW-owned `<name>.observer.json` (an ObserverDefinition) from an
// ABSTRACT declaration — the composer's authoring-time output (time 1 of the 3-time
// model: composer → machine resolver → run), placed next to the workflow artifact.
// Validation is REUSED from the shipped contract (@workflow-toolbox/debugger's
// observer-def, the SAME module `wt-observe launch` + `POST /api/launch` fail-loud on),
// never re-implemented here: an emitted definition the launch bridge would reject is an
// authoring bug this scaffolder must catch early, with the SAME message the launch shows.

/** Authoring spec for an observer definition — an ObserverDefinition minus its
 *  `schemaVersion` (the scaffolder stamps `schemaVersion: 1`). Workflow-owned: NO
 *  concrete tool and NO machine path may appear (the shared validator enforces both —
 *  e.g. `watch.transcriptFile` and non-abstract `requires` are refused). */
export type ObserverScaffoldSpec = Omit<ObserverDefinition, 'schemaVersion'>

/**
 * Emit a `<name>.observer.json` string for the given abstract declaration. Pure: same
 * spec → byte-identical output, zero IO. The assembled definition is run back through
 * the SHARED `validateObserverDefinition`; on any violation this throws an actionable
 * Error listing EVERY problem (one pass) rather than ever emitting an invalid artifact.
 */
export function scaffoldObserver(spec: ObserverScaffoldSpec): string {
  // schemaVersion leads (a version field belongs first in the emitted artifact) and `as
  // const` keeps it the literal `1` type, not widened to `number`. The type omits
  // schemaVersion, so a well-typed caller never sets it; a stray one in untrusted raw JSON
  // spreads LAST and, if it is not 1, fails LOUD in the shared validator below — never
  // silently coerced.
  const definition = { schemaVersion: 1 as const, ...spec }
  const errors: string[] = []
  validateObserverDefinition(definition, 'observer', errors)
  if (errors.length > 0) {
    throw new Error(`workflow-toolbox scaffold observer: ${errors.join('; ')}`)
  }
  return JSON.stringify(definition, null, 2) + '\n'
}

/** The post-emission authoring guidance for an observer definition: the launch bridge
 *  (`args.observers`, a SIBLING of `args.capabilities`), the load-bearing selector coupling
 *  (`watch.roles`/`watch.phases` must equal the wt-meta LABEL segment the observed agents
 *  emit, else the observer sits in no-match), and — when the definition may emit wt-comm
 *  hints — the honest note that the observe-server RUNTIME briefs the matched roles with the
 *  canonical observed-role consumer brief (shipped with @workflow-toolbox/comm; REFERENCED,
 *  never copied — it is runtime-parameterized). Pure: same spec → same text. Shared by both
 *  scaffold CLIs so the load-bearing reminders cannot drift between them. */
export function observerLaunchHint(spec: ObserverScaffoldSpec): string {
  const roles = spec.watch.roles ?? []
  const phases = spec.watch.phases ?? []
  const targets =
    [
      roles.length > 0 ? `role(s) ${roles.join(', ')}` : '',
      phases.length > 0 ? `phase(s) ${phases.join(', ')}` : '',
    ]
      .filter((s) => s !== '')
      .join(' + ') || 'the watched selectors'
  const emitsWtComm = (spec.actions ?? []).includes('wt-comm')
  const lines = [
    'Next — reference it at launch as a SIBLING of args.capabilities:',
    `  args.observers: [{ definitionFile: ${q(`${spec.name}.observer.json`)} }]   (or an inline { definition })`,
    '',
    `Label the observed agents so ${targets} matches their wt-meta label segment — toolkit`,
    'patterns auto-label with their stage name; pass a stable `label` to a hand-rolled agent()',
    'call. A selector with no matching label sits in no-match (never silent in the observer API).',
  ]
  if (emitsWtComm) {
    lines.push(
      '',
      `This observer may emit wt-comm hints to ${targets}. When the observe-server runtime`,
      'attaches it, the runtime briefs those roles with the canonical observed-role consumer',
      'brief (@workflow-toolbox/comm: teaching/wt-comm-observer-consumer.md) — reference it,',
      'never copy it (it is runtime-parameterized). Attachment + hint delivery ship with the',
      'observatory runtime; authoring + args.observers validation are available now.',
    )
  }
  return lines.join('\n') + '\n'
}

/** Narrow untrusted JSON to the observer-spec shape. MINIMAL by design: the field rules
 *  live in the shared `validateObserverDefinition` (invoked by `scaffoldObserver`) and are
 *  never duplicated here — this only guards the "not even an object" case so the spread in
 *  `scaffoldObserver` is safe. Pure. */
export function assertObserverScaffoldSpec(x: unknown): asserts x is ObserverScaffoldSpec {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) {
    throw new Error(
      'workflow-toolbox scaffold observer: spec must be a JSON object (an ObserverDefinition without schemaVersion).',
    )
  }
}

// ── capability sidecar scaffolder ─────────────────────────────────────────────
// Emits a WORKFLOW-owned `<name>.capabilities.json` (a CapabilitySidecar) from an
// ABSTRACT declaration — the composer's authoring-time output (time 1 of the 3-time
// model: composer → machine resolver → run, design §7). Machine-agnostic by
// construction: per-role abstract `needs`, and agent tool allowlists that carry only
// `$cap:<need>` placeholders + non-MCP builtin tools — NEVER a concrete provider or path.
// Validation is REUSED from the shipped launch guard (@workflow-toolbox/debugger's
// capability-registry `lintSidecarMachineAgnostic`, the resolution-independent subset of
// the SAME rules `sidecarToCapabilitiesSpec` enforces at launch), never re-implemented
// here — an emitted sidecar the launch would reject is an authoring bug this scaffolder
// must catch early, with the SAME message the launch shows. (Exact parity with the
// observer scaffolder reusing validateObserverDefinition above.)

/** Authoring spec for a capability sidecar. `name` is FILENAME-ONLY: it must equal
 *  the workflow's `meta.name` so the emitted `<name>.capabilities.json` sits beside the
 *  built `workflows/<name>.js` (the launcher derives the sidecar path from the workflow
 *  artifact path — `sidecarPathFor`). It is NOT part of the emitted JSON: a
 *  CapabilitySidecar has no `name` (unlike an ObserverDefinition). The remaining fields
 *  ARE the sidecar minus its stamped `version`. */
export interface CapabilitiesScaffoldSpec {
  /** kebab-case — drives the output filename only. It SHOULD equal the workflow's
   *  meta.name so the sidecar sits beside `<name>.js`, but that cross-artifact match is
   *  the author's responsibility: a standalone capabilities spec cannot see the workflow
   *  spec, so only the kebab FORMAT is validated here. */
  name: string
  /** role-name → { agent, needs }. Lean/leaf roles are ABSENT (the bare default holds). */
  roles: Record<string, CapabilitySidecarRole>
  /** agent-name → machine-agnostic def (tools use `$cap:<need>`, never a concrete server). */
  agents: Record<string, CapabilitySidecarAgent>
  /** Optional skills settings, read by the launcher (design §6). */
  skillOverrides?: Record<string, SkillOverrideMode>
  disableBundledSkills?: boolean
}

/**
 * Emit a `<name>.capabilities.json` string for the given abstract sidecar declaration.
 * Pure: same spec → byte-identical output, zero IO. `version: 1` is stamped and leads;
 * `name` is stripped (filename-only). The TOP-LEVEL object is assembled from known keys;
 * the SHARED `lintSidecarMachineAgnostic` then rejects any unmodelled field NESTED in a
 * role or agent def (fail-loud), so no arbitrary key smuggles machine state into the
 * artifact through the by-reference roles/agents. On any violation this throws an
 * actionable Error listing EVERY problem (one pass) rather than ever emitting a
 * machine-specific or malformed artifact.
 */
export function scaffoldCapabilities(spec: CapabilitiesScaffoldSpec): string {
  if (!KEBAB_RE.test(spec.name)) {
    throw new Error(
      `scaffoldCapabilities: invalid name ${q(spec.name)} — must be non-empty kebab-case (e.g. "pr-review"); it should also match the workflow's meta.name so the sidecar sits beside <name>.js (author-enforced, not checked here).`,
    )
  }
  // Assemble the top level from KNOWN keys (version leads). Nested role/agent fields
  // ride through by reference but the shared lint below rejects any unmodelled one, so
  // an untrusted spec cannot smuggle a machine-specific field into the artifact — the
  // field-level rules are the lint's job, exactly as the observer scaffolder delegates.
  const sidecar: CapabilitySidecar = {
    version: 1,
    roles: spec.roles,
    agents: spec.agents,
    ...(spec.skillOverrides !== undefined ? { skillOverrides: spec.skillOverrides } : {}),
    ...(spec.disableBundledSkills !== undefined ? { disableBundledSkills: spec.disableBundledSkills } : {}),
  }
  const errors = lintSidecarMachineAgnostic(sidecar)
  if (errors.length > 0) {
    throw new Error(`workflow-toolbox scaffold capabilities: ${errors.join('; ')}`)
  }
  return JSON.stringify(sidecar, null, 2) + '\n'
}

/** The post-emission authoring guidance for a capability sidecar: place it beside the
 *  built artifact (the launcher auto-detects `<name>.capabilities.json` by adjacency),
 *  the `$cap:<need>` → machine-registry resolution at LAUNCH, the bare default for roles
 *  with no entry, and the adoption discipline (design §5.2/§7.3 — provisioning a tool is
 *  not adopting it: keep the alternative OUT of the allowlist and repeat the tooling
 *  instruction in the TASK prompt). Pure: same spec → same text. */
export function capabilitiesLaunchHint(spec: CapabilitiesScaffoldSpec): string {
  const roleNames = Object.keys(spec.roles ?? {})
  const rolesLabel = roleNames.length > 0 ? roleNames.join(', ') : '(none — the bare default already applies)'
  const lines = [
    `Next — place ${spec.name}.capabilities.json BESIDE the built workflow artifact (workflows/${spec.name}.js).`,
    '`wt-observe launch` auto-detects <name>.capabilities.json by filename adjacency, resolves each',
    '$cap:<need> against the MACHINE registry at launch, and composes the concrete tools into the',
    'delegated run. The sidecar names NO provider or path — resolution is per-machine.',
    '',
    `Tooled role(s): ${rolesLabel}. A role with NO entry here stays bare (lean/leaf default = nothing).`,
    '',
    'Adoption (design §5.2/§7.3) — provisioning a tool is NOT adopting it:',
    '  - keep the alternative OUT of the allowlist (removing grep/glob is the proven lever), and',
    "  - repeat the tooling instruction in the role's TASK prompt, not only its system prompt.",
    'The launcher appends a mechanical "## Capability resolution" note per resolved need.',
  ]
  return lines.join('\n') + '\n'
}

/** Narrow untrusted JSON to the capability-sidecar spec shape. MINIMAL by design: the
 *  field rules live in the shared `lintSidecarMachineAgnostic` (invoked by
 *  `scaffoldCapabilities`) and are never duplicated here — this only guards the "not even
 *  an object" case and the filename-bearing `name`, so the assembly in
 *  `scaffoldCapabilities` is safe. Pure. */
export function assertCapabilitiesScaffoldSpec(x: unknown): asserts x is CapabilitiesScaffoldSpec {
  const fail = (msg: string): never => {
    throw new Error(`workflow-toolbox scaffold capabilities: ${msg}`)
  }
  if (typeof x !== 'object' || x === null || Array.isArray(x)) {
    fail('spec must be a JSON object { name, roles, agents, ... }.')
  }
  const s = x as Record<string, unknown>
  if (typeof s['name'] !== 'string') {
    fail('spec.name must be a string — the workflow name that drives the <name>.capabilities.json filename.')
  }
}

/** Minimal tsconfig for a fresh workflow-authoring dir. Single source shared by
 *  `workflow-toolbox scaffold` (which writes it when the target dir has none) and
 *  `workflow-toolbox build --typecheck` (whose no-tsconfig fallback derives from it) — the
 *  two must agree or --typecheck behaves differently on scaffolded projects. */
export const MINIMAL_TSCONFIG = {
  compilerOptions: {
    module: 'esnext',
    moduleResolution: 'bundler',
    target: 'es2022',
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ['*.workflow.ts'],
} as const
