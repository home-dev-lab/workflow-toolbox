// tournament.ts — judge panel + synthesis (parallel attempts → ranked → winner).
//
// Flow: rt.parallel(attempt agents) → per-surviving-attempt judge panel
//       → median score in code → sort DESC → synthesis over ranked list.
//
// Why a tournament: when you need to compare multiple independently-generated
//   attempts and select/synthesize the best one. Two or more angles are
//   required by definition (one attempt is not a tournament — use a simpler
//   pattern for single-attempt evaluation).
//
// The ranked list passed to synthesisPrompt is winner-first, so synthesis
// can graft context onto the winner while runners-up are available for
// comparison or alternative-strategy reasoning.
//
// Conventions (same as all patterns):
// - Config errors throw synchronously at entry.
// - Agent failures degrade (dropped), never throw out.
// - Median computed in code, deterministically (not by model).
// - Labels: tournament:attempt:<i>, tournament:judge:<attemptIdx>:<judgeIdx>,
//           tournament:synthesize.

import type { WorkflowRuntime, JsonSchema, ModelAlias, EffortAlias } from '@workflow-toolbox/runtime'
import { warn, makeRecord, emitDigest, assertAgentTypeOption } from './envelope.js'
import type { PatternResult, PatternStats, TrailRecord } from './envelope.js'
import { runCacheWarmup } from './cache-warm.js'

const STAGE = 'tournament'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RankedAttempt<TAttempt> {
  attempt: TAttempt
  angle: string
  score: number
  /** The original attempt index (0-based, from the angles array). Used in the audit trail. */
  originalIndex?: number
}

export interface TournamentOptions<TAttempt> {
  angles: readonly string[]   // >= 2 (one attempt is not a tournament — throw)
  attemptPrompt: (angle: string, index: number) => string
  attemptSchema?: JsonSchema
  attemptModel?: ModelAlias
  /** Per-attempt reasoning effort. Omit to inherit the session effort. */
  attemptEffort?: EffortAlias
  /** Subagent type (Agent tool `agentType`) to route the attempt agents
   *  through — e.g. 'codex:codex-rescue' / 'workflow-toolbox:opencode-verifier'
   *  for a cross-family model. Omit for the standard Claude subagent. */
  attemptType?: string
  judgeCount?: number         // default 3, >= 1
  judgePrompt: (attempt: TAttempt) => string
  judgeModel?: ModelAlias
  /** Per-judge reasoning effort. Omit to inherit the session effort. */
  judgeEffort?: EffortAlias
  /** Subagent type (Agent tool `agentType`) to route the judge agents
   *  through — e.g. 'codex:codex-rescue' / 'workflow-toolbox:opencode-verifier'
   *  for a cross-family model. Omit for the standard Claude subagent. */
  judgeType?: string
  synthesisPrompt: (ranked: ReadonlyArray<RankedAttempt<TAttempt>>) => string
  synthesisSchema?: JsonSchema
  synthesisModel?: ModelAlias
  /** Per-synthesis reasoning effort. Omit to inherit the session effort. */
  synthesisEffort?: EffortAlias
  /** Subagent type (Agent tool `agentType`) to route the synthesis agent
   *  through — e.g. 'codex:codex-rescue' / 'workflow-toolbox:opencode-verifier'
   *  for a cross-family model. Omit for the standard Claude subagent. */
  synthesisType?: string
  phase?: string
  /** Before EACH concurrent burst (the attempts stage, then — after attempts
   *  are known — the judges stage), fire a single throwaway warmup agent on
   *  that stage's own uniform model (attemptModel / judgeModel), await it,
   *  THEN launch the full burst — mechanism (b), "warmup-agent", chosen here
   *  (over peeling out one real attempt/judge) so every real attempt and
   *  judge stays fully concurrent: angles/judgeCount are typically small
   *  (judgeCount defaults to 3), and losing one real slot to serial execution
   *  would cost proportionally more than elsewhere. A failed/null warmup only
   *  warns; the real burst always proceeds. Heuristic cost lever, not a
   *  correctness change. **Default true**; set `cacheWarm: false` to opt OUT
   *  when wall-clock latency matters more than token/cache cost. See
   *  @workflow-toolbox/patterns' cache-warm.ts. */
  cacheWarm?: boolean
}

// ---------------------------------------------------------------------------
// Judge control schema — owned by the pattern.
// Scores [0..10] with a required reason for high-signal debugging.
// ---------------------------------------------------------------------------

const JUDGE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    score: { type: 'number', minimum: 0, maximum: 10 },
    reason: { type: 'string' },
  },
  required: ['score', 'reason'],
  additionalProperties: false,
}

// ---------------------------------------------------------------------------
// Median helper — deterministic, no randomness.
//
// Sort non-null scores ascending:
// - odd count  → middle element (exact integer index)
// - even count → mean of the two middle values
//
// Returns null when scores array is empty (caller handles).
// ---------------------------------------------------------------------------

function median(scores: number[]): number | null {
  const sorted = [...scores].sort((a, b) => a - b)
  const upper = sorted[Math.floor(sorted.length / 2)]
  if (upper === undefined) return null // empty input
  if (sorted.length % 2 === 1) {
    // Odd count: exact middle
    return upper
  }
  // Even count: average of the two middle values. `lower` cannot be undefined
  // for a non-empty even-length array; the guard keeps the index access honest
  // under noUncheckedIndexedAccess (treated as empty if ever reached).
  const lower = sorted[sorted.length / 2 - 1]
  return lower === undefined ? null : (lower + upper) / 2
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Generate attempts from >= 2 unique angles in parallel, score each surviving
 * attempt with a judge panel (median computed in code, never by the model),
 * then synthesize over the winner-first ranked list.
 *
 * Throws synchronously on config errors (< 2 angles, duplicate angles,
 * judgeCount < 1). Agent failures degrade: null attempts and unjudgeable
 * attempts are dropped, never thrown. `value` is null when all attempts fail,
 * the ranking is empty, or the synthesis agent returns null — always check it.
 *
 * Stats: itemsIn = angles.length; itemsOut = ranked attempts (NOT the
 * synthesis product); dropped = null attempts + attempts with zero judge votes.
 *
 * @example
 * ```ts
 * const result = await tournament(rt, {
 *   angles: ['angle-0', 'angle-1', 'angle-2'],
 *   attemptPrompt: (angle, i) => `attempt ${i}: ${angle}`,
 *   judgePrompt: (attempt) => `judge: ${attempt}`,
 *   synthesisPrompt: (ranked) => `synthesize: ${ranked.map(r => r.attempt).join(', ')}`,
 * })
 *
 * if (result.value === null) {
 *   // All attempts failed, ranking was empty, or synthesis returned null.
 *   rt.log(`tournament produced no value: ${result.warnings.join('; ')}`)
 * } else {
 *   rt.log(`winner-synthesis from ${result.stats.itemsOut} ranked attempts: ${result.value}`)
 * }
 * ```
 */
export async function tournament<TAttempt = string, TOut = string>(
  rt: WorkflowRuntime,
  options: TournamentOptions<TAttempt>,
): Promise<PatternResult<TOut | null>> {
  const {
    angles,
    attemptPrompt,
    attemptSchema,
    attemptModel,
    attemptEffort,
    attemptType,
    judgeCount: judgeCountOpt = 3,
    judgePrompt,
    judgeModel,
    judgeEffort,
    judgeType,
    synthesisPrompt,
    synthesisSchema,
    synthesisModel,
    synthesisEffort,
    synthesisType,
    phase,
    cacheWarm,
  } = options

  // -------------------------------------------------------------------------
  // Synchronous validation
  // -------------------------------------------------------------------------

  if (angles.length < 2) {
    throw new Error(
      `tournament: angles must have >= 2 entries (got ${angles.length}) — one attempt is not a tournament`,
    )
  }

  const seenAngles = new Set<string>()
  for (const angle of angles) {
    if (seenAngles.has(angle)) {
      throw new Error(
        `tournament: duplicate angle "${angle}" — each angle must appear exactly once`,
      )
    }
    seenAngles.add(angle)
  }

  if (judgeCountOpt < 1) {
    throw new Error(
      `tournament: judgeCount must be >= 1, got ${judgeCountOpt}`,
    )
  }

  assertAgentTypeOption(STAGE, 'attemptType', attemptType)
  assertAgentTypeOption(STAGE, 'judgeType', judgeType)
  assertAgentTypeOption(STAGE, 'synthesisType', synthesisType)

  // -------------------------------------------------------------------------
  // Mutable counters
  // -------------------------------------------------------------------------

  let agentsSpawned = 0
  let droppedAttempts = 0
  let nullJudgeVoteCount = 0
  const warnings: string[] = []
  const trail: TrailRecord[] = []

  // -------------------------------------------------------------------------
  // Stage 1 — Attempts: rt.parallel over angles
  // -------------------------------------------------------------------------

  // Cache-warm (mechanism b): one throwaway agent on attemptModel/attemptType,
  // awaited BEFORE the attempts burst launches. Label is `${STAGE}:warm:
  // attempt` — deliberately NOT nested under `:attempt:` so a caller
  // filtering real attempts by `startsWith('tournament:attempt:')` never
  // sweeps the warmup call in.
  if (cacheWarm ?? true) {
    agentsSpawned++
    trail.push(await runCacheWarmup(rt, warnings, `${STAGE}:warm:attempt`, STAGE, {
      ...(phase !== undefined ? { phase } : {}),
      ...(attemptModel !== undefined ? { model: attemptModel } : {}),
      ...(attemptEffort !== undefined ? { effort: attemptEffort } : {}),
      ...(attemptType !== undefined ? { agentType: attemptType } : {}),
    }))
  }

  const attemptThunks = angles.map((angle, i) => async (): Promise<TAttempt | null> => {
    const opts: {
      label: string
      phase?: string
      schema?: JsonSchema
      model?: ModelAlias
      effort?: EffortAlias
      agentType?: string
    } = {
      label: `${STAGE}:attempt:${i}`,
      ...(phase !== undefined ? { phase } : {}),
      ...(attemptSchema !== undefined ? { schema: attemptSchema } : {}),
      ...(attemptModel !== undefined ? { model: attemptModel } : {}),
      ...(attemptEffort !== undefined ? { effort: attemptEffort } : {}),
      ...(attemptType !== undefined ? { agentType: attemptType } : {}),
    }

    agentsSpawned++
    return rt.agent<TAttempt>(attemptPrompt(angle, i), opts)
  })

  const attemptResults = await rt.parallel(attemptThunks)

  // Collect surviving attempts with their angle mapping.
  // Build attempt trail records in index order after the parallel barrier
  // (determinism: never completion order).
  const survivingAttempts: Array<{ attempt: TAttempt; angle: string; originalIndex: number }> = []

  for (let i = 0; i < attemptResults.length; i++) {
    const attempt = attemptResults[i]
    trail.push(makeRecord(`${STAGE}:attempt:${i}`, attempt !== null, {
      ...(attemptModel !== undefined ? { model: attemptModel } : {}),
      ...(attemptEffort !== undefined ? { effort: attemptEffort } : {}),
    }))

    if (attempt !== null) {
      survivingAttempts.push({ attempt: attempt as TAttempt, angle: angles[i]!, originalIndex: i })
    } else {
      droppedAttempts++
    }
  }

  if (droppedAttempts > 0) {
    warn(
      rt, warnings,
      `tournament: ${droppedAttempts} of ${angles.length} attempts returned null`,
    )
  }

  // Short-circuit: all attempts failed
  if (survivingAttempts.length === 0) {
    warn(rt, warnings, 'tournament: all attempts failed; nothing to judge')

    const stats: PatternStats = {
      itemsIn: angles.length,
      itemsOut: 0,
      agentsSpawned,
      dropped: droppedAttempts,
      truncated: 0,
    }

    // Failure digest: the run reached this phase but no attempt survived to ranking.
    emitDigest(rt, { stage: STAGE, counts: { attempts: 0 } })
    return { value: null, stats, warnings, trail }
  }

  // -------------------------------------------------------------------------
  // Stage 2 — Judging: per surviving attempt, judgeCount parallel judges.
  // Median computed in code — deterministic, never delegated to the model.
  // -------------------------------------------------------------------------

  const ranked: Array<RankedAttempt<TAttempt>> = []
  let unjudgeableCount = 0

  // Cache-warm (mechanism b): one throwaway agent on judgeModel/judgeType,
  // awaited BEFORE the (potentially many, per-attempt) judge panels launch —
  // a single warm covers the whole judges stage since every panel shares the
  // same judgeModel. Label is `${STAGE}:warm:judge` — deliberately NOT nested
  // under `:judge:` so a caller filtering real judges by
  // `startsWith('tournament:judge:')` never sweeps the warmup call in.
  if (cacheWarm ?? true) {
    agentsSpawned++
    trail.push(await runCacheWarmup(rt, warnings, `${STAGE}:warm:judge`, STAGE, {
      ...(phase !== undefined ? { phase } : {}),
      ...(judgeModel !== undefined ? { model: judgeModel } : {}),
      ...(judgeEffort !== undefined ? { effort: judgeEffort } : {}),
      ...(judgeType !== undefined ? { agentType: judgeType } : {}),
    }))
  }

  // Judge ALL surviving attempts concurrently — each attempt gets its own
  // judge panel (rt.parallel); panels must not serialize across attempts
  // (same shape as adversarialVerification's per-claim processing). The
  // runtime caps global concurrency itself; serializing here would multiply
  // wall-clock by the number of attempts for no benefit.
  const panels = await Promise.all(
    survivingAttempts.map(({ attempt, originalIndex }) => {
      const judgeThunks = Array.from({ length: judgeCountOpt }, (_: unknown, judgeIndex: number) => {
        return async (): Promise<{ score: number; reason: string } | null> => {
          const opts: {
            schema: JsonSchema
            label: string
            phase?: string
            model?: ModelAlias
            effort?: EffortAlias
            agentType?: string
          } = {
            schema: JUDGE_SCHEMA,
            label: `${STAGE}:judge:${originalIndex}:${judgeIndex}`,
            ...(phase !== undefined ? { phase } : {}),
            ...(judgeModel !== undefined ? { model: judgeModel } : {}),
            ...(judgeEffort !== undefined ? { effort: judgeEffort } : {}),
            ...(judgeType !== undefined ? { agentType: judgeType } : {}),
          }

          agentsSpawned++
          return rt.agent<{ score: number; reason: string }>(judgePrompt(attempt), opts)
        }
      })

      return rt.parallel(judgeThunks)
    }),
  )

  // Tally sequentially AFTER the barrier — scores are pure data at this
  // point, and sequential tallying keeps warning order deterministic.
  // Build judge trail records in index order over the full index space
  // (including null results — never completion order).
  survivingAttempts.forEach(({ attempt, angle, originalIndex }, i) => {
    const judgeResults = panels[i] ?? []

    for (let judgeIndex = 0; judgeIndex < judgeResults.length; judgeIndex++) {
      const judgeResult = judgeResults[judgeIndex] ?? null
      trail.push(makeRecord(`${STAGE}:judge:${originalIndex}:${judgeIndex}`, judgeResult !== null, {
        ...(judgeModel !== undefined ? { model: judgeModel } : {}),
        ...(judgeEffort !== undefined ? { effort: judgeEffort } : {}),
        ...(judgeResult !== null ? { decision: `score=${judgeResult.score}` } : {}),
      }))
    }

    const validScores = judgeResults
      .filter((r): r is { score: number; reason: string } => r !== null)
      .map(r => r.score)

    nullJudgeVoteCount += judgeResults.filter(r => r === null).length

    const medianScore = median(validScores)

    if (medianScore === null) {
      // Zero non-null judge votes — cannot rank this attempt
      unjudgeableCount++
      warn(
        rt, warnings,
        `tournament: attempt for angle "${angle}" received no judge votes — excluded from ranking`,
      )
    } else {
      ranked.push({ attempt, angle, score: medianScore, originalIndex })
    }
  })

  if (nullJudgeVoteCount > 0) {
    warn(
      rt, warnings,
      `tournament: ${nullJudgeVoteCount} judge votes returned null`,
    )
  }

  // Short-circuit: ranking is empty
  if (ranked.length === 0) {
    warn(rt, warnings, 'tournament: empty ranking after judging; synthesis skipped')

    const stats: PatternStats = {
      itemsIn: angles.length,
      itemsOut: 0,
      agentsSpawned,
      // dropped = null attempts + unjudgeable attempts (lost work units = attempts)
      // null judge votes are NOT counted in dropped — the attempt survived via median of rest
      dropped: droppedAttempts + unjudgeableCount,
      truncated: 0,
    }

    // Failure digest: attempts ran but none were judgeable — no winner to rank.
    emitDigest(rt, { stage: STAGE, counts: { attempts: 0 } })
    return { value: null, stats, warnings, trail }
  }

  // -------------------------------------------------------------------------
  // Sort ranked list by score DESC — stable: ties preserve original angle order.
  // JavaScript's Array.sort is stable since ES2019.
  // Winner is first — synthesis can graft context onto the best attempt while
  // runners-up remain available for comparison reasoning.
  // -------------------------------------------------------------------------

  ranked.sort((a, b) => b.score - a.score)

  // -------------------------------------------------------------------------
  // Stage 3 — Synthesis over the full ranked list (winner first)
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
  const synthesis = await rt.agent<TOut>(synthesisPrompt(ranked), synthOpts)

  // The winner is the first ranked entry after DESC sort — capture its originalIndex.
  const winnerOriginalIndex = ranked[0]?.originalIndex ?? 0

  trail.push(makeRecord(`${STAGE}:synthesize`, synthesis !== null, {
    ...(synthesisModel !== undefined ? { model: synthesisModel } : {}),
    ...(synthesisEffort !== undefined ? { effort: synthesisEffort } : {}),
    decision: `winner=${winnerOriginalIndex}`,
  }))

  let value: TOut | null = null

  if (synthesis === null) {
    warn(rt, warnings, 'tournament: synthesis agent returned null')
  } else {
    value = synthesis
  }

  // -------------------------------------------------------------------------
  // Stats (documented):
  // - itemsIn = angles.length
  // - itemsOut = ranked.length (attempts that survived to ranking — NOT the
  //   synthesis product: itemsOut > 0 with value === null means the ranked
  //   attempts were produced but the synthesis agent failed; the warning
  //   carries that signal. Same convention as fanOutAndSynthesize/planAndExecute.)
  // - dropped = null attempts + attempts excluded for zero judge votes
  //             (null judge votes are reported via warning, not counted in dropped)
  // - truncated = 0 (no cap in tournament)
  // - agentsSpawned = attempt calls + judge calls + (1 if synthesis attempted)
  // -------------------------------------------------------------------------

  const stats: PatternStats = {
    itemsIn: angles.length,
    itemsOut: ranked.length,
    agentsSpawned,
    dropped: droppedAttempts + unjudgeableCount,
    truncated: 0,
  }

  // Phase digest: the winning attempt (taken) vs the runners-up (notTaken).
  const winner = ranked[0]
  emitDigest(rt, {
    stage: STAGE,
    ...(winner !== undefined ? { taken: [`attempt:${winner.originalIndex}`] } : {}),
    notTaken: ranked.slice(1).map(r => `attempt:${r.originalIndex}`),
    counts: { attempts: ranked.length },
  })

  return { value, stats, warnings, trail }
}
