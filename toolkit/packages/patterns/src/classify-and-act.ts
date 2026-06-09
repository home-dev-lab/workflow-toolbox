// classify-and-act.ts — Anthropic "routing" pattern.
//
// Flow: classifyStage → actStage via rt.pipeline().
//
// Conventions:
// - Config errors throw synchronously at entry with actionable messages (§7).
// - Agent failures NEVER throw out of the pattern; they degrade to null,
//   increment the drop counter, and are surfaced as warnings (§7).
// - opts.phase propagated per-call, never via rt.phase() to avoid races (§6.2).
// - Labels: <patternName>:<stage>:<index> for high-signal /workflows UI (§6.2).
// - exactOptionalPropertyTypes: only include optional keys when defined (§bootstrap).

import type { WorkflowRuntime, JsonSchema, ModelAlias } from '@workflow-toolbox/runtime'
import { warn, applyCap, makeRecord } from './envelope.js'
import type { PatternResult, PatternStats, TrailRecord } from './envelope.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActionSpec<TIn> {
  prompt: (item: TIn) => string
  schema?: JsonSchema
  model?: ModelAlias
}

export interface ClassifyAndActOptions<TIn> {
  items: readonly TIn[]
  categories: readonly string[]
  classifyPrompt: (item: TIn) => string
  actions: Readonly<Record<string, ActionSpec<TIn>>>
  classifyModel?: ModelAlias
  phase?: string
  maxItems?: number
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function classifyAndAct<TIn, TOut = string>(
  rt: WorkflowRuntime,
  options: ClassifyAndActOptions<TIn>,
): Promise<PatternResult<Array<{ item: TIn; category: string; result: TOut }>>> {
  const { items, categories, classifyPrompt, actions, classifyModel, phase, maxItems } = options

  // -------------------------------------------------------------------------
  // Synchronous validation — throw with actionable messages
  // -------------------------------------------------------------------------

  if (categories.length === 0) {
    throw new Error('classifyAndAct: categories must not be empty — provide at least one category')
  }

  const seen = new Set<string>()
  for (const cat of categories) {
    if (seen.has(cat)) {
      throw new Error(
        `classifyAndAct: duplicate category "${cat}" — each category must appear exactly once`,
      )
    }
    seen.add(cat)
  }

  const missingFromActions = categories.filter(cat => !(cat in actions))
  if (missingFromActions.length > 0) {
    throw new Error(
      `classifyAndAct: ${missingFromActions.map(c => `category "${c}"`).join(', ')} ` +
      `${missingFromActions.length === 1 ? 'has' : 'have'} no action — ` +
      `add an entry to options.actions or remove the category`,
    )
  }

  // applyCap throws synchronously when maxItems < 1
  const { kept, truncated } = applyCap(items, maxItems)

  // -------------------------------------------------------------------------
  // Mutable counters (closed over in pipeline stages below)
  // -------------------------------------------------------------------------

  let agentsSpawned = 0
  let classifyFailures = 0
  let actionFailures = 0
  const warnings: string[] = []

  // Pending trail entries accumulated inside pipeline stage closures.
  // Each entry carries (itemIndex, stageOrder) for deterministic sort after the pipeline barrier.
  // stageOrder: 0 = classify, 1 = act (within the same item).
  //
  // Trail naming deviation (documented on purpose): act-stage ids embed the
  // routing category (`classifyAndAct:act:<category>:<index>`) because they
  // mirror the rt.agent label — a variable-arity segment other patterns'
  // purely structural stage ids don't have. The category is a caller-supplied
  // enum (a control value, not payload). The DECISION record for the routing
  // choice lives on the classify record (`decision: <category>`); act records
  // carry no `decision` because act executes a decision already made.
  const pendingTrail: Array<{ itemIndex: number; stageOrder: number; record: TrailRecord }> = []

  // -------------------------------------------------------------------------
  // Truncation warning (before pipeline, so it's logged first)
  // -------------------------------------------------------------------------

  if (truncated > 0) {
    warn(
      rt, warnings,
      `classifyAndAct: ${truncated} of ${items.length} items truncated by maxItems=${maxItems ?? '?'}`,
    )
  }

  // -------------------------------------------------------------------------
  // Control schema — owned by the pattern, built from categories
  // The enum constrains classify agents to return only known categories.
  // -------------------------------------------------------------------------

  const controlSchema: JsonSchema = {
    type: 'object',
    properties: {
      category: { type: 'string', enum: [...categories] },
    },
    required: ['category'],
    additionalProperties: false,
  }

  // -------------------------------------------------------------------------
  // Pipeline
  //
  // Stage 1 — classify: call rt.agent with the control schema.
  //   Null result or unknown category → increment classifyFailures, throw
  //   (pipeline maps throws to null → item is dropped).
  //
  // Stage 2 — act: look up the action for the returned category.
  //   Null result → increment actionFailures, throw.
  //   Success → return { item, category, result }.
  //
  // Note: rt.pipeline is untyped (unknown in/out). We cast at our boundary.
  // -------------------------------------------------------------------------

  const classifyStage = async (
    _prev: unknown,
    originalItem: unknown,
    index: number,
  ): Promise<{ item: TIn; category: string }> => {
    const item = originalItem as TIn

    const classifyOpts: {
      schema: JsonSchema
      label: string
      phase?: string
      model?: ModelAlias
    } = {
      schema: controlSchema,
      label: `classifyAndAct:classify:${index}`,
      ...(phase !== undefined ? { phase } : {}),
      ...(classifyModel !== undefined ? { model: classifyModel } : {}),
    }

    agentsSpawned++
    const classified = await rt.agent<{ category: string }>(classifyPrompt(item), classifyOpts)

    if (classified === null) {
      classifyFailures++
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 0,
        record: makeRecord(`classifyAndAct:classify:${index}`, false, classifyModel !== undefined ? { model: classifyModel } : undefined),
      })
      throw new Error('classify returned null')
    }

    // Defensive: the enum should prevent unknown categories, but if the
    // runtime returns something unexpected, we treat it as a classify failure.
    if (!(classified.category in actions)) {
      classifyFailures++
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 0,
        record: makeRecord(`classifyAndAct:classify:${index}`, false, classifyModel !== undefined ? { model: classifyModel } : undefined),
      })
      throw new Error(`classify returned unknown category "${classified.category}"`)
    }

    pendingTrail.push({
      itemIndex: index,
      stageOrder: 0,
      record: makeRecord(`classifyAndAct:classify:${index}`, true, {
        ...(classifyModel !== undefined ? { model: classifyModel } : {}),
        decision: classified.category,
      }),
    })

    return { item, category: classified.category }
  }

  const actStage = async (
    prev: unknown,
    _originalItem: unknown,
    index: number,
  ): Promise<{ item: TIn; category: string; result: TOut }> => {
    const { item, category } = prev as { item: TIn; category: string }
    const spec = actions[category]

    if (spec === undefined) {
      // Unreachable after entry validation (every category has an action) and
      // the enum schema (classifier can only return known categories). If ever
      // reached, the CLASSIFIER violated its enum contract — deliberately
      // counted as a classification failure, not an action failure.
      classifyFailures++
      throw new Error(`no action for category "${category}"`)
    }

    const actOpts: {
      label: string
      phase?: string
      schema?: JsonSchema
      model?: ModelAlias
    } = {
      label: `classifyAndAct:act:${category}:${index}`,
      ...(phase !== undefined ? { phase } : {}),
      ...(spec.schema !== undefined ? { schema: spec.schema } : {}),
      ...(spec.model !== undefined ? { model: spec.model } : {}),
    }

    agentsSpawned++
    const result = await rt.agent<TOut>(spec.prompt(item), actOpts)

    if (result === null) {
      actionFailures++
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 1,
        record: makeRecord(`classifyAndAct:act:${category}:${index}`, false, spec.model !== undefined ? { model: spec.model } : undefined),
      })
      throw new Error('act returned null')
    }

    pendingTrail.push({
      itemIndex: index,
      stageOrder: 1,
      record: makeRecord(`classifyAndAct:act:${category}:${index}`, true, spec.model !== undefined ? { model: spec.model } : undefined),
    })

    return { item, category, result }
  }

  const rawResults = await rt.pipeline(kept as readonly unknown[], classifyStage, actStage)

  // -------------------------------------------------------------------------
  // Collect non-null results
  // -------------------------------------------------------------------------

  const value = rawResults.filter(
    (r): r is { item: TIn; category: string; result: TOut } => r !== null,
  )

  // -------------------------------------------------------------------------
  // Post-pipeline warnings
  // -------------------------------------------------------------------------

  if (classifyFailures > 0) {
    warn(
      rt, warnings,
      `classifyAndAct: ${classifyFailures} of ${kept.length} items failed classification`,
    )
  }

  if (actionFailures > 0) {
    warn(
      rt, warnings,
      `classifyAndAct: ${actionFailures} items failed their action`,
    )
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  const stats: PatternStats = {
    itemsIn: items.length,
    itemsOut: value.length,
    agentsSpawned,
    dropped: kept.length - value.length,
    truncated,
  }

  // Sort trail records by (itemIndex, stageOrder) for deterministic order.
  // rt.pipeline stages run per-item without a barrier, so completion order is non-deterministic;
  // we sort after the pipeline barrier to guarantee stable output across runs.
  pendingTrail.sort((a, b) =>
    a.itemIndex !== b.itemIndex ? a.itemIndex - b.itemIndex : a.stageOrder - b.stageOrder,
  )
  const trail: TrailRecord[] = pendingTrail.map(e => e.record)

  return { value, stats, warnings, trail }
}
