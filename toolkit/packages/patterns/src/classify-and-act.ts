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

import type { WorkflowRuntime, JsonSchema, ModelAlias, EffortAlias } from '@workflow-toolbox/runtime'
import { warn, applyCap, makeRecord, emitDigest, assertAgentTypeOption } from './envelope.js'
import type { PatternResult, PatternStats, TrailRecord } from './envelope.js'
import { pipelineWithCacheWarm } from './cache-warm.js'
import { agentWithSchemaSalvage } from './structured-salvage.js'

const STAGE = 'classifyAndAct'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActionSpec<TIn> {
  prompt: (item: TIn) => string
  schema?: JsonSchema
  model?: ModelAlias
  /** Per-action reasoning effort. Omit to inherit the session effort. */
  effort?: EffortAlias
  /** Per-action subagent type (Agent tool `agentType`) to route THIS category's
   *  act agents through — e.g. 'codex:codex-rescue' /
   *  'workflow-toolbox:opencode-verifier' for a cross-family model. Omit for the
   *  standard Claude subagent. Per-category (like `model`/`effort`) so different
   *  categories can decorrelate to different families. */
  agentType?: string
}

export interface ClassifyAndActOptions<TIn> {
  items: readonly TIn[]
  categories: readonly string[]
  classifyPrompt: (item: TIn) => string
  actions: Readonly<Record<string, ActionSpec<TIn>>>
  classifyModel?: ModelAlias
  /** Per-classify reasoning effort. Omit to inherit the session effort. */
  classifyEffort?: EffortAlias
  /** Subagent type (Agent tool `agentType`) to route the classify agents
   *  through — e.g. 'codex:codex-rescue' / 'workflow-toolbox:opencode-verifier'
   *  for a cross-family model. Omit for the standard Claude subagent. */
  classifyType?: string
  phase?: string
  maxItems?: number
  /** Stagger the per-item pipeline so item 0's classify call completes (and
   *  writes the shared system/tools prefix to the provider's prompt cache)
   *  BEFORE the remaining items' classify calls launch, instead of all N
   *  writing that prefix redundantly at once (rt.pipeline runs every item's
   *  first stage concurrently, with no barrier between stages). Heuristic
   *  cost lever, not a correctness change — costs +1 item's latency on the
   *  critical path. **Default true**; set `cacheWarm: false` to opt OUT when
   *  wall-clock latency matters more than token/cache cost. See
   *  @workflow-toolbox/patterns' cache-warm.ts. */
  cacheWarm?: boolean
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Anthropic "routing" pattern: classify each item into one of `categories`
 * (enum-constrained control schema), then run the matching `actions[category]`
 * agent on it.
 *
 * Config errors throw synchronously at entry (empty/duplicate categories,
 * category without an action, maxItems < 1). Agent failures never throw —
 * failed items are dropped, counted in `stats.dropped`, and surfaced as
 * warnings.
 *
 * @example
 * ```ts
 * import { classifyAndAct } from '@workflow-toolbox/patterns'
 *
 * const result = await classifyAndAct(rt, {
 *   items: ['item-0', 'item-1'],
 *   categories: ['docs', 'bug', 'feature'],
 *   classifyPrompt: (item) => `classify this change: ${item}`,
 *   actions: {
 *     docs: { prompt: (item) => `update the docs for: ${item}` },
 *     bug: { prompt: (item) => `write a bug report for: ${item}` },
 *     feature: { prompt: (item) => `draft a feature spec for: ${item}` },
 *   },
 * })
 *
 * for (const { item, category, result: out } of result.value) {
 *   rt.log(`${item} → ${category}: ${out}`)
 * }
 * rt.log(`dropped ${result.stats.dropped} of ${result.stats.itemsIn}; warnings: ${result.warnings.length}`)
 * ```
 */
export async function classifyAndAct<TIn, TOut = string>(
  rt: WorkflowRuntime,
  options: ClassifyAndActOptions<TIn>,
): Promise<PatternResult<Array<{ item: TIn; category: string; result: TOut }>>> {
  const { items, categories, classifyPrompt, actions, classifyModel, classifyEffort, classifyType, phase, maxItems, cacheWarm } = options

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

  assertAgentTypeOption(STAGE, 'classifyType', classifyType)
  for (const [category, spec] of Object.entries(actions)) {
    assertAgentTypeOption(STAGE, `actions.${category}.agentType`, spec.agentType)
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

  // Pending per-item warnings (structured-output salvage diagnostics) accumulated
  // inside pipeline stage closures — buffered and emitted AFTER the pipeline
  // barrier, sorted like the trail, so the warnings array stays deterministic
  // despite concurrent per-item stages.
  const pendingWarnings: Array<{ itemIndex: number; stageOrder: number; message: string }> = []

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
      effort?: EffortAlias
      agentType?: string
    } = {
      schema: controlSchema,
      label: `${STAGE}:classify:${index}`,
      ...(phase !== undefined ? { phase } : {}),
      ...(classifyModel !== undefined ? { model: classifyModel } : {}),
      ...(classifyEffort !== undefined ? { effort: classifyEffort } : {}),
      ...(classifyType !== undefined ? { agentType: classifyType } : {}),
    }

    const classifyOut = await agentWithSchemaSalvage<{ category: string }>(rt, classifyPrompt(item), classifyOpts)
    agentsSpawned += classifyOut.spawns
    for (const message of classifyOut.warnings) pendingWarnings.push({ itemIndex: index, stageOrder: 0, message })
    if (classifyOut.spawns === 2) {
      // The salvage respawn is a real spawn — it gets its own trail record
      // (invariant: one record per agent spawned). stageOrder +0.5 slots it
      // right after this stage's main record in the deterministic sort.
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 0.5,
        record: makeRecord(`${STAGE}:classify:${index}:salvage`, classifyOut.salvaged, {
          ...(classifyModel !== undefined ? { model: classifyModel } : {}),
          ...(classifyEffort !== undefined ? { effort: classifyEffort } : {}),
        }),
      })
    }
    const classified = classifyOut.value

    if (classified === null) {
      classifyFailures++
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 0,
        record: makeRecord(`${STAGE}:classify:${index}`, false, {
          ...(classifyModel !== undefined ? { model: classifyModel } : {}),
          ...(classifyEffort !== undefined ? { effort: classifyEffort } : {}),
        }),
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
        record: makeRecord(`${STAGE}:classify:${index}`, false, {
          ...(classifyModel !== undefined ? { model: classifyModel } : {}),
          ...(classifyEffort !== undefined ? { effort: classifyEffort } : {}),
        }),
      })
      throw new Error(`classify returned unknown category "${classified.category}"`)
    }

    pendingTrail.push({
      itemIndex: index,
      stageOrder: 0,
      record: makeRecord(`${STAGE}:classify:${index}`, true, {
        ...(classifyModel !== undefined ? { model: classifyModel } : {}),
        ...(classifyEffort !== undefined ? { effort: classifyEffort } : {}),
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
      effort?: EffortAlias
      agentType?: string
    } = {
      label: `${STAGE}:act:${category}:${index}`,
      ...(phase !== undefined ? { phase } : {}),
      ...(spec.schema !== undefined ? { schema: spec.schema } : {}),
      ...(spec.model !== undefined ? { model: spec.model } : {}),
      ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
      ...(spec.agentType !== undefined ? { agentType: spec.agentType } : {}),
    }

    const actOut = await agentWithSchemaSalvage<TOut>(rt, spec.prompt(item), actOpts)
    agentsSpawned += actOut.spawns
    for (const message of actOut.warnings) pendingWarnings.push({ itemIndex: index, stageOrder: 1, message })
    if (actOut.spawns === 2) {
      // Salvage respawn trail record — see the classify stage's twin comment.
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 1.5,
        record: makeRecord(`${STAGE}:act:${category}:${index}:salvage`, actOut.salvaged, {
          ...(spec.model !== undefined ? { model: spec.model } : {}),
          ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
        }),
      })
    }
    const result = actOut.value

    if (result === null) {
      actionFailures++
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 1,
        record: makeRecord(`${STAGE}:act:${category}:${index}`, false, {
          ...(spec.model !== undefined ? { model: spec.model } : {}),
          ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
        }),
      })
      throw new Error('act returned null')
    }

    pendingTrail.push({
      itemIndex: index,
      stageOrder: 1,
      record: makeRecord(`${STAGE}:act:${category}:${index}`, true, {
        ...(spec.model !== undefined ? { model: spec.model } : {}),
        ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
      }),
    })

    return { item, category, result }
  }

  const rawResults = await pipelineWithCacheWarm(
    rt, kept as readonly unknown[], [classifyStage, actStage], cacheWarm ?? true,
  )

  // -------------------------------------------------------------------------
  // Collect non-null results
  // -------------------------------------------------------------------------

  const value = rawResults.filter(
    (r): r is { item: TIn; category: string; result: TOut } => r !== null,
  )

  // -------------------------------------------------------------------------
  // Post-pipeline warnings
  // -------------------------------------------------------------------------

  // Salvage diagnostics first, in deterministic (itemIndex, stageOrder) order.
  pendingWarnings.sort((a, b) =>
    a.itemIndex !== b.itemIndex ? a.itemIndex - b.itemIndex : a.stageOrder - b.stageOrder,
  )
  for (const entry of pendingWarnings) warn(rt, warnings, `${STAGE}: ${entry.message}`)

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

  // Phase digest: which categories were routed to (taken) vs which existed in the
  // classifier's enum but were never chosen (notTaken — the ghost branches).
  const allCategories = [...categories]
  const chosen = new Set(value.map(r => r.category))
  emitDigest(rt, {
    stage: STAGE,
    ...(phase !== undefined ? { phase } : {}),
    taken: allCategories.filter(c => chosen.has(c)),
    notTaken: allCategories.filter(c => !chosen.has(c)),
    counts: { in: items.length, out: value.length },
  })

  return { value, stats, warnings, trail }
}
