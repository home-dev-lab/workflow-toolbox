// plan-and-execute.ts — orchestrator-workers pattern (§P6).
//
// Flow: planner agent produces a subtask list → rt.parallel(worker agents)
//       → synthesis agent over non-null results.
//
// Why synthesis is REQUIRED (P6): orchestrator-workers without synthesis is
//   just a fan-out — use fanOutAndSynthesize or your own loop instead.
//   The distinction: planAndExecute adds a planning layer whose output
//   (subtask decomposition) is itself agent-generated and dynamic.
//   If you already know the tasks statically, fanOutAndSynthesize is simpler.
//
// Workers receive subtasks from a dynamic plan — the subtasks are
// independent by construction (that's WHY you use this pattern: the planner
// decomposed a task into parallel-safe units). rt.parallel is correct here.
//
// Conventions (same as all patterns):
// - Config errors throw synchronously at entry.
// - Agent failures degrade, never throw out.
// - Labels: planAndExecute:plan, planAndExecute:work:<i>, planAndExecute:synthesize.

import type { WorkflowRuntime, JsonSchema, ModelAlias, EffortAlias } from '@workflow-toolbox/runtime'
import { warn, applyCap, makeRecord, emitDigest, assertAgentTypeOption } from './envelope.js'
import type { PatternResult, PatternStats, TrailRecord } from './envelope.js'
import { parallelWithCacheWarm } from './cache-warm.js'

const STAGE = 'planAndExecute'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlannedSubtask {
  description: string
}

export interface PlanAndExecuteResult<TWork, TOut> extends PatternResult<TOut | null> {
  /**
   * Per-worker results that survived (non-null), in subtask order.
   * Empty when the planner failed or every worker returned null.
   */
  workerResults: TWork[]
}

export interface PlanAndExecuteOptions<TWork> {
  planPrompt: string
  planModel?: ModelAlias
  /** Per-plan reasoning effort. Omit to inherit the session effort. */
  planEffort?: EffortAlias
  /** Subagent type (Agent tool `agentType`) to route the plan agent
   *  through — e.g. 'codex:codex-rescue' / 'workflow-toolbox:opencode-verifier'
   *  for a cross-family model. Omit for the standard Claude subagent. */
  planType?: string
  workerPrompt: (subtask: PlannedSubtask, index: number) => string
  workerSchema?: JsonSchema
  workerModel?: ModelAlias
  /** Per-worker reasoning effort. Omit to inherit the session effort. */
  workerEffort?: EffortAlias
  /** Subagent type (Agent tool `agentType`) to route the worker agents
   *  through — e.g. 'codex:codex-rescue' / 'workflow-toolbox:opencode-verifier'
   *  for a cross-family model. Omit for the standard Claude subagent. */
  workerType?: string
  synthesisPrompt: (results: ReadonlyArray<TWork>) => string
  synthesisSchema?: JsonSchema
  synthesisModel?: ModelAlias
  /** Per-synthesis reasoning effort. Omit to inherit the session effort. */
  synthesisEffort?: EffortAlias
  /** Subagent type (Agent tool `agentType`) to route the synthesis agent
   *  through — e.g. 'codex:codex-rescue' / 'workflow-toolbox:opencode-verifier'
   *  for a cross-family model. Omit for the standard Claude subagent. */
  synthesisType?: string
  phase?: string
  maxSubtasks?: number  // cap on planner output; truncation reported
  /** Opt-in: stagger the worker fan-out so the first worker agent completes
   *  (and writes the shared system/tools prefix to the provider's prompt
   *  cache) BEFORE the remaining workers launch, instead of all N writing that
   *  prefix redundantly at once. Heuristic cost lever, not a correctness
   *  change — costs +1 worker's latency on the critical path; default false =
   *  today's behavior, byte-identical. See @workflow-toolbox/patterns' cache-warm.ts. */
  cacheWarm?: boolean
}

// ---------------------------------------------------------------------------
// Plan control schema — owned by the pattern.
// The planner must return an object with a `subtasks` array.
// Each subtask must have a `description` string.
// ---------------------------------------------------------------------------

const PLAN_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    subtasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
        },
        required: ['description'],
        additionalProperties: false,
      },
    },
  },
  required: ['subtasks'],
  additionalProperties: false,
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Orchestrator-workers: a planner agent decomposes the task into subtasks,
 * workers run them via rt.parallel, a required synthesis agent merges the
 * non-null worker results.
 *
 * Config errors (empty planPrompt, maxSubtasks < 1) throw synchronously at
 * entry; agent failures degrade — they warn, never throw out. Unlike the
 * other six patterns, planPrompt is a plain string (the subtasks are not
 * known yet, so there is nothing to template over). The envelope is the only
 * extended one: workerResults carries the surviving per-worker outputs in
 * subtask order, on top of the nullable synthesized value (null when the
 * planner failed, every worker failed, or synthesis returned null).
 *
 * @example
 * ```ts
 * import { planAndExecute } from '@workflow-toolbox/patterns'
 * import { FakeRuntime } from '@workflow-toolbox/runtime'
 *
 * // FIFO: plan object first, then one entry per worker, then the synthesis.
 * const rt = new FakeRuntime({
 *   responses: [
 *     { subtasks: [{ description: 'audit src/' }, { description: 'audit docs/' }] },
 *     'src/ is consistent',
 *     'docs/ is consistent',
 *     'no inconsistencies found',
 *   ],
 * })
 *
 * const result = await planAndExecute(rt, {
 *   planPrompt: 'Create a plan for the task',
 *   workerPrompt: (subtask, i) => `execute subtask ${i}: ${subtask.description}`,
 *   synthesisPrompt: (results) => `synthesize: ${results.join(', ')}`,
 * })
 *
 * if (result.value === null) {
 *   rt.log('planner, all workers, or synthesis failed — see warnings')
 * } else {
 *   rt.log(`synthesis: ${result.value}`) // 'no inconsistencies found'
 * }
 * rt.log(`workers: ${result.workerResults.join(' | ')}`) // non-null results, subtask order
 * const { itemsIn, itemsOut, agentsSpawned, dropped, truncated } = result.stats
 * rt.log(`planned ${itemsIn}, completed ${itemsOut}, spawned ${agentsSpawned}, dropped ${dropped}, truncated ${truncated}`)
 * for (const w of result.warnings) rt.log(w)
 * ```
 */
export async function planAndExecute<TWork = string, TOut = string>(
  rt: WorkflowRuntime,
  options: PlanAndExecuteOptions<TWork>,
): Promise<PlanAndExecuteResult<TWork, TOut>> {
  const {
    planPrompt,
    planModel,
    planEffort,
    planType,
    workerPrompt,
    workerSchema,
    workerModel,
    workerEffort,
    workerType,
    synthesisPrompt,
    synthesisSchema,
    synthesisModel,
    synthesisEffort,
    synthesisType,
    phase,
    maxSubtasks,
    cacheWarm,
  } = options

  // -------------------------------------------------------------------------
  // Synchronous validation — throw with actionable messages
  // -------------------------------------------------------------------------

  if (planPrompt.trim().length === 0) {
    throw new Error(
      'planAndExecute: planPrompt must not be empty — provide a non-whitespace planning prompt',
    )
  }

  // applyCap throws synchronously when maxSubtasks < 1
  if (maxSubtasks !== undefined && maxSubtasks < 1) {
    throw new Error(
      `planAndExecute: maxSubtasks must be >= 1, got ${maxSubtasks}`,
    )
  }

  assertAgentTypeOption(STAGE, 'planType', planType)
  assertAgentTypeOption(STAGE, 'workerType', workerType)
  assertAgentTypeOption(STAGE, 'synthesisType', synthesisType)

  // -------------------------------------------------------------------------
  // Mutable counters
  // -------------------------------------------------------------------------

  let agentsSpawned = 0
  const warnings: string[] = []
  const trail: TrailRecord[] = []

  // -------------------------------------------------------------------------
  // Stage 1 — Planner: single agent call to generate subtask decomposition
  // -------------------------------------------------------------------------

  const planOpts: {
    schema: JsonSchema
    label: string
    phase?: string
    model?: ModelAlias
    effort?: EffortAlias
    agentType?: string
  } = {
    schema: PLAN_SCHEMA,
    label: `${STAGE}:plan`,
    ...(phase !== undefined ? { phase } : {}),
    ...(planModel !== undefined ? { model: planModel } : {}),
    ...(planEffort !== undefined ? { effort: planEffort } : {}),
    ...(planType !== undefined ? { agentType: planType } : {}),
  }

  agentsSpawned++
  const plan = await rt.agent<{ subtasks: PlannedSubtask[] }>(planPrompt, planOpts)

  if (plan === null) {
    warn(rt, warnings, 'planAndExecute: planner returned null — nothing executed')

    trail.push(makeRecord(`${STAGE}:plan`, false, {
      ...(planModel !== undefined ? { model: planModel } : {}),
      ...(planEffort !== undefined ? { effort: planEffort } : {}),
    }))

    const stats: PatternStats = {
      itemsIn: 0,
      itemsOut: 0,
      agentsSpawned,
      dropped: 0,
      truncated: 0,
    }

    // Failure digest: the planner produced no subtasks.
    emitDigest(rt, { stage: STAGE, output: 'synthesis: none', counts: { planned: 0, executed: 0, dropped: 0, truncated: 0 } })
    return { value: null, stats, warnings, workerResults: [], trail }
  }

  const plannedSubtasks = plan.subtasks
  const plannedCount = plannedSubtasks.length

  // -------------------------------------------------------------------------
  // Apply cap on planner output (truncation reported, not silent)
  // -------------------------------------------------------------------------

  const { kept: keptSubtasks, truncated } = applyCap(plannedSubtasks, maxSubtasks)

  if (truncated > 0) {
    warn(
      rt, warnings,
      `planAndExecute: ${truncated} of ${plannedCount} subtasks truncated by maxSubtasks=${maxSubtasks ?? '?'}`,
    )
  }

  // Planner succeeded — record it now that we know the post-cap subtask count.
  trail.push(makeRecord(`${STAGE}:plan`, true, {
    ...(planModel !== undefined ? { model: planModel } : {}),
    ...(planEffort !== undefined ? { effort: planEffort } : {}),
    decision: `subtasks=${keptSubtasks.length}`,
  }))

  // -------------------------------------------------------------------------
  // Stage 2 — Workers: rt.parallel over kept subtasks.
  // Subtasks from a dynamic plan are independent by construction — the planner
  // decomposed the task into parallel-safe units; this is the guarantee that
  // makes rt.parallel correct here (no inter-subtask dependencies).
  // -------------------------------------------------------------------------

  const keptArray = keptSubtasks as PlannedSubtask[]

  const workerThunks = keptArray.map((subtask, i) => async (): Promise<TWork | null> => {
    const opts: {
      label: string
      phase?: string
      schema?: JsonSchema
      model?: ModelAlias
      effort?: EffortAlias
      agentType?: string
    } = {
      label: `${STAGE}:work:${i}`,
      ...(phase !== undefined ? { phase } : {}),
      ...(workerSchema !== undefined ? { schema: workerSchema } : {}),
      ...(workerModel !== undefined ? { model: workerModel } : {}),
      ...(workerEffort !== undefined ? { effort: workerEffort } : {}),
      ...(workerType !== undefined ? { agentType: workerType } : {}),
    }

    agentsSpawned++
    return rt.agent<TWork>(workerPrompt(subtask, i), opts)
  })

  const rawWorkerResults = await parallelWithCacheWarm(rt, workerThunks, cacheWarm ?? false)

  // Collect non-null results in index order, build worker trail records in index order
  // after the parallel barrier (determinism: never completion order).
  const successfulResults: TWork[] = []
  let droppedWorkers = 0

  for (let i = 0; i < rawWorkerResults.length; i++) {
    const r = rawWorkerResults[i]
    trail.push(makeRecord(`${STAGE}:work:${i}`, r !== null, {
      ...(workerModel !== undefined ? { model: workerModel } : {}),
      ...(workerEffort !== undefined ? { effort: workerEffort } : {}),
    }))

    if (r !== null) {
      successfulResults.push(r as TWork)
    } else {
      droppedWorkers++
    }
  }

  if (droppedWorkers > 0) {
    warn(
      rt, warnings,
      `planAndExecute: ${droppedWorkers} of ${keptArray.length} workers returned null`,
    )
  }

  // -------------------------------------------------------------------------
  // Short-circuit: all workers failed → skip synthesis (nothing to synthesize)
  // -------------------------------------------------------------------------

  if (successfulResults.length === 0) {
    warn(rt, warnings, 'planAndExecute: all workers failed; synthesis skipped')

    const stats: PatternStats = {
      itemsIn: plannedCount,
      itemsOut: 0,
      agentsSpawned,
      dropped: droppedWorkers,
      truncated,
    }

    // Failure digest: subtasks were planned but no worker produced a result.
    emitDigest(rt, { stage: STAGE, output: 'synthesis: none', counts: { planned: plannedCount, executed: 0, dropped: droppedWorkers, truncated } })
    return { value: null, stats, warnings, workerResults: [], trail }
  }

  // -------------------------------------------------------------------------
  // Stage 3 — Synthesis over non-null worker results
  // -------------------------------------------------------------------------

  const synthOpts: {
    label: string
    phase?: string
    schema?: JsonSchema
    model?: ModelAlias
    effort?: EffortAlias
    agentType?: string
  } = {
    label: `${STAGE}:synthesize`,
    ...(phase !== undefined ? { phase } : {}),
    ...(synthesisSchema !== undefined ? { schema: synthesisSchema } : {}),
    ...(synthesisModel !== undefined ? { model: synthesisModel } : {}),
    ...(synthesisEffort !== undefined ? { effort: synthesisEffort } : {}),
    ...(synthesisType !== undefined ? { agentType: synthesisType } : {}),
  }

  agentsSpawned++
  const synthesis = await rt.agent<TOut>(synthesisPrompt(successfulResults), synthOpts)

  trail.push(makeRecord(`${STAGE}:synthesize`, synthesis !== null, {
    ...(synthesisModel !== undefined ? { model: synthesisModel } : {}),
    ...(synthesisEffort !== undefined ? { effort: synthesisEffort } : {}),
  }))

  let value: TOut | null = null

  if (synthesis === null) {
    warn(rt, warnings, 'planAndExecute: synthesis agent returned null')
  } else {
    value = synthesis
  }

  // -------------------------------------------------------------------------
  // Stats (documented):
  // - itemsIn = planned subtasks BEFORE cap (the planner's full intent)
  // - itemsOut = non-null worker results (NOT the synthesis product: itemsOut > 0
  //   with value === null means workers produced results but synthesis failed;
  //   the warning carries that signal. Same convention as fanOutAndSynthesize/tournament.)
  // - dropped = null workers
  // - truncated = cap-cut subtasks
  // - agentsSpawned = 1 (planner) + worker calls + 1 (synthesis, if attempted)
  // -------------------------------------------------------------------------

  const stats: PatternStats = {
    itemsIn: plannedCount,
    itemsOut: successfulResults.length,
    agentsSpawned,
    dropped: droppedWorkers,
    truncated,
  }

  // Phase digest: how many subtasks the planner intended vs how many executed,
  // plus the loss breakdown (dropped null workers + cap-truncated subtasks) so
  // observe can render the funnel — mirrors the stats counters above. `planned` is
  // the PRE-cap planner count, so the funnel balances: planned === executed +
  // dropped + truncated (the invariant the observe loss chips render against).
  emitDigest(rt, {
    stage: STAGE,
    output: value === null ? 'synthesis: none' : 'synthesis: ok',
    counts: { planned: plannedCount, executed: successfulResults.length, dropped: droppedWorkers, truncated },
  })

  return { value, stats, warnings, workerResults: successfulResults, trail }
}
