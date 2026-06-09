// doc-rewrite.workflow.ts — Documentation rewrite with evaluator-optimizer loop.
//
// PEDAGOGY: This example teaches 4 key lessons about the evaluator-optimizer pattern:
//
//  (1) EVALUATOR-OPTIMIZER MAPPING [BEA] — loopUntilDone is the architectural
//      home for the "generate → evaluate → refine" cycle. The evaluator asks
//      "does this meet the bar?" and the optimizer improves when it doesn't.
//      This is Batch A Lesson [BEA]: the loop body owns both roles; the pattern
//      owns only the iteration accounting.
//
//  (2) TYPED STOP CONDITIONS — LoopStopConditions is a UNION type that makes
//      omitting ALL stop conditions a compile error (§6.1 rule 7). You cannot
//      accidentally create an unbounded loop: the compiler rejects it. Always
//      supply at least one of maxIterations, dryRounds, or budgetFloor.
//
//  (3) INDEX-BASED DIVERSITY UNDER DETERMINISM BANS — the sandbox bans
//      Math.random() and Date.now() to keep runs reproducible. For diverse
//      candidate generation, use the pipeline index as a deterministic seed:
//      index 0 → concision-first, index 1 → examples-first, index 2 →
//      structure-first, cycling for larger counts. Each angle produces a
//      qualitatively different rewrite, without any randomness.
//
//  (4) HONEST stoppedBy REPORTING — the final output surfaces stoppedBy
//      verbatim from the loop. 'maxIterations' means the evaluator DID NOT
//      approve the doc; approved=false makes that explicit. Never collapse
//      stoppedBy into a boolean — the caller deserves to know WHY the loop
//      stopped (the agent-self-report lesson applied to workflow outputs).
//
//  ON LAUNCH: ALWAYS check WorkflowOutput.error. On partial failure, relaunch
//  with resumeFromRunId — completed agent() calls replay from cache, only
//  missing work re-runs. This is the correct recovery path, not a full restart.

import { defineWorkflow } from '@dwt/build/define'
import type { WorkflowRuntime, JsonSchema } from '@dwt/runtime'
import { generateAndFilter, loopUntilDone } from '@dwt/patterns'
import type { LoopStoppedBy } from '@dwt/patterns'
import { warn } from '@dwt/patterns'
import type { FromSchema } from 'json-schema-to-ts'

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

export interface DocRewriteInput {
  docPath: string
  criteria: string[]
  candidates: number
  maxIterations: number
}

// ---------------------------------------------------------------------------
// JSON Schemas (as-const + FromSchema for type safety at consumed boundaries)
// ---------------------------------------------------------------------------

// Schema for a generated candidate rewrite
const CANDIDATE_SCHEMA = {
  type: 'object',
  properties: {
    rewrite: { type: 'string' },
    angle: { type: 'string' },
  },
  required: ['rewrite', 'angle'],
  additionalProperties: false,
} as const satisfies JsonSchema

type CandidateOutput = FromSchema<typeof CANDIDATE_SCHEMA>

// Schema for the evaluator agent output
const EVALUATOR_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    feedback: { type: 'string' },
  },
  required: ['pass', 'feedback'],
  additionalProperties: false,
} as const satisfies JsonSchema

type EvaluatorOutput = FromSchema<typeof EVALUATOR_SCHEMA>

// Schema for the optimizer agent output
const OPTIMIZER_SCHEMA = {
  type: 'object',
  properties: {
    rewrite: { type: 'string' },
  },
  required: ['rewrite'],
  additionalProperties: false,
} as const satisfies JsonSchema

type OptimizerOutput = FromSchema<typeof OPTIMIZER_SCHEMA>

// ---------------------------------------------------------------------------
// Angle variation by index — deterministic diversity under the sandbox ban
//
// The sandbox bans Math.random() and Date.now() to ensure reproducible runs.
// We use the pipeline index to select a qualitatively different rewrite angle
// for each candidate. The angles cycle for counts > 3, ensuring all candidates
// differ. This is the correct substitute for randomness in a deterministic env.
// ---------------------------------------------------------------------------

const ANGLES: readonly string[] = [
  'concision-first',   // index 0: minimize words, maximize signal
  'examples-first',    // index 1: lead with concrete usage examples
  'structure-first',   // index 2: organize with clear headers and hierarchy
]

function angleForIndex(index: number): string {
  return ANGLES[index % ANGLES.length] ?? 'concision-first'
}

// ---------------------------------------------------------------------------
// Loop state
// ---------------------------------------------------------------------------

interface RefineState {
  draft: string
  feedback: string | null
}

// ---------------------------------------------------------------------------
// Final workflow output
// ---------------------------------------------------------------------------

interface DocRewriteOutput {
  finalDoc: string
  approved: boolean
  iterations: number
  stoppedBy: LoopStoppedBy
  warnings: string[]
}

// ---------------------------------------------------------------------------
// parseInput — fail fast with actionable errors
// ---------------------------------------------------------------------------

function parseInput(raw: unknown): DocRewriteInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      'doc-rewrite: input must be an object with "docPath" and "criteria" fields — ' +
      'received: ' + (raw === null ? 'null' : typeof raw),
    )
  }

  const obj = raw as Record<string, unknown>

  // Validate docPath (a missing key reads as undefined — one check covers both)
  if (obj['docPath'] === undefined) {
    throw new Error(
      'doc-rewrite: missing required field "docPath" — provide the path to the document to rewrite',
    )
  }
  if (typeof obj['docPath'] !== 'string' || obj['docPath'].trim().length === 0) {
    throw new Error(
      'doc-rewrite: "docPath" must be a non-empty string — provide the path to the document to rewrite',
    )
  }

  // Validate criteria
  if (obj['criteria'] === undefined) {
    throw new Error(
      'doc-rewrite: missing required field "criteria" — provide an array of non-empty evaluation criteria strings',
    )
  }
  if (!Array.isArray(obj['criteria'])) {
    throw new Error(
      'doc-rewrite: "criteria" must be an array of non-empty strings',
    )
  }
  const rawCriteria = obj['criteria'] as unknown[]
  if (rawCriteria.length === 0) {
    throw new Error(
      'doc-rewrite: "criteria" must be a non-empty array — provide at least one evaluation criterion',
    )
  }
  for (let i = 0; i < rawCriteria.length; i++) {
    const c = rawCriteria[i]
    if (typeof c !== 'string' || c.trim().length === 0) {
      throw new Error(
        `doc-rewrite: criteria[${i}] must be a non-empty string — all criteria must be non-empty`,
      )
    }
  }
  const criteria = rawCriteria as string[]

  // Validate candidates (optional, default 3, max 5)
  let candidates = 3
  if (obj['candidates'] !== undefined) {
    if (typeof obj['candidates'] !== 'number' || !Number.isInteger(obj['candidates'])) {
      throw new Error(
        'doc-rewrite: "candidates" must be an integer between 1 and 5',
      )
    }
    candidates = obj['candidates'] as number
    if (candidates < 1 || candidates > 5) {
      throw new Error(
        `doc-rewrite: "candidates" must be between 1 and 5, got ${candidates}`,
      )
    }
  }

  // Validate maxIterations (optional, default 4, min 1)
  let maxIterations = 4
  if (obj['maxIterations'] !== undefined) {
    if (typeof obj['maxIterations'] !== 'number' || !Number.isInteger(obj['maxIterations'])) {
      throw new Error(
        'doc-rewrite: "maxIterations" must be an integer >= 1',
      )
    }
    maxIterations = obj['maxIterations'] as number
    if (maxIterations < 1) {
      throw new Error(
        `doc-rewrite: "maxIterations" must be >= 1, got ${maxIterations}`,
      )
    }
  }

  return {
    docPath: obj['docPath'] as string,
    criteria,
    candidates,
    maxIterations,
  }
}

// ---------------------------------------------------------------------------
// Workflow body
// ---------------------------------------------------------------------------

async function run(rt: WorkflowRuntime, input: DocRewriteInput): Promise<DocRewriteOutput> {
  const warnings: string[] = []

  // -------------------------------------------------------------------------
  // Phase 'Generate' — generateAndFilter
  //
  // Pattern: generateAndFilter (generation + single-pass evaluator).
  // Why: we want N diverse candidate rewrites, pre-screened by a filter agent.
  // Only candidates passing the filter advance to the refinement loop.
  //
  // Index-based angle variation (PEDAGOGY point 3): the sandbox bans
  // Math.random() and Date.now(). We use the pipeline index to pick a
  // different rewrite angle for each candidate (concision-first, examples-
  // first, structure-first, cycling). This yields qualitatively different
  // candidates without any randomness — reproducible and deterministic.
  //
  // Agents read the doc themselves from docPath. The orchestrator has NO
  // filesystem access — the sandbox isolates it. Each agent gets docPath and
  // must read the file independently.
  // -------------------------------------------------------------------------

  rt.phase('Generate')

  const generateResult = await generateAndFilter<CandidateOutput>(rt, {
    count: input.candidates,
    generateSchema: CANDIDATE_SCHEMA,
    generatePrompt: (index) => {
      const angle = angleForIndex(index)
      return (
        `Generate a rewrite of the document at path: ${input.docPath}\n` +
        `Rewrite angle: ${angle}\n` +
        `You must READ the document at ${input.docPath} directly — you have filesystem access.\n` +
        `Evaluation criteria (your rewrite must satisfy all of them):\n` +
        input.criteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n') + '\n' +
        `Return { "rewrite": "<full rewritten document>", "angle": "${angle}" }`
      )
    },
    filterPrompt: (candidate) =>
      `Evaluate this candidate rewrite against EACH criterion STRICTLY.\n` +
      `Original document is at: ${input.docPath} — read it to compare.\n` +
      `Criteria:\n` +
      input.criteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n') + '\n' +
      `Candidate rewrite (angle: ${candidate.angle}):\n${candidate.rewrite}\n\n` +
      `Pass ONLY if ALL criteria are met. Return { "pass": true|false, "reason": "<explanation>" }`,
    phase: 'Generate',
  })

  for (const w of generateResult.warnings) warnings.push(w)

  // -------------------------------------------------------------------------
  // Seed selection — pick first survivor or invoke fresh seed agent.
  //
  // If at least one candidate survived the filter: take the first (deterministic).
  // If ZERO survivors: the filter killed everything. This is a CRITERIA problem,
  // not a generation problem — if the criteria are too strict, no candidate will
  // ever pass. We warn explicitly (pattern envelope warnings + composition warning)
  // and seed the refinement loop with a fresh single rewrite agent call.
  //
  // PEDAGOGY: a filter that kills everything is a CRITERIA problem. The warning
  // says so actionably — the caller should review their criteria, not just retry.
  // -------------------------------------------------------------------------

  let seedDraft: string

  const survivors = generateResult.value
  if (survivors.length > 0) {
    // Deterministic: always take the first survivor (index order from pipeline)
    const firstSurvivor = survivors[0]
    seedDraft = firstSurvivor !== undefined ? firstSurvivor.rewrite : ''
  } else {
    // Zero survivors: warn and seed from a fresh agent call
    warn(
      rt, warnings,
      'doc-rewrite [Generate]: all candidates were rejected by the filter — ' +
      'this is typically a CRITERIA problem: criteria that are too strict will reject every candidate. ' +
      'Review your criteria for feasibility. Seeding the refinement loop with a fresh rewrite.',
    )

    const freshSeed = await rt.agent<CandidateOutput>(
      `Generate a single rewrite of the document at path: ${input.docPath}\n` +
      `You must READ the document at ${input.docPath} directly.\n` +
      `Criteria:\n` +
      input.criteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n') + '\n' +
      `Do your best to satisfy as many criteria as possible.\n` +
      `Return { "rewrite": "<full rewritten document>", "angle": "balanced" }`,
      {
        schema: CANDIDATE_SCHEMA,
        label: 'doc-rewrite:seed-fallback',
        phase: 'Generate',
      },
    )

    if (freshSeed === null) {
      throw new Error(
        'doc-rewrite: all filter candidates were rejected AND the fallback seed agent failed. ' +
        'Use resumeFromRunId to retry — completed generate calls are cached.',
      )
    }

    seedDraft = freshSeed.rewrite
  }

  // -------------------------------------------------------------------------
  // Phase 'Refine' — loopUntilDone evaluator-optimizer
  //
  // Pattern: loopUntilDone (evaluator-optimizer loop, §6.1 rule 7).
  //
  // State: { draft: string, feedback: string | null }
  // Body:
  //   1. Evaluator agent — reads the original doc + evaluates the current draft
  //      against ALL criteria. Returns { pass, feedback }.
  //      If pass=true → { state, done: true } (normal completion).
  //   2. If pass=false → Optimizer agent produces the next draft.
  //      Returns { state: { draft, feedback }, done: false, progressed: true }.
  //
  // PEDAGOGY (§6.1 rule 7): the LoopStopConditions TYPE makes omitting every
  // stop condition a COMPILE ERROR. You cannot accidentally write an unbounded
  // loop — the TypeScript type system enforces at least one of: maxIterations,
  // dryRounds, or budgetFloor. Here we use maxIterations from the input.
  // -------------------------------------------------------------------------

  rt.phase('Refine')

  const loopResult = await loopUntilDone<RefineState>(rt, {
    maxIterations: input.maxIterations,
    initial: { draft: seedDraft, feedback: null },
    body: async (loopRt, state) => {
      // Step 1: Evaluator — assess current draft against ALL criteria
      const evaluatorPrompt =
        `Evaluator: does this draft meet ALL criteria? Read the original at ${input.docPath}.\n` +
        `Criteria:\n` +
        input.criteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n') + '\n\n' +
        `Current draft:\n${state.draft}\n\n` +
        `Evaluate STRICTLY against the original document's intent (read ${input.docPath}).\n` +
        `Return { "pass": true|false, "feedback": "<what passes or what needs improvement>" }`

      const evaluation = await loopRt.agent<EvaluatorOutput>(evaluatorPrompt, {
        schema: EVALUATOR_SCHEMA,
        label: 'doc-rewrite:evaluator',
        phase: 'Refine',
      })

      // If evaluator failed (null), treat as not passing — continue the loop
      if (evaluation === null) {
        return { state, done: false, progressed: false }
      }

      // Evaluator approved — normal completion
      if (evaluation.pass) {
        return { state: { draft: state.draft, feedback: evaluation.feedback }, done: true }
      }

      // Step 2: Optimizer — improve the draft based on evaluator feedback
      const optimizerPrompt =
        `Optimizer: improve this draft based on the evaluator feedback.\n` +
        `Original document is at: ${input.docPath} — read it for context.\n` +
        `Criteria:\n` +
        input.criteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n') + '\n\n' +
        `Current draft:\n${state.draft}\n\n` +
        `Evaluator feedback: ${evaluation.feedback}\n\n` +
        `Produce an improved version that addresses all feedback points.\n` +
        `Return { "rewrite": "<full improved document>" }`

      const optimized = await loopRt.agent<OptimizerOutput>(optimizerPrompt, {
        schema: OPTIMIZER_SCHEMA,
        label: 'doc-rewrite:optimizer',
        phase: 'Refine',
      })

      // If optimizer failed (null), keep current draft, mark as not progressed
      if (optimized === null) {
        return {
          state: { draft: state.draft, feedback: evaluation.feedback },
          done: false,
          progressed: false,
        }
      }

      return {
        state: { draft: optimized.rewrite, feedback: evaluation.feedback },
        done: false,
        progressed: true,
      }
    },
  })

  for (const w of loopResult.warnings) warnings.push(w)

  // -------------------------------------------------------------------------
  // Phase 'Finalize' — in-code (no agent)
  //
  // PEDAGOGY: HONEST TERMINAL REPORTING — the agent-self-report lesson applied
  // to workflow outputs. stoppedBy comes directly from the loop; we never paper
  // over it. approved = (stoppedBy === 'done') — if the loop stopped because it
  // ran out of iterations, the doc did NOT pass evaluation and approved is false.
  //
  // 'maxIterations' means: the evaluator never approved the document within the
  // allowed iteration budget. This is NOT a success. The composition surfaces
  // that honestly instead of pretending success — the caller can then decide
  // whether to relaunch with resumeFromRunId (cached iterations replay free)
  // or review their criteria and increase maxIterations.
  // -------------------------------------------------------------------------

  rt.phase('Finalize')

  const { state: finalState, iterations, stoppedBy } = loopResult.value

  return {
    finalDoc: finalState.draft,
    // HONEST: approved only when the evaluator explicitly said "done"
    approved: stoppedBy === 'done',
    iterations,
    stoppedBy,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

export default defineWorkflow({
  meta: {
    name: 'doc-rewrite',
    description:
      'Rewrites a document against a set of quality criteria using an evaluator-optimizer loop: ' +
      'generates diverse candidate rewrites, filters them, then iteratively refines the best candidate ' +
      'until all criteria are met or the iteration budget is exhausted.',
    whenToUse:
      'Use when you need to rewrite a document to meet specific quality criteria, ' +
      'with iterative refinement until the evaluator approves the result.',
    phases: [
      { title: 'Generate', detail: 'Generate diverse candidate rewrites and filter against criteria' },
      { title: 'Refine', detail: 'Evaluator-optimizer loop: evaluate the draft, improve until criteria met' },
      { title: 'Finalize', detail: 'Surface the final document with honest approval status' },
    ],
  },
  parseInput,
  run,
})
