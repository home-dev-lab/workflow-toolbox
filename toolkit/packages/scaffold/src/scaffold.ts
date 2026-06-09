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

export const PATTERN_NAMES = [
  'classifyAndAct',
  'fanOutAndSynthesize',
  'adversarialVerification',
  'generateAndFilter',
  'tournament',
  'loopUntilDone',
  'planAndExecute',
] as const

export type PatternName = (typeof PATTERN_NAMES)[number]

export interface ScaffoldStep {
  /** Which pattern this step calls — one of the seven canonical names. */
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
}

const HEADER = [
  '// Generated by dwt:scaffold — a STARTING POINT, not a finished workflow.',
  '// Replace the placeholder items/claims/tasks and prompt text with your own, and add',
  '// "as const satisfies JsonSchema" schemas at each consumed agent boundary (see the',
  '// workflow-composer skill). Then build and check:',
  '//   pnpm dwt:build <this-file>   &&   pnpm dwt:check workflows/<name>.js',
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

  // Imports: patterns deduped, in canonical order (stable output regardless of step order).
  const usedPatterns = PATTERN_NAMES.filter((p) => spec.steps.some((s) => s.pattern === p))

  // Phases: deduped, first-seen order.
  const phases: string[] = []
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
    `import { ${usedPatterns.join(', ')} } from '@workflow-toolbox/patterns'`,
    '',
    'export default defineWorkflow({',
    '  meta: {',
    `    name: ${q(spec.meta.name)},`,
    `    description: ${q(spec.meta.description)},`,
    `    phases: [${phases.map((p) => `{ title: ${q(p)} }`).join(', ')}],`,
    '  },',
    '  run: async (rt) => {',
    ...body,
    '  },',
    '})',
  ]

  return lines.join('\n') + '\n'
}
