// generate-and-filter.ts — generation + single-pass evaluator pattern.
//
// Flow: generateStage → filterStage via rt.pipeline().
//
// Conventions (same as all patterns):
// - Config errors throw synchronously at entry.
// - Agent failures degrade (counted as dropped), never throw out.
// - Filter is fail-closed: a null filter result excludes the candidate.
//   Rationale: the filter exists because unfiltered candidates are noise;
//   admitting on error would defeat the filter's purpose.
// - pass=false results are excluded but NOT counted as dropped —
//   they are successful filter decisions; derivable = itemsIn − itemsOut − dropped.
// - opts.phase per-call, never rt.phase() (avoids global-state races).
// - Labels: generateAndFilter:<stage>:<index>.

import type { WorkflowRuntime, JsonSchema, ModelAlias, EffortAlias } from '@workflow-toolbox/runtime'
import { warn, makeRecord, emitDigest, assertAgentTypeOption } from './envelope.js'
import type { PatternResult, PatternStats, TrailRecord } from './envelope.js'
import { pipelineWithCacheWarm } from './cache-warm.js'

const STAGE = 'generateAndFilter'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerateAndFilterOptions<TCand> {
  count: number
  /** Vary by index for diversity (sandbox bans randomness). */
  generatePrompt: (index: number) => string
  generateSchema?: JsonSchema
  generateModel?: ModelAlias
  /** Per-generate reasoning effort. Omit to inherit the session effort. */
  generateEffort?: EffortAlias
  /** Subagent type (Agent tool `agentType`) to route the generate agents
   *  through — e.g. 'codex:codex-rescue' / 'workflow-toolbox:opencode-verifier'
   *  for a cross-family model. Omit for the standard Claude subagent. */
  generateType?: string
  filterPrompt: (candidate: TCand) => string
  filterModel?: ModelAlias
  /** Per-filter reasoning effort. Omit to inherit the session effort. */
  filterEffort?: EffortAlias
  /** Subagent type (Agent tool `agentType`) to route the filter agents
   *  through — e.g. 'codex:codex-rescue' / 'workflow-toolbox:opencode-verifier'
   *  for a cross-family model. Omit for the standard Claude subagent. */
  filterType?: string
  phase?: string
  /** Stagger the per-candidate pipeline so candidate 0's generate call
   *  completes (and writes the shared system/tools prefix to the provider's
   *  prompt cache) BEFORE the remaining candidates' generate calls launch,
   *  instead of all N writing that prefix redundantly at once (rt.pipeline
   *  runs every item's first stage concurrently, with no barrier between
   *  stages). Heuristic cost lever, not a correctness change — costs +1
   *  candidate's latency on the critical path. **Default true**; set
   *  `cacheWarm: false` to opt OUT when wall-clock latency matters more than
   *  token/cache cost. See @workflow-toolbox/patterns' cache-warm.ts. */
  cacheWarm?: boolean
}

// ---------------------------------------------------------------------------
// Module-level sentinel for "filter returned pass=false"
// A unique symbol ensures no candidate value can ever equal it.
// ---------------------------------------------------------------------------

const REJECTED: unique symbol = Symbol('generate-and-filter:REJECTED')

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Generates `count` candidates via index-varied prompts, then filters each
 * with a pass/reason verdict agent. The filter is fail-closed: a degraded
 * (null) filter agent drops its candidate, counted in `stats.dropped`;
 * pass=false rejections are the filter working and are NOT dropped.
 *
 * @example
 * ```ts
 * import { generateAndFilter } from '@workflow-toolbox/patterns'
 * import { FakeRuntime } from '@workflow-toolbox/runtime'
 *
 * // Filter agents answer the pattern-owned { pass, reason } control schema;
 * // generate agents return the candidate itself. Discriminate by label.
 * const rt = new FakeRuntime({
 *   onAgent: ({ opts }) =>
 *     opts?.label?.startsWith('generateAndFilter:filter')
 *       ? { pass: true, reason: 'ok' }
 *       : 'a-candidate',
 * })
 *
 * const result = await generateAndFilter(rt, {
 *   count: 3,
 *   // The index is the ONLY diversity lever — the sandbox bans randomness.
 *   generatePrompt: (index) => `Generate candidate slogan #${index}`,
 *   filterPrompt: (candidate) => `Does this slogan fit the brief? ${candidate}`,
 * })
 *
 * const survivors = result.value // TCand[] — candidates that passed
 * const { itemsIn, itemsOut, agentsSpawned, dropped, truncated } = result.stats
 * // pass=false rejections are not in stats — derive them:
 * const rejected = itemsIn - itemsOut - dropped
 * if (result.warnings.length > 0) rt.log(result.warnings.join('; '))
 * ```
 */
export async function generateAndFilter<TCand = string>(
  rt: WorkflowRuntime,
  options: GenerateAndFilterOptions<TCand>,
): Promise<PatternResult<TCand[]>> {
  const { count, generatePrompt, generateSchema, generateModel, generateEffort, generateType, filterPrompt, filterModel, filterEffort, filterType, phase, cacheWarm } = options

  // -------------------------------------------------------------------------
  // Synchronous validation
  // -------------------------------------------------------------------------

  if (count < 1) {
    throw new Error(
      `generateAndFilter: count must be >= 1, got ${count} — set count to a positive integer`,
    )
  }

  assertAgentTypeOption(STAGE, 'generateType', generateType)
  assertAgentTypeOption(STAGE, 'filterType', filterType)

  // -------------------------------------------------------------------------
  // Mutable counters
  // -------------------------------------------------------------------------

  let agentsSpawned = 0
  let generateFailures = 0
  let filterFailures = 0
  const warnings: string[] = []

  // Pending trail entries accumulated inside pipeline stage closures.
  // Each entry carries (itemIndex, stageOrder) for deterministic sort after the pipeline barrier.
  // stageOrder: 0 = generate, 1 = filter (within the same item).
  const pendingTrail: Array<{ itemIndex: number; stageOrder: number; record: TrailRecord }> = []

  // -------------------------------------------------------------------------
  // Filter control schema — owned by the pattern.
  // reason is required for high-signal debugging (§7 ACI discipline).
  // -------------------------------------------------------------------------

  const filterSchema: JsonSchema = {
    type: 'object',
    properties: {
      pass: { type: 'boolean' },
      reason: { type: 'string' },
    },
    required: ['pass', 'reason'],
    additionalProperties: false,
  }

  // -------------------------------------------------------------------------
  // Pipeline stages over indices [0 .. count-1]
  // -------------------------------------------------------------------------

  const generateStage = async (
    _prev: unknown,
    _originalItem: unknown,
    index: number,
  ): Promise<TCand> => {
    const genOpts: {
      label: string
      phase?: string
      schema?: JsonSchema
      model?: ModelAlias
      effort?: EffortAlias
      agentType?: string
    } = {
      label: `${STAGE}:generate:${index}`,
      ...(phase !== undefined ? { phase } : {}),
      ...(generateSchema !== undefined ? { schema: generateSchema } : {}),
      ...(generateModel !== undefined ? { model: generateModel } : {}),
      ...(generateEffort !== undefined ? { effort: generateEffort } : {}),
      ...(generateType !== undefined ? { agentType: generateType } : {}),
    }

    agentsSpawned++
    const candidate = await rt.agent<TCand>(generatePrompt(index), genOpts)

    if (candidate === null) {
      generateFailures++
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 0,
        record: makeRecord(`${STAGE}:generate:${index}`, false, {
          ...(generateModel !== undefined ? { model: generateModel } : {}),
          ...(generateEffort !== undefined ? { effort: generateEffort } : {}),
        }),
      })
      throw new Error('generate returned null')
    }

    pendingTrail.push({
      itemIndex: index,
      stageOrder: 0,
      record: makeRecord(`${STAGE}:generate:${index}`, true, {
        ...(generateModel !== undefined ? { model: generateModel } : {}),
        ...(generateEffort !== undefined ? { effort: generateEffort } : {}),
      }),
    })

    return candidate
  }

  const filterStage = async (
    prev: unknown,
    _originalItem: unknown,
    index: number,
  ): Promise<TCand | typeof REJECTED> => {
    const candidate = prev as TCand

    const filterOpts: {
      schema: JsonSchema
      label: string
      phase?: string
      model?: ModelAlias
      effort?: EffortAlias
      agentType?: string
    } = {
      schema: filterSchema,
      label: `${STAGE}:filter:${index}`,
      ...(phase !== undefined ? { phase } : {}),
      ...(filterModel !== undefined ? { model: filterModel } : {}),
      ...(filterEffort !== undefined ? { effort: filterEffort } : {}),
      ...(filterType !== undefined ? { agentType: filterType } : {}),
    }

    agentsSpawned++
    const verdict = await rt.agent<{ pass: boolean; reason: string }>(
      filterPrompt(candidate),
      filterOpts,
    )

    if (verdict === null) {
      // Fail-closed: a failed filter does NOT admit the candidate.
      // The filter exists because unfiltered candidates are noise;
      // admit-on-error would defeat it.
      filterFailures++
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 1,
        record: makeRecord(`${STAGE}:filter:${index}`, false, {
          ...(filterModel !== undefined ? { model: filterModel } : {}),
          ...(filterEffort !== undefined ? { effort: filterEffort } : {}),
        }),
      })
      throw new Error('filter returned null')
    }

    // decision = 'pass' or 'fail' — typed control value, not free prose
    pendingTrail.push({
      itemIndex: index,
      stageOrder: 1,
      record: makeRecord(`${STAGE}:filter:${index}`, true, {
        ...(filterModel !== undefined ? { model: filterModel } : {}),
        ...(filterEffort !== undefined ? { effort: filterEffort } : {}),
        decision: verdict.pass ? 'pass' : 'fail',
      }),
    })

    if (!verdict.pass) {
      return REJECTED
    }

    return candidate
  }

  const indices: readonly number[] = Array.from({ length: count }, (_, i) => i)
  const rawResults = await pipelineWithCacheWarm(
    rt, indices as readonly unknown[], [generateStage, filterStage], cacheWarm ?? true,
  )

  // -------------------------------------------------------------------------
  // Collect results: exclude nulls (drops) and REJECTED sentinels
  // -------------------------------------------------------------------------

  const value: TCand[] = []
  for (const r of rawResults) {
    if (r !== null && r !== REJECTED) {
      value.push(r as TCand)
    }
  }

  // -------------------------------------------------------------------------
  // Post-pipeline warnings
  // -------------------------------------------------------------------------

  if (generateFailures > 0) {
    warn(
      rt, warnings,
      `generateAndFilter: ${generateFailures} of ${count} candidates failed generation`,
    )
  }

  if (filterFailures > 0) {
    warn(
      rt, warnings,
      `generateAndFilter: ${filterFailures} candidates failed filtering (excluded — fail-closed)`,
    )
  }

  // Rejections (pass=false) are a LEGITIMATE outcome — the filter doing its
  // job — so they are logged for live visibility but NOT added to warnings
  // (warnings are for degradation) and NOT counted in dropped (losses only).
  // Derivable from the envelope: rejected = itemsIn − itemsOut − dropped.
  const rejected = count - value.length - (generateFailures + filterFailures)
  if (rejected > 0) {
    rt.log(`generateAndFilter: ${rejected} of ${count} candidates rejected by filter`)
  }

  // -------------------------------------------------------------------------
  // Stats
  // dropped = generate + filter null failures only (not pass=false rejections)
  // -------------------------------------------------------------------------

  const stats: PatternStats = {
    itemsIn: count,
    itemsOut: value.length,
    agentsSpawned,
    dropped: generateFailures + filterFailures,
    truncated: 0,
  }

  // Sort trail records by (itemIndex, stageOrder) for deterministic order.
  // rt.pipeline stages run per-item without a barrier, so completion order is non-deterministic;
  // we sort after the pipeline barrier to guarantee stable output across runs.
  pendingTrail.sort((a, b) =>
    a.itemIndex !== b.itemIndex ? a.itemIndex - b.itemIndex : a.stageOrder - b.stageOrder,
  )
  const trail: TrailRecord[] = pendingTrail.map(e => e.record)

  // Phase digest: the filter's selectivity — generated vs kept vs rejected
  // (pass=false) vs failed (null generate/filter calls).
  // `requested` is the configured count (itemsIn), NOT the number actually produced
  // (= requested − failed); the breakdown is requested = kept + rejected + failed.
  emitDigest(rt, {
    stage: STAGE,
    ...(phase !== undefined ? { phase } : {}),
    counts: {
      requested: count,
      kept: value.length,
      rejected: Math.max(0, rejected),
      failed: generateFailures + filterFailures,
    },
  })

  return { value, stats, warnings, trail }
}
