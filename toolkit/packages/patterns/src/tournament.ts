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
//
// NOT SALTED (card #1816036725248493168, amendment A1): every OTHER pattern
// in this package gained a `stageKey?` option + a per-invocation auto salt
// (a terminal ` #<n>`/` #<key>` suffix on every stage/label string) so
// repeated invocations on the same rt no longer collide. tournament is
// DELIBERATELY EXCLUDED from v1: its attempt index is TERMINAL in
// `tournament:attempt:<i>` but NON-TERMINAL in `tournament:judge:<i>:<j>` (the
// attempt index sits in the MIDDLE segment, with the judge index after it) —
// a terminal salt on `attempt:<i>` would land after `<i>`, but the matching
// `judge:<i>:<j>` label has no equivalent terminal position for that SAME
// `<i>` to carry the salt without also touching `<j>` — breaking the fenced
// observatory's attempt→judge edge join (pattern-topology.ts:292) and its
// lost-attempt dimming against the bare digest `notTaken` values
// (graph-spike.ts:617). Until observatory-side salt-awareness for this
// non-terminal case ships (follow-up, card comment), tournament stays
// UNSALTED — invoking it twice on the same rt reproduces today's collision
// behavior (the reader-side conflict guard in packages/debugger/src/report.ts
// still degrades that gracefully: colliding stages are dropped, not
// misattributed).

import type { WorkflowRuntime, JsonSchema, ModelAlias, EffortAlias } from '@workflow-toolbox/runtime'
import { warn, makeRecord, emitDigest, assertAgentTypeOption } from './envelope.js'
import type { PatternResult, PatternStats, TrailRecord } from './envelope.js'
import { runCacheWarmup } from './cache-warm.js'
import { agentWithSchemaSalvage } from './structured-salvage.js'
import type { StructuredCallOutcome } from './structured-salvage.js'

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
  /** Ship an ANCHORED RUBRIC in the judge schema, so each judge places its
   *  attempt against a described scale instead of a bare 0..10.
   *
   *  **Default FALSE, and the reason is a measurement rather than caution.**
   *  It shipped default-ON, then was benched against a corpus whose severities
   *  were fixed before any judge saw it, two passes per condition, judges called
   *  directly on a cross-family CLI so the provenance of every cell is its own
   *  invocation. Result, on the metric the rubric exists for — separating a
   *  security flaw from a cosmetic one:
   *
   *    condition   security-vs-nit gap     instability across passes
   *    rubric      4, 5                    1
   *    bare        7, 5                    3
   *
   *  The rubric did NOT improve discrimination; it compressed it, by being
   *  harsher on the correct-but-badly-named candidate (6/7 instead of 8) and
   *  slightly kinder to the actual flaw (2 instead of 1). What it did improve is
   *  run-to-run STABILITY, clearly.
   *
   *  So it addresses the second of the two measured failures (a family that
   *  scored the same defect HIGH on one run and MED on the next) and not the
   *  first (a family that fused a correctness regression into a presentation
   *  item). A default that changes behaviour for every caller needs positive
   *  evidence for its primary purpose and has none — hence opt-in. Turn it ON
   *  when run-to-run stability matters more than the sharpest possible ranking.
   *
   *  ⚠ n=2 passes. One flip moves the table; this is directional, not settled.
   *
   *  ⚠ The rubric is deliberately ABSOLUTE, never comparative. A judge here
   *  scores ONE attempt per call and never sees its siblings (see the judging
   *  stage below), so a quota such as "at most one of K may score 9+" is not
   *  merely unhelpful — it is unenforceable, and it invites the model to invent
   *  a comparison it cannot make. Giving judges sibling visibility to enable
   *  such a quota would pay for it with the panel's independence, which is the
   *  whole reason the panel exists. */
  judgeRubric?: boolean
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

// The anchored rubric. Measured defect it answers: an external verifier lane,
// scoring against a bare numeric range, FLATTENED severity — it folded the one
// correctness regression in a set into a generic presentation item. A second
// family failed the same axis differently, scoring the identical defect HIGH on
// one run and MED on the next. Two families, two mechanisms, one axis: a limit
// of the ROLE, not of a model.
//
// ⚠ ABSOLUTE, never comparative, and that constraint is architectural. Judges
// here score one attempt per call, in isolation (rt.parallel over judgeThunks).
// A comparative quota — "at most one of K earns the top band" — is the shape the
// idea arrives in from tree-of-thoughts implementations, which score K siblings
// in ONE call. Transplanted here it cannot be checked by the judge that receives
// it, and an unenforceable comparison is worse than none: the model supplies an
// imagined one. Bands a lone judge can apply are what makes this work, and they
// also degrade cleanly to a group of one.
const RUBRIC =
  'Place this on an ABSOLUTE scale; do not guess how others scored. ' +
  '9-10: fully meets the goal, no reservation worth stating. ' +
  '7-8: sound, with a named limitation that does not block use. ' +
  '4-6: partially works, or works with a caveat a user would hit. ' +
  '1-3: addresses the goal but is wrong, unsafe, or unusable as written. ' +
  '0: does not address the goal. ' +
  'Reserve 9-10 and 1-3 for cases that genuinely earn them — a set where ' +
  'everything lands mid-scale hides the one item that actually differs.'

function judgeSchema(rubric: boolean): JsonSchema {
  return {
    type: 'object',
    properties: {
      score: {
        type: 'number',
        minimum: 0,
        maximum: 10,
        ...(rubric ? { description: RUBRIC } : {}),
      },
      reason: { type: 'string' },
    },
    required: ['score', 'reason'],
    additionalProperties: false,
  }
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
    judgeRubric = false,
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

  const attemptThunks = angles.map((angle, i) => async (): Promise<StructuredCallOutcome<TAttempt>> => {
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

    return agentWithSchemaSalvage<TAttempt>(rt, attemptPrompt(angle, i), opts)
  })

  const attemptResults = await rt.parallel(attemptThunks)

  // Collect surviving attempts with their angle mapping.
  // Build attempt trail records + spawn counts in index order after the
  // parallel barrier (determinism: never completion order). A thunk that
  // threw (budget) resolves to null — one spawn, no salvage.
  const survivingAttempts: Array<{ attempt: TAttempt; angle: string; originalIndex: number }> = []

  for (let i = 0; i < attemptResults.length; i++) {
    const out = attemptResults[i] as StructuredCallOutcome<TAttempt> | null
    const attempt = out?.value ?? null
    agentsSpawned += out?.spawns ?? 1
    trail.push(makeRecord(`${STAGE}:attempt:${i}`, attempt !== null, {
      ...(attemptModel !== undefined ? { model: attemptModel } : {}),
      ...(attemptEffort !== undefined ? { effort: attemptEffort } : {}),
    }))
    if (out !== null && out.salvageAttempted) {
      trail.push(makeRecord(`${STAGE}:attempt:${i}:salvage`, out.salvaged, {
        ...(attemptModel !== undefined ? { model: attemptModel } : {}),
        ...(attemptEffort !== undefined ? { effort: attemptEffort } : {}),
      }))
    }
    for (const message of out?.warnings ?? []) warn(rt, warnings, `${STAGE}: ${message}`)

    if (attempt !== null) {
      survivingAttempts.push({ attempt, angle: angles[i]!, originalIndex: i })
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
    emitDigest(rt, { stage: STAGE, ...(phase !== undefined ? { phase } : {}), counts: { attempts: 0 } })
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
        return async (): Promise<StructuredCallOutcome<{ score: number; reason: string }>> => {
          const opts: {
            schema: JsonSchema
            label: string
            phase?: string
            model?: ModelAlias
            effort?: EffortAlias
            agentType?: string
          } = {
            schema: judgeSchema(judgeRubric),
            label: `${STAGE}:judge:${originalIndex}:${judgeIndex}`,
            ...(phase !== undefined ? { phase } : {}),
            ...(judgeModel !== undefined ? { model: judgeModel } : {}),
            ...(judgeEffort !== undefined ? { effort: judgeEffort } : {}),
            ...(judgeType !== undefined ? { agentType: judgeType } : {}),
          }

          return agentWithSchemaSalvage<{ score: number; reason: string }>(rt, judgePrompt(attempt), opts)
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
    const judgeOuts = (panels[i] ?? []).map(
      (r): StructuredCallOutcome<{ score: number; reason: string }> | null =>
        r as StructuredCallOutcome<{ score: number; reason: string }> | null,
    )
    const judgeResults: Array<{ score: number; reason: string } | null> = judgeOuts.map((o) => o?.value ?? null)

    for (let judgeIndex = 0; judgeIndex < judgeResults.length; judgeIndex++) {
      const out = judgeOuts[judgeIndex] ?? null
      const judgeResult = judgeResults[judgeIndex] ?? null
      agentsSpawned += out?.spawns ?? 1
      trail.push(makeRecord(`${STAGE}:judge:${originalIndex}:${judgeIndex}`, judgeResult !== null, {
        ...(judgeModel !== undefined ? { model: judgeModel } : {}),
        ...(judgeEffort !== undefined ? { effort: judgeEffort } : {}),
        ...(judgeResult !== null ? { decision: `score=${judgeResult.score}` } : {}),
      }))
      if (out !== null && out.salvageAttempted) {
        trail.push(makeRecord(`${STAGE}:judge:${originalIndex}:${judgeIndex}:salvage`, out.salvaged, {
          ...(judgeModel !== undefined ? { model: judgeModel } : {}),
          ...(judgeEffort !== undefined ? { effort: judgeEffort } : {}),
        }))
      }
      for (const message of out?.warnings ?? []) warn(rt, warnings, `${STAGE}: ${message}`)
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
    emitDigest(rt, { stage: STAGE, ...(phase !== undefined ? { phase } : {}), counts: { attempts: 0 } })
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
  // Flattening detector — pure data, no extra agent call.
  //
  // The rubric above is an INSTRUCTION, and an instruction a model can silently
  // decline is a hope, not a mechanism. This is the half that executes: it
  // measures whether the panel actually discriminated, and says so when it did
  // not. It never changes the ranking — a flat set can be honest (two genuinely
  // equivalent attempts), so this warns and leaves the arbitration where it
  // belongs.
  //
  // Why the SPREAD and not the variance: the failure being watched for is "every
  // attempt landed in the same band", which is exactly max - min. Variance would
  // also fire on a wide set with one outlier, which is discrimination working.
  //
  // Threshold: a spread below one full band on the 0..10 rubric. Bands are three
  // points wide (1-3, 4-6, 7-8, 9-10), so < 1.0 means the panel did not even
  // separate adjacent scores — it is deliberately conservative, because a
  // detector that cries on real ties gets ignored and takes its true case with
  // it. Only meaningful with something to compare: skipped below two attempts.
  // -------------------------------------------------------------------------

  if (ranked.length >= 2) {
    const top = ranked[0]
    const bottom = ranked[ranked.length - 1]
    if (top !== undefined && bottom !== undefined) {
      const spread = top.score - bottom.score
      if (spread < 1) {
        warn(
          rt, warnings,
          `tournament: judge scores are FLAT across ${ranked.length} attempts ` +
            `(spread ${spread.toFixed(2)} on 0..10, all near ${top.score.toFixed(1)}) — ` +
            `the ranking is near-arbitrary and the winner may not be the best attempt. ` +
            `Either the attempts really are equivalent, or the judges did not discriminate.`,
        )
      }
    }
  }

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

  const synthOut = await agentWithSchemaSalvage<TOut>(rt, synthesisPrompt(ranked), synthOpts)
  agentsSpawned += synthOut.spawns
  const synthesis = synthOut.value

  // The winner is the first ranked entry after DESC sort — capture its originalIndex.
  const winnerOriginalIndex = ranked[0]?.originalIndex ?? 0

  trail.push(makeRecord(`${STAGE}:synthesize`, synthesis !== null, {
    ...(synthesisModel !== undefined ? { model: synthesisModel } : {}),
    ...(synthesisEffort !== undefined ? { effort: synthesisEffort } : {}),
    decision: `winner=${winnerOriginalIndex}`,
  }))
  if (synthOut.salvageAttempted) {
    trail.push(makeRecord(`${STAGE}:synthesize:salvage`, synthOut.salvaged, {
      ...(synthesisModel !== undefined ? { model: synthesisModel } : {}),
      ...(synthesisEffort !== undefined ? { effort: synthesisEffort } : {}),
    }))
  }
  for (const message of synthOut.warnings) warn(rt, warnings, `${STAGE}: ${message}`)

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
    ...(phase !== undefined ? { phase } : {}),
    ...(winner !== undefined ? { taken: [`attempt:${winner.originalIndex}`] } : {}),
    notTaken: ranked.slice(1).map(r => `attempt:${r.originalIndex}`),
    counts: { attempts: ranked.length },
  })

  return { value, stats, warnings, trail }
}
