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

import type { WorkflowRuntime, JsonSchema, ModelAlias } from '@workflow-toolbox/runtime'
import { warn, applyCap, makeRecord } from './envelope.js'
import type { PatternResult, PatternStats, TrailRecord } from './envelope.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FanOutAndSynthesizeOptions<TTask, TPart> {
  tasks: readonly TTask[]
  taskPrompt: (task: TTask, index: number) => string
  taskSchema?: JsonSchema
  taskModel?: ModelAlias
  synthesisPrompt: (parts: ReadonlyArray<TPart>) => string
  synthesisSchema?: JsonSchema
  synthesisModel?: ModelAlias
  phase?: string
  maxItems?: number
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
    synthesisPrompt,
    synthesisSchema,
    synthesisModel,
    phase,
    maxItems,
  } = options

  // -------------------------------------------------------------------------
  // Synchronous validation
  // -------------------------------------------------------------------------

  if (tasks.length === 0) {
    throw new Error(
      'fanOutAndSynthesize: tasks must not be empty — nothing to fan out',
    )
  }

  // applyCap throws synchronously when maxItems < 1
  const { kept, truncated } = applyCap(tasks, maxItems)

  // -------------------------------------------------------------------------
  // Mutable counters
  // -------------------------------------------------------------------------

  let agentsSpawned = 0
  const warnings: string[] = []
  const trail: TrailRecord[] = []

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

  const taskThunks = keptArray.map((task, i) => async (): Promise<TPart | null> => {
    const taskOpts: {
      label: string
      phase?: string
      schema?: JsonSchema
      model?: ModelAlias
    } = {
      label: `fanOutAndSynthesize:task:${i}`,
      ...(phase !== undefined ? { phase } : {}),
      ...(taskSchema !== undefined ? { schema: taskSchema } : {}),
      ...(taskModel !== undefined ? { model: taskModel } : {}),
    }

    agentsSpawned++
    return rt.agent<TPart>(taskPrompt(task, i), taskOpts)
  })

  const taskResults = await rt.parallel(taskThunks)

  // -------------------------------------------------------------------------
  // Collect non-null parts and append trail records in item-index order
  // AFTER the rt.parallel barrier (determinism: never completion order).
  // -------------------------------------------------------------------------

  const parts: TPart[] = []
  let dropped = 0

  for (let i = 0; i < taskResults.length; i++) {
    const r = taskResults[i]
    // Push trail record adjacent to the logical spawn site, in index order.
    // invariant: one record per agentsSpawned++ in the fan-out thunks above.
    trail.push(makeRecord(`fanOutAndSynthesize:task:${i}`, r !== null, taskModel !== undefined ? { model: taskModel } : undefined))

    if (r !== null) {
      parts.push(r as TPart)
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
    const synthOpts: {
      label: string
      phase?: string
      schema?: JsonSchema
      model?: ModelAlias
    } = {
      label: 'fanOutAndSynthesize:synthesize',
      ...(phase !== undefined ? { phase } : {}),
      ...(synthesisSchema !== undefined ? { schema: synthesisSchema } : {}),
      ...(synthesisModel !== undefined ? { model: synthesisModel } : {}),
    }

    agentsSpawned++
    const synthesis = await rt.agent<TOut>(synthesisPrompt(parts), synthOpts)

    // Trail record for synthesis — adjacent to agentsSpawned++ above.
    trail.push(makeRecord('fanOutAndSynthesize:synthesize', synthesis !== null, synthesisModel !== undefined ? { model: synthesisModel } : undefined))

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

  return { value, stats, warnings, trail }
}
