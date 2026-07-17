// fan-out-and-synthesize.ts — parallelization/sectioning + synthesis barrier.
//
// Flow: rt.parallel(task agents) → synthesis agent.
//
// Why rt.parallel (not rt.pipeline) for the fan-out:
//   The synthesis barrier IS this pattern's reason to exist — it genuinely
//   needs all parts before synthesizing. rt.parallel provides the barrier.
//   Per-item stage flows that don't need a barrier should use rt.pipeline instead.
//
// Conventions:
// - Config errors throw synchronously at entry.
// - Agent failures degrade (dropped), never throw out.
// - If all parts are null → value null, synthesis NOT spawned (nothing to synthesize).
// - If synthesis returns null → value null + warning.
// - opts.phase per-call, never rt.phase() (avoids global-state races).
// - Labels: fanOutAndSynthesize:task:<i> / fanOutAndSynthesize:synthesize.

import type { WorkflowRuntime, JsonSchema, ModelAlias, EffortAlias } from '@workflow-toolbox/runtime'
import { warn, applyCap, makeRecord, emitDigest, assertAgentTypeOption } from './envelope.js'
import type { PatternResult, PatternStats, TrailRecord } from './envelope.js'
import { parallelWithCacheWarm } from './cache-warm.js'
import { agentWithSchemaSalvage } from './structured-salvage.js'
import type { StructuredCallOutcome } from './structured-salvage.js'
import { claimStageInstance, stageBuilder } from './stage-instance.js'

const STAGE = 'fanOutAndSynthesize'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FanOutAndSynthesizeOptions<TTask, TPart> {
  tasks: readonly TTask[]
  taskPrompt: (task: TTask, index: number) => string
  taskSchema?: JsonSchema
  taskModel?: ModelAlias
  /** Per-task reasoning effort. Omit to inherit the session effort. */
  taskEffort?: EffortAlias
  /** Subagent type (Agent tool `agentType`) to route the fan-out task agents
   *  through — e.g. 'codex:codex-rescue' / 'workflow-toolbox:opencode-verifier'
   *  for a cross-family model. Omit for the standard Claude subagent. */
  taskType?: string
  synthesisPrompt: (parts: ReadonlyArray<TPart>) => string
  synthesisSchema?: JsonSchema
  synthesisModel?: ModelAlias
  /** Per-synthesis reasoning effort. Omit to inherit the session effort. */
  synthesisEffort?: EffortAlias
  /** Subagent type (Agent tool `agentType`) to route the synthesis agent
   *  through — e.g. 'codex:codex-rescue' / 'workflow-toolbox:opencode-verifier'
   *  for a cross-family model. Omit for the standard Claude subagent. */
  synthesisType?: string
  phase?: string
  maxItems?: number
  /** Per-invocation stage/label discriminator (card #1816036725248493168):
   *  when this pattern is invoked more than once on the SAME rt object, each
   *  invocation's stage/label strings collide by default — this pins a
   *  stable, author-meaningful suffix (` #<stageKey>`) instead of the
   *  auto-assigned per-invocation counter. Must match the charset/shape rule
   *  claimStageInstance canonically enforces (letters, digits, underscore,
   *  dot, hyphen, 1-32 chars, not purely numeric — see stage-instance.ts's
   *  STAGE_KEY_PATTERN, the ONE source of truth for this rule);
   *  an invalid key is reported as a warning and the invocation falls back to
   *  the auto counter (never throws). The auto counter is deterministic for
   *  SEQUENTIALLY invoked patterns only — concurrent same-pattern invocations
   *  (e.g. inside a caller's own rt.pipeline/rt.parallel) get completion-order
   *  numbers, so pass stageKey there for a stable, resume-safe discriminator. */
  stageKey?: string
  /** Stagger the task fan-out so the first task agent completes (and writes
   *  the shared system/tools prefix to the provider's prompt cache) BEFORE
   *  the remaining tasks launch, instead of all N writing that prefix
   *  redundantly at once. Heuristic cost lever, not a correctness change —
   *  costs +1 task's latency on the critical path. **Default true** (staggers
   *  by default — the cache-write saving is free and the latency cost is
   *  small); set `cacheWarm: false` to opt OUT when wall-clock latency
   *  matters more than token/cache cost. See @workflow-toolbox/patterns'
   *  cache-warm.ts. */
  cacheWarm?: boolean
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Fan tasks out to parallel agents, barrier on all parts, then run one
 * synthesis agent over the surviving parts.
 *
 * Config errors throw synchronously at entry (empty `tasks`, `maxItems` < 1).
 * Agent failures degrade, never throw: null parts are dropped (counted in
 * `stats.dropped` + warned). `value` is NULLABLE — null when every part
 * dropped (synthesis skipped) or when the synthesis agent itself returns
 * null; consumers must branch on it.
 *
 * @example
 * ```ts
 * import { fanOutAndSynthesize } from '@workflow-toolbox/patterns'
 * import { FakeRuntime } from '@workflow-toolbox/runtime'
 *
 * const rt = new FakeRuntime({ responses: ['part-a', 'part-b', 'part-c', 'summary'] })
 *
 * const options = {
 *   tasks: ['task-0', 'task-1', 'task-2'],
 *   taskPrompt: (task: string, i: number) => `process task ${i}: ${task}`,
 *   synthesisPrompt: (parts: ReadonlyArray<string>) => `synthesize: ${parts.join(', ')}`,
 * }
 *
 * const result = await fanOutAndSynthesize(rt, options)
 *
 * if (result.value === null) {
 *   // every part dropped (synthesis skipped) or synthesis returned null
 *   rt.log(`no synthesis: ${result.warnings.join('; ')}`)
 * } else {
 *   const { itemsIn, itemsOut, agentsSpawned, dropped, truncated } = result.stats
 *   rt.log(`synthesized ${itemsOut}/${itemsIn} parts (${agentsSpawned} agents, ${dropped} dropped, ${truncated} truncated)`)
 *   rt.log(result.value)
 * }
 * ```
 */
export async function fanOutAndSynthesize<TTask, TPart = string, TOut = string>(
  rt: WorkflowRuntime,
  options: FanOutAndSynthesizeOptions<TTask, TPart>,
): Promise<PatternResult<TOut | null>> {
  const {
    tasks,
    taskPrompt,
    taskSchema,
    taskModel,
    taskEffort,
    taskType,
    synthesisPrompt,
    synthesisSchema,
    synthesisModel,
    synthesisEffort,
    synthesisType,
    phase,
    maxItems,
    stageKey,
    cacheWarm,
  } = options

  // -------------------------------------------------------------------------
  // Synchronous validation
  // -------------------------------------------------------------------------

  if (tasks.length === 0) {
    throw new Error(
      'fanOutAndSynthesize: tasks must not be empty — nothing to fan out',
    )
  }

  assertAgentTypeOption(STAGE, 'taskType', taskType)
  assertAgentTypeOption(STAGE, 'synthesisType', synthesisType)

  // applyCap throws synchronously when maxItems < 1
  const { kept, truncated } = applyCap(tasks, maxItems)

  // -------------------------------------------------------------------------
  // Mutable counters
  // -------------------------------------------------------------------------

  let agentsSpawned = 0
  const warnings: string[] = []
  const trail: TrailRecord[] = []

  // Claim this invocation's stage/label salt NOW — after every synchronous
  // validation throw above and before the first await (card
  // #1816036725248493168, amendment A8).
  const { salt, warning: stageKeyWarning } = claimStageInstance(rt, STAGE, stageKey)
  if (stageKeyWarning !== undefined) warn(rt, warnings, stageKeyWarning)
  const stg = stageBuilder(STAGE, salt)

  // -------------------------------------------------------------------------
  // Truncation warning
  // -------------------------------------------------------------------------

  if (truncated > 0) {
    warn(
      rt, warnings,
      `fanOutAndSynthesize: ${truncated} of ${tasks.length} tasks truncated by maxItems=${maxItems ?? '?'}`,
    )
  }

  // -------------------------------------------------------------------------
  // Fan-out via rt.parallel — the barrier is justified here:
  // synthesis genuinely needs all parts; that's this pattern's reason to exist.
  // -------------------------------------------------------------------------

  const keptArray = kept as readonly TTask[]

  // Built ONCE per task index, reused for BOTH the rt.agent label (in the
  // thunk below) and makeRecord's stage (in the post-barrier collection loop)
  // — card #1816036725248493168, amendment A8.
  const taskStages: string[] = keptArray.map((_, i) => stg(`task:${i}`))

  const taskThunks = keptArray.map((task, i) => async (): Promise<StructuredCallOutcome<TPart>> => {
    const taskOpts: {
      label: string
      phase?: string
      schema?: JsonSchema
      model?: ModelAlias
      effort?: EffortAlias
      agentType?: string
    } = {
      label: taskStages[i]!,
      ...(phase !== undefined ? { phase } : {}),
      ...(taskSchema !== undefined ? { schema: taskSchema } : {}),
      ...(taskModel !== undefined ? { model: taskModel } : {}),
      ...(taskEffort !== undefined ? { effort: taskEffort } : {}),
      ...(taskType !== undefined ? { agentType: taskType } : {}),
    }

    return agentWithSchemaSalvage<TPart>(rt, taskPrompt(task, i), taskOpts)
  })

  const taskResults = await parallelWithCacheWarm(rt, taskThunks, cacheWarm ?? true)

  // -------------------------------------------------------------------------
  // Collect non-null parts and append trail records + spawn counts in
  // item-index order AFTER the rt.parallel barrier (determinism: never
  // completion order). A thunk that threw (budget) resolves to null — that is
  // one spawn, no salvage.
  // -------------------------------------------------------------------------

  const parts: TPart[] = []
  let dropped = 0

  for (let i = 0; i < taskResults.length; i++) {
    const out = taskResults[i] as StructuredCallOutcome<TPart> | null
    const r = out?.value ?? null
    const taskStage = taskStages[i]!
    agentsSpawned += out?.spawns ?? 1
    // Push trail record adjacent to the logical spawn site, in index order.
    // invariant: one record per spawn (the salvage respawn gets its own).
    trail.push(makeRecord(taskStage, r !== null, {
      ...(taskModel !== undefined ? { model: taskModel } : {}),
      ...(taskEffort !== undefined ? { effort: taskEffort } : {}),
    }))
    if (out !== null && out.salvageAttempted) {
      trail.push(makeRecord(`${taskStage}:salvage`, out.salvaged, {
        ...(taskModel !== undefined ? { model: taskModel } : {}),
        ...(taskEffort !== undefined ? { effort: taskEffort } : {}),
      }))
    }
    for (const message of out?.warnings ?? []) warn(rt, warnings, `${STAGE}: ${message}`)

    if (r !== null) {
      parts.push(r)
    } else {
      dropped++
    }
  }

  if (dropped > 0) {
    warn(
      rt, warnings,
      `fanOutAndSynthesize: ${dropped} of ${keptArray.length} fan-out agents returned null`,
    )
  }

  // -------------------------------------------------------------------------
  // Synthesis — only if we have at least one part
  // -------------------------------------------------------------------------

  let value: TOut | null = null

  if (parts.length === 0) {
    warn(rt, warnings, 'fanOutAndSynthesize: fan-out produced no parts; synthesis skipped')
  } else {
    // Built ONCE, used for both the rt.agent label and every makeRecord call
    // below (card #1816036725248493168, amendment A8).
    const synthesizeStage = stg('synthesize')

    const synthOpts: {
      label: string
      phase?: string
      schema?: JsonSchema
      model?: ModelAlias
      effort?: EffortAlias
      agentType?: string
    } = {
      label: synthesizeStage,
      ...(phase !== undefined ? { phase } : {}),
      ...(synthesisSchema !== undefined ? { schema: synthesisSchema } : {}),
      ...(synthesisModel !== undefined ? { model: synthesisModel } : {}),
      ...(synthesisEffort !== undefined ? { effort: synthesisEffort } : {}),
      ...(synthesisType !== undefined ? { agentType: synthesisType } : {}),
    }

    const synthOut = await agentWithSchemaSalvage<TOut>(rt, synthesisPrompt(parts), synthOpts)
    agentsSpawned += synthOut.spawns
    const synthesis = synthOut.value

    // Trail record for synthesis — adjacent to the spawn accounting above.
    trail.push(makeRecord(synthesizeStage, synthesis !== null, {
      ...(synthesisModel !== undefined ? { model: synthesisModel } : {}),
      ...(synthesisEffort !== undefined ? { effort: synthesisEffort } : {}),
    }))
    if (synthOut.salvageAttempted) {
      trail.push(makeRecord(`${synthesizeStage}:salvage`, synthOut.salvaged, {
        ...(synthesisModel !== undefined ? { model: synthesisModel } : {}),
        ...(synthesisEffort !== undefined ? { effort: synthesisEffort } : {}),
      }))
    }
    for (const message of synthOut.warnings) warn(rt, warnings, `${STAGE}: ${message}`)

    if (synthesis === null) {
      warn(rt, warnings, 'fanOutAndSynthesize: synthesis agent returned null')
    } else {
      value = synthesis
    }
  }

  // -------------------------------------------------------------------------
  // Stats
  // itemsOut = surviving task parts (not synthesis — synthesis is a single output)
  // -------------------------------------------------------------------------

  const stats: PatternStats = {
    itemsIn: tasks.length,
    itemsOut: parts.length,
    agentsSpawned,
    dropped,
    truncated,
  }

  // Phase digest: the handoff out of this phase + how many tasks fed the synthesis.
  emitDigest(rt, {
    stage: STAGE,
    ...(phase !== undefined ? { phase } : {}),
    output: value === null ? 'synthesis: none' : `synthesis from ${parts.length}/${tasks.length} tasks`,
    counts: { tasks: tasks.length, completed: parts.length },
  })

  return { value, stats, warnings, trail }
}
