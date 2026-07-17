// score-and-rank.ts — cheap-model scoring + rank cutoff (the "targeting machine").
//
// Flow: scoreStage (items × dimensions, all independent) via rt.parallel()
//       → combine per item (pure) → rank → cutoff → ranked survivors.
//
// Motivation: aim an expensive resource (a premium model, human review, a
// downstream pattern) at only the highest-value items. A cheap model sweeps
// EVERY item and scores it on one or more INDEPENDENT dimensions; a pure
// combiner folds the dimensions into one number (default: product, i.e. the
// canonical impact × opportunity); a cutoff keeps the top of the ranked list.
//
// This pattern OWNS scoring + ranking + cutoff and STOPS there — it
// deliberately does NOT bundle the expensive downstream stage. The caller
// pipes the ranked survivors wherever they want (a premium-model pass, another
// pattern, or a human). Over-coupling the refinement stage would turn a
// composable pattern into a framework, and the source it is modelled on (the
// "build the targeting machine, then point the premium model at it" workflow)
// keeps the two acts separate for exactly that reason.
//
// Conventions (same as all patterns):
// - Config errors throw synchronously at entry.
// - Each (item, dimension) score is one independent cheap agent call; the
//   dimensions of one item run concurrently — "they happen independently
//   before the numbers are combined".
// - Fail-closed per ITEM: if ANY dimension score for an item is null (agent
//   error), the WHOLE item is dropped (counted in stats.dropped) — a partial
//   score would silently mis-rank it.
// - Cutoff-rejected items are a LEGITIMATE decision (like a pass=false in
//   generateAndFilter): logged live, NOT counted in dropped, NOT truncated.
//   Derivable: rejectedByCutoff = (itemsIn − truncated) − dropped − itemsOut.
// - opts.phase per-call, never rt.phase() (avoids global-state races).
// - Labels: scoreAndRank:score:<itemIndex>:<dimName>.

import type { WorkflowRuntime, JsonSchema, ModelAlias, EffortAlias } from '@workflow-toolbox/runtime'
import { warn, makeRecord, applyCap, emitDigest, assertAgentTypeOption } from './envelope.js'
import type { PatternResult, PatternStats, TrailRecord } from './envelope.js'
import { parallelWithCacheWarm } from './cache-warm.js'
import { agentWithSchemaSalvage } from './structured-salvage.js'
import { claimStageInstance, stageBuilder } from './stage-instance.js'

const STAGE = 'scoreAndRank'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScoreDimension<TItem> {
  /** Dimension name (e.g. 'impact', 'opportunity') — used in labels + trail.
   *  Keep it a short typed token: it appears in the agent label and the audit
   *  trail decision, never free prose. */
  name: string
  /** Prompt the cheap scoring agent for THIS item on THIS dimension. */
  prompt: (item: TItem) => string
  /** Per-dimension model override (defaults to the pattern-level scoreModel). */
  model?: ModelAlias
  /** Per-dimension reasoning effort override (defaults to the pattern-level scoreEffort). */
  effort?: EffortAlias
}

/** Keep rule applied to the ranked list. */
export type ScoreCutoff =
  | { type: 'threshold'; min: number }
  | { type: 'topK'; k: number }

export interface ScoredItem<TItem> {
  item: TItem
  /** Per-dimension raw scores, in `dimensions` order. */
  scores: number[]
  /** Combined score after combine() (default: product of `scores`). */
  score: number
}

export interface ScoreAndRankOptions<TItem> {
  items: readonly TItem[]
  dimensions: ReadonlyArray<ScoreDimension<TItem>>
  /** Default model for scoring agents — keep it cheap (e.g. 'haiku'/'sonnet').
   *  A dimension's own `model` overrides this. Omit to inherit the session model. */
  scoreModel?: ModelAlias
  /** Per-score reasoning effort. A dimension's own `effort` overrides this. Omit to inherit the session effort. */
  scoreEffort?: EffortAlias
  /** Subagent type (Agent tool `agentType`) to route the score agents
   *  through — e.g. 'codex:codex-rescue' / 'workflow-toolbox:opencode-verifier'
   *  for a cross-family model. Omit for the standard Claude subagent. */
  scoreType?: string
  /** Pure, deterministic fold of per-dimension scores → one number.
   *  Default: product (the canonical impact × opportunity). The default product
   *  assumes NON-NEGATIVE dimension scores (e.g. a 1–5 scale): on a signed scale
   *  two negatives multiply to a positive and rank a doubly-bad item top — pass
   *  your own `combine` for signed scores. MUST be pure — no agents, no clocks,
   *  no randomness (the sandbox bans the latter two). A non-finite result
   *  (NaN / ±Infinity, from any dimension or the fold) drops the item fail-closed
   *  rather than corrupting the rank. */
  combine?: (scores: number[]) => number
  /** Keep rule applied to the ranked list. */
  cutoff: ScoreCutoff
  /** Hard cap on how many items are scored at all (truncation reported in
   *  stats.truncated; the first `maxItems` items are kept, in input order). */
  maxItems?: number
  phase?: string
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
  /** Stagger the (item, dimension) score burst so the FIRST scoring agent
   *  completes (and writes the shared system/tools prefix to the provider's
   *  prompt cache) BEFORE the rest launch, instead of all of them writing
   *  that prefix redundantly at once. Deliberately model-agnostic (mechanism
   *  (a), not a warmup agent): dimensions can each override `scoreModel`, so
   *  the burst may already be multi-model — peeling out one of the REAL
   *  scoring calls (rather than a stand-in on a single guessed model) never
   *  risks warming the wrong cache entry. Heuristic cost lever, not a
   *  correctness change — costs +1 call's latency on the critical path.
   *  **Default true**; set `cacheWarm: false` to opt OUT when wall-clock
   *  latency matters more than token/cache cost. See
   *  @workflow-toolbox/patterns' cache-warm.ts. */
  cacheWarm?: boolean
}

// ---------------------------------------------------------------------------
// Scoring control schema — owned by the pattern.
// A numeric `score` is REQUIRED so combine()/ranking are always well-defined;
// `reason` is required for high-signal debugging (ACI discipline).
// ---------------------------------------------------------------------------

const scoreSchema: JsonSchema = {
  type: 'object',
  properties: {
    score: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['score', 'reason'],
  additionalProperties: false,
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Scores every item on one or more independent dimensions with a (cheap)
 * model, folds the dimensions into one number via a pure `combine` (default:
 * product), ranks descending, and applies a `threshold` or `topK` cutoff.
 * Returns the ranked survivors — the caller aims the expensive stage at them.
 *
 * @example
 * ```ts
 * import { scoreAndRank } from '@workflow-toolbox/patterns'
 * import { FakeRuntime } from '@workflow-toolbox/runtime'
 *
 * const rt = new FakeRuntime({
 *   onAgent: () => ({ score: 4, reason: 'high churn, high complexity' }),
 * })
 *
 * const result = await scoreAndRank(rt, {
 *   items: ['src/chat.ts', 'src/slack.ts', 'src/voice.ts'],
 *   scoreModel: 'haiku',
 *   dimensions: [
 *     { name: 'impact',      prompt: (f) => `Score 1-5 how far-reaching ${f} is` },
 *     { name: 'opportunity', prompt: (f) => `Score 1-5 how buggy/slow ${f} is` },
 *   ],
 *   // default combine = impact × opportunity
 *   cutoff: { type: 'topK', k: 2 },
 * })
 *
 * const targets = result.value // ScoredItem[] ranked desc — point the premium model here
 * ```
 */
export async function scoreAndRank<TItem = string>(
  rt: WorkflowRuntime,
  options: ScoreAndRankOptions<TItem>,
): Promise<PatternResult<ScoredItem<TItem>[]>> {
  const { items, dimensions, scoreModel, scoreEffort, scoreType, cutoff, maxItems, phase, stageKey, cacheWarm } = options
  const combine = options.combine ?? ((scores: number[]): number => scores.reduce((a, b) => a * b, 1))

  // -------------------------------------------------------------------------
  // Synchronous validation
  // -------------------------------------------------------------------------

  if (items.length < 1) {
    throw new Error(`scoreAndRank: items must be a non-empty array — got length ${items.length}`)
  }
  if (dimensions.length < 1) {
    throw new Error('scoreAndRank: dimensions must be a non-empty array — pass at least one ScoreDimension')
  }
  // Validate defensively (JS callers can pass a malformed cutoff) via a
  // string-typed view, so we never narrow `cutoff` away from its union here.
  const ct = cutoff as { type: string; min?: unknown; k?: unknown }
  if (ct.type === 'threshold') {
    if (!Number.isFinite(ct.min)) {
      throw new Error(`scoreAndRank: threshold cutoff needs a finite min, got ${String(ct.min)}`)
    }
  } else if (ct.type === 'topK') {
    const k = ct.k
    if (typeof k !== 'number' || !Number.isInteger(k) || k < 1) {
      throw new Error(`scoreAndRank: topK cutoff needs an integer k >= 1, got ${String(k)}`)
    }
  } else {
    throw new Error("scoreAndRank: cutoff must be { type: 'threshold', min } or { type: 'topK', k }")
  }

  assertAgentTypeOption(STAGE, 'scoreType', scoreType)

  // -------------------------------------------------------------------------
  // Mutable counters + truncation
  // -------------------------------------------------------------------------

  let agentsSpawned = 0
  let dropped = 0
  const warnings: string[] = []

  // applyCap throws synchronously when maxItems < 1
  const { kept: keptItems, truncated } = applyCap(items, maxItems)

  // Claim this invocation's stage/label salt NOW — after every synchronous
  // validation throw above and before the first await (card
  // #1816036725248493168, amendment A8).
  const { salt, warning: stageKeyWarning } = claimStageInstance(rt, STAGE, stageKey)
  if (stageKeyWarning !== undefined) warn(rt, warnings, stageKeyWarning)
  const stg = stageBuilder(STAGE, salt)

  // Pending trail entries; sorted by a deterministic global order after the
  // parallel barrier (parallel completion order is non-deterministic).
  // order +0.5 slots a structured-output salvage respawn's record right after
  // its score cell's main record.
  const pendingTrail: Array<{ order: number; record: TrailRecord }> = []

  // Pending salvage diagnostics — buffered and emitted after the barrier
  // (sorted like the trail) so `warnings` stays deterministic.
  const pendingWarnings: Array<{ order: number; message: string }> = []

  // -------------------------------------------------------------------------
  // Score stage — one independent agent per (item, dimension)
  // -------------------------------------------------------------------------

  type ScoreCell = { itemIndex: number; dimIndex: number; score: number }

  const tasks: Array<{ itemIndex: number; dimIndex: number }> = []
  for (let i = 0; i < keptItems.length; i++) {
    for (let d = 0; d < dimensions.length; d++) {
      tasks.push({ itemIndex: i, dimIndex: d })
    }
  }

  const thunks = tasks.map((t) => async (): Promise<ScoreCell | null> => {
    const dim = dimensions[t.dimIndex]
    const item = keptItems[t.itemIndex]
    // Indices are built from lengths above — these are unreachable, but the
    // guards satisfy noUncheckedIndexedAccess without a non-null assertion.
    if (dim === undefined || item === undefined) return null

    const model = dim.model ?? scoreModel
    const effort = dim.effort ?? scoreEffort
    const label = stg(`score:${t.itemIndex}:${dim.name}`)
    const opts: { schema: JsonSchema; label: string; phase?: string; model?: ModelAlias; effort?: EffortAlias; agentType?: string } = {
      schema: scoreSchema,
      label,
      ...(phase !== undefined ? { phase } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(scoreType !== undefined ? { agentType: scoreType } : {}),
    }

    const order = t.itemIndex * dimensions.length + t.dimIndex

    const scoreOut = await agentWithSchemaSalvage<{ score: number; reason: string }>(rt, dim.prompt(item), opts)
    agentsSpawned += scoreOut.spawns
    for (const message of scoreOut.warnings) pendingWarnings.push({ order, message })
    if (scoreOut.salvageAttempted) {
      pendingTrail.push({
        order: order + 0.5,
        record: makeRecord(`${label}:salvage`, scoreOut.salvaged, {
          ...(model !== undefined ? { model } : {}),
          ...(effort !== undefined ? { effort } : {}),
        }),
      })
    }
    const verdict = scoreOut.value

    if (verdict === null) {
      pendingTrail.push({
        order,
        record: makeRecord(label, false, {
          ...(model !== undefined ? { model } : {}),
          ...(effort !== undefined ? { effort } : {}),
        }),
      })
      return null
    }

    pendingTrail.push({
      order,
      record: makeRecord(label, true, {
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
        decision: `score=${verdict.score}`,
      }),
    })

    return { itemIndex: t.itemIndex, dimIndex: t.dimIndex, score: verdict.score }
  })

  const rawCells = await parallelWithCacheWarm(rt, thunks, cacheWarm ?? true)

  // -------------------------------------------------------------------------
  // Assemble per-item dimension scores
  // -------------------------------------------------------------------------

  const dimScores: Array<Array<number | null>> = keptItems.map(() => dimensions.map((): number | null => null))
  for (const cell of rawCells) {
    if (cell === null) continue
    const row = dimScores[cell.itemIndex]
    if (row !== undefined) row[cell.dimIndex] = cell.score
  }

  // Fail-closed per item: any null dimension → the item is un-rankable → drop.
  const scoredItems: Array<ScoredItem<TItem>> = []
  for (let i = 0; i < keptItems.length; i++) {
    const item = keptItems[i]
    const row = dimScores[i]
    if (item === undefined || row === undefined) continue
    if (row.some((s) => s === null)) {
      dropped++
      continue
    }
    const scores = row.filter((s): s is number => s !== null)
    const combined = combine(scores)
    // Fail-closed on a non-finite score too (NaN / ±Infinity), exactly like a
    // null dimension: a non-finite value makes the descending sort comparator
    // non-transitive (the item's final position becomes V8/input-order-defined →
    // breaks the replay-identical guarantee) AND slips an un-rankable item past
    // the cutoff (topK keeps by position; threshold mis-labels it a legitimate
    // "cut" rather than a failure). Drop it so it is counted + warned, never ranked.
    if (!scores.every((s) => Number.isFinite(s)) || !Number.isFinite(combined)) {
      dropped++
      continue
    }
    scoredItems.push({ item, scores: [...scores], score: combined })
  }

  // Salvage diagnostics first, in deterministic order.
  pendingWarnings.sort((a, b) => a.order - b.order)
  for (const entry of pendingWarnings) warn(rt, warnings, `${STAGE}: ${entry.message}`)

  if (dropped > 0) {
    warn(
      rt, warnings,
      `${STAGE}: ${dropped} of ${keptItems.length} items dropped (a dimension score was null or non-finite — fail-closed, item un-rankable)`,
    )
  }

  // -------------------------------------------------------------------------
  // Rank (desc by combined score; stable tie-break by pre-rank order)
  // -------------------------------------------------------------------------

  const ranked = scoredItems
    .map((si, idx) => ({ si, idx }))
    .sort((a, b) => (b.si.score - a.si.score) || (a.idx - b.idx))
    .map((x) => x.si)

  // -------------------------------------------------------------------------
  // Cutoff
  // -------------------------------------------------------------------------

  const survivors: Array<ScoredItem<TItem>> =
    cutoff.type === 'threshold'
      ? ranked.filter((s) => s.score >= cutoff.min)
      : ranked.slice(0, cutoff.k)

  // Cutoff rejections are the pattern WORKING (like a pass=false): logged live,
  // but NOT a warning (not degradation) and NOT counted in dropped/truncated.
  // The keep/cut decision is surfaced via this log + the digest counts + the
  // synthetic "rank + cutoff" topology gate — NOT a per-agent trail record,
  // because the cutoff is a synthetic step with no agent (same as
  // adversarialVerification's vote gate). The trail records the per-dimension
  // scores; which items were cut is derivable from those + the cutoff.
  const rejectedByCutoff = ranked.length - survivors.length
  if (rejectedByCutoff > 0) {
    rt.log(`${STAGE}: ${rejectedByCutoff} of ${ranked.length} ranked items cut by the ${cutoff.type} cutoff`)
  }

  if (truncated > 0) {
    warn(
      rt, warnings,
      `${STAGE}: ${truncated} of ${items.length} items not scored (maxItems cap)`,
    )
  }

  // -------------------------------------------------------------------------
  // Stats
  //   itemsIn   = items received (before the maxItems cap)
  //   truncated = items omitted by the cap
  //   dropped   = scored items with a failed (null) dimension
  //   itemsOut  = survivors after the cutoff
  //   rejectedByCutoff is DERIVABLE: (itemsIn − truncated) − dropped − itemsOut
  // -------------------------------------------------------------------------

  const stats: PatternStats = {
    itemsIn: items.length,
    itemsOut: survivors.length,
    agentsSpawned,
    dropped,
    truncated,
  }

  // Deterministic trail order (parallel completion order is not stable).
  pendingTrail.sort((a, b) => a.order - b.order)
  const trail: TrailRecord[] = pendingTrail.map((e) => e.record)

  // Phase digest: the triage funnel. `requested` (= itemsIn) partitions exactly
  // into truncated + dropped + cut + kept — received → (capped) → (un-rankable)
  // → (below cutoff) → survivors.
  emitDigest(rt, {
    stage: STAGE,
    ...(phase !== undefined ? { phase } : {}),
    counts: {
      requested: items.length,
      kept: survivors.length,
      cut: rejectedByCutoff,
      dropped,
      truncated,
    },
  })

  return { value: survivors, stats, warnings, trail }
}
