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

import type { WorkflowRuntime, JsonSchema, ModelAlias } from '@dwt/runtime'
import { warn, makeRecord } from './envelope.js'
import type { PatternResult, PatternStats, TrailRecord } from './envelope.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerateAndFilterOptions<TCand> {
  count: number
  /** Vary by index for diversity (sandbox bans randomness). */
  generatePrompt: (index: number) => string
  generateSchema?: JsonSchema
  generateModel?: ModelAlias
  filterPrompt: (candidate: TCand) => string
  filterModel?: ModelAlias
  phase?: string
}

// ---------------------------------------------------------------------------
// Module-level sentinel for "filter returned pass=false"
// A unique symbol ensures no candidate value can ever equal it.
// ---------------------------------------------------------------------------

const REJECTED: unique symbol = Symbol('generate-and-filter:REJECTED')

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function generateAndFilter<TCand = string>(
  rt: WorkflowRuntime,
  options: GenerateAndFilterOptions<TCand>,
): Promise<PatternResult<TCand[]>> {
  const { count, generatePrompt, generateSchema, generateModel, filterPrompt, filterModel, phase } = options

  // -------------------------------------------------------------------------
  // Synchronous validation
  // -------------------------------------------------------------------------

  if (count < 1) {
    throw new Error(
      `generateAndFilter: count must be >= 1, got ${count} — set count to a positive integer`,
    )
  }

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
    } = {
      label: `generateAndFilter:generate:${index}`,
      ...(phase !== undefined ? { phase } : {}),
      ...(generateSchema !== undefined ? { schema: generateSchema } : {}),
      ...(generateModel !== undefined ? { model: generateModel } : {}),
    }

    agentsSpawned++
    const candidate = await rt.agent<TCand>(generatePrompt(index), genOpts)

    if (candidate === null) {
      generateFailures++
      pendingTrail.push({
        itemIndex: index,
        stageOrder: 0,
        record: makeRecord(`generateAndFilter:generate:${index}`, false, generateModel !== undefined ? { model: generateModel } : undefined),
      })
      throw new Error('generate returned null')
    }

    pendingTrail.push({
      itemIndex: index,
      stageOrder: 0,
      record: makeRecord(`generateAndFilter:generate:${index}`, true, generateModel !== undefined ? { model: generateModel } : undefined),
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
    } = {
      schema: filterSchema,
      label: `generateAndFilter:filter:${index}`,
      ...(phase !== undefined ? { phase } : {}),
      ...(filterModel !== undefined ? { model: filterModel } : {}),
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
        record: makeRecord(`generateAndFilter:filter:${index}`, false, filterModel !== undefined ? { model: filterModel } : undefined),
      })
      throw new Error('filter returned null')
    }

    // decision = 'pass' or 'fail' — typed control value, not free prose
    pendingTrail.push({
      itemIndex: index,
      stageOrder: 1,
      record: makeRecord(`generateAndFilter:filter:${index}`, true, {
        ...(filterModel !== undefined ? { model: filterModel } : {}),
        decision: verdict.pass ? 'pass' : 'fail',
      }),
    })

    if (!verdict.pass) {
      return REJECTED
    }

    return candidate
  }

  const indices: readonly number[] = Array.from({ length: count }, (_, i) => i)
  const rawResults = await rt.pipeline(indices as readonly unknown[], generateStage, filterStage)

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

  return { value, stats, warnings, trail }
}
