// loop-until-done.ts — evaluator-optimizer loop (§6.1 rule 7 + §8 budgetFloor).
//
// Flow: loop body (caller-provided) runs until one of four conditions stops it:
//   - 'done'          — body returns done=true (normal completion, no warning)
//   - 'maxIterations' — iteration ceiling reached (warning)
//   - 'dryRounds'     — consecutive non-progressing rounds reached (warning)
//   - 'budgetFloor'   — remaining budget <= floor (warning; §8 breadth-over-integrity)
//
// §6.1 rule 7: at least one stop condition MUST be present — enforced at the
//   type level (LoopStopConditions union). Missing all three is a compile error.
//
// §8 budgetFloor: when budgetFloor is the ONLY stop condition and total is null,
//   throw at entry — an inert floor means an unbounded loop (the Infinity trap).
//   When budgetFloor accompanies other conditions and total is null, the floor
//   is inert: emit a warning and proceed on the other conditions.
//
// Stop-condition PRECEDENCE (behavioral contract, pinned by tests):
//   budgetFloor > maxIterations > body's done > dryRounds — the floor and the
//   iteration ceiling are checked BEFORE each body run. Once the floor is
//   crossed, a body that *would have* returned done=true never runs: we cannot
//   know it would complete without running it, and running it is exactly the
//   spend the floor exists to prevent (§8: the floor decides where the cut
//   falls — breadth over integrity). 'done' from an iteration that DID run
//   always wins over dryRounds.
//
// agentsSpawned counts the BODY's agent() calls — this pattern spawns no
//   agents itself, but the body receives a counting wrapper rt whose .agent
//   tallies before delegating to the real rt.agent. Calls routed through
//   rt.parallel thunks / rt.pipeline stages on that same rt are counted too
//   (neither primitive calls agent internally). Live-run lesson: the old
//   hard-coded 0 forced per-task agent counts to be dug out of the run
//   journal — the envelope lied by omission.
//
// Conventions:
// - Config errors throw synchronously at entry with actionable messages.
// - Body throws propagate (programmer errors must not be swallowed).
// - No phase option — the body's agents own their own phase context.

import type { WorkflowRuntime } from '@workflow-toolbox/runtime'
import { warn, makeRecord } from './envelope.js'
import type { PatternResult, PatternStats, TrailRecord } from './envelope.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LoopStoppedBy = 'done' | 'maxIterations' | 'dryRounds' | 'budgetFloor'

export interface LoopTick<TState> {
  state: TState
  done?: boolean
  progressed?: boolean
}

interface LoopStopFields {
  maxIterations?: number
  dryRounds?: number
  budgetFloor?: number
}

/** §6.1 rule 7: omission of ALL stop conditions is a COMPILE error.
 *  The union type enforces that at least one stop condition key is present. */
export type LoopStopConditions =
  | (LoopStopFields & { maxIterations: number })
  | (LoopStopFields & { dryRounds: number })
  | (LoopStopFields & { budgetFloor: number })

export type LoopUntilDoneOptions<TState> = LoopStopConditions & {
  initial: TState
  /** The loop body — caller code (often calls rt.agent or other patterns).
   *  A throw here is a programmer error and PROPAGATES (not swallowed). */
  body: (rt: WorkflowRuntime, state: TState, iteration: number) => Promise<LoopTick<TState>>
}

export interface LoopOutcome<TState> {
  state: TState
  iterations: number
  stoppedBy: LoopStoppedBy
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Evaluator-optimizer loop: runs the caller-provided `body` until one of four
 * conditions stops it, with precedence budgetFloor > maxIterations > done >
 * dryRounds. At least one of maxIterations/dryRounds/budgetFloor is REQUIRED
 * at the type level; body throws propagate. `value` is the loop outcome
 * ({ state, iterations, stoppedBy }); `stats.agentsSpawned` tallies the
 * body's agent() calls.
 *
 * @example
 * ```ts
 * import { loopUntilDone } from '@workflow-toolbox/patterns'
 * import { FakeRuntime } from '@workflow-toolbox/runtime'
 *
 * const rt = new FakeRuntime({ responses: ['draft v1', 'draft v2'] })
 *
 * const result = await loopUntilDone(rt, {
 *   initial: { draft: '', revisions: 0 },
 *   maxIterations: 5,
 *   body: async (rt, state, iteration) => {
 *     // iteration is 1-based; agent() calls here count into stats.agentsSpawned
 *     const draft = await rt.agent(
 *       `Revise this draft (round ${iteration}): ${state.draft || '(empty)'}`,
 *     )
 *     const next = { draft: draft ?? state.draft, revisions: state.revisions + 1 }
 *     return { state: next, done: next.revisions >= 2, progressed: draft !== null }
 *   },
 * })
 *
 * const { state, iterations, stoppedBy } = result.value
 * rt.log(`stopped by ${stoppedBy} after ${iterations} iterations`)
 * rt.log(`final draft: ${state.draft} (${result.stats.agentsSpawned} agents)`)
 * if (result.warnings.length > 0) rt.log(result.warnings.join('; '))
 * ```
 */
export async function loopUntilDone<TState>(
  rt: WorkflowRuntime,
  options: LoopUntilDoneOptions<TState>,
): Promise<PatternResult<LoopOutcome<TState>>> {
  const { initial, body, maxIterations, dryRounds, budgetFloor } = options as LoopStopConditions & {
    initial: TState
    body: LoopUntilDoneOptions<TState>['body']
    maxIterations?: number
    dryRounds?: number
    budgetFloor?: number
  }

  // -------------------------------------------------------------------------
  // Synchronous validation — throw with actionable messages
  // -------------------------------------------------------------------------

  if (maxIterations !== undefined && maxIterations < 1) {
    throw new Error(
      `loopUntilDone: maxIterations must be >= 1, got ${maxIterations}`,
    )
  }

  if (dryRounds !== undefined && dryRounds < 1) {
    throw new Error(
      `loopUntilDone: dryRounds must be >= 1, got ${dryRounds}`,
    )
  }

  if (budgetFloor !== undefined && budgetFloor < 0) {
    throw new Error(
      `loopUntilDone: budgetFloor must be >= 0, got ${budgetFloor}`,
    )
  }

  // §8 fail-fast: budgetFloor as the ONLY stop condition with null total = Infinity trap
  if (
    budgetFloor !== undefined &&
    maxIterations === undefined &&
    dryRounds === undefined &&
    rt.budget.total === null
  ) {
    throw new Error(
      `loopUntilDone: budgetFloor is the only stop condition but no budget target is set ` +
      `(rt.budget.total is null) — an inert floor means an unbounded loop; ` +
      `add maxIterations or dryRounds, or run with a token target`,
    )
  }

  // -------------------------------------------------------------------------
  // Mutable state
  // -------------------------------------------------------------------------

  const warnings: string[] = []
  const trail: TrailRecord[] = []
  let state: TState = initial
  let iterationsDone = 0
  let consecutiveDry = 0
  let agentsSpawned = 0

  // ---- Counting wrapper handed to the body (the OUTER rt keeps driving the
  //      loop's own budgetFloor/warn/log machinery). Explicit 7-member literal,
  //      NOT a `{ ...rt }` spread: FakeRuntime defines phase/log on the
  //      PROTOTYPE (non-own), so a spread would silently drop them. budget and
  //      workflow pass BY REFERENCE — the floor checks above read rt.budget on
  //      the outer rt and must see the same object the body spends against.
  const countingRt: WorkflowRuntime = {
    agent: <T = string>(...args: Parameters<WorkflowRuntime['agent']>) => {
      agentsSpawned++
      return rt.agent<T>(...args)
    },
    parallel: <T>(thunks: ReadonlyArray<() => Promise<T>>) => rt.parallel<T>(thunks),
    pipeline: (...args: Parameters<WorkflowRuntime['pipeline']>) => rt.pipeline(...args),
    phase: (title) => rt.phase(title),
    log: (message) => rt.log(message),
    budget: rt.budget,
    workflow: rt.workflow,
  }

  // Inert-floor warning: budgetFloor set alongside other conditions but total is null
  if (budgetFloor !== undefined && rt.budget.total === null) {
    warn(
      rt, warnings,
      `loopUntilDone: budgetFloor=${budgetFloor} is inert (no budget target set)`,
    )
  }

  // -------------------------------------------------------------------------
  // Loop — an inner closure that RETURNS the stop cause at each exit point.
  // The compiler enforces exhaustiveness; the cause is never re-derived from
  // side state (a previous version string-sniffed warnings — fragile, removed).
  // -------------------------------------------------------------------------

  const runLoop = async (): Promise<LoopStoppedBy> => {
    while (true) {
      // ---- 1. Budget floor check BEFORE each iteration (only when total !== null).
      //      Precedence over a body that might have returned done — see header.
      if (budgetFloor !== undefined && rt.budget.total !== null) {
        const remaining = rt.budget.remaining()
        if (remaining <= budgetFloor) {
          warn(
            rt, warnings,
            `loopUntilDone: stopped by budgetFloor (remaining=${remaining} <= floor=${budgetFloor}) after ${iterationsDone} iterations`,
          )
          return 'budgetFloor'
        }
      }

      // ---- 2. maxIterations check: would the next iteration exceed the ceiling?
      if (maxIterations !== undefined && iterationsDone >= maxIterations) {
        warn(
          rt, warnings,
          `loopUntilDone: stopped by maxIterations=${maxIterations} after ${iterationsDone} iterations`,
        )
        // Stamp the stop decision onto the last trail record (the tick that was the
        // final executed iteration), if any. Stops BEFORE body run have no tick record.
        if (trail.length > 0) {
          trail[trail.length - 1]!.decision = 'maxIterations'
        }
        return 'maxIterations'
      }

      // ---- 3. Run body — throws propagate (programmer errors, not swallowed).
      //      The body gets the COUNTING rt so its agent() calls land in stats.
      const tick = await body(countingRt, state, iterationsDone + 1)
      const tickIndex = iterationsDone  // 0-based index for this tick
      state = tick.state
      iterationsDone++

      // Push a trail record for this tick. outcome='null' when body returned
      // a null state (unusable), 'ok' otherwise. No label/model — the record is
      // per-TICK, not per-agent (the body's agent calls are counted in stats,
      // not individually trailed).
      trail.push(makeRecord(`loopUntilDone:tick:${tickIndex}`, tick.state !== null))

      // ---- done=true → normal completion, no warning; stamp decision on last tick
      if (tick.done === true) {
        trail[trail.length - 1]!.decision = 'done'
        return 'done'
      }

      // ---- 4. dryRounds tracking
      if (dryRounds !== undefined) {
        if (tick.progressed === false) {
          consecutiveDry++
        } else {
          // Any non-false progressed value (true, undefined) resets the dry counter
          consecutiveDry = 0
        }

        if (consecutiveDry >= dryRounds) {
          warn(
            rt, warnings,
            `loopUntilDone: stopped by dryRounds=${dryRounds} after ${iterationsDone} iterations`,
          )
          trail[trail.length - 1]!.decision = 'dryRounds'
          return 'dryRounds'
        }
      }
    }
  }

  const stoppedBy = await runLoop()
  // budgetFloor fires BEFORE the body runs — no tick record was pushed for that
  // stop, so there is nothing to stamp. The trail already reflects only the
  // iterations that actually executed (correct by construction).
  return buildResult(state, iterationsDone, stoppedBy, warnings, trail, agentsSpawned)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildResult<TState>(
  state: TState,
  iterations: number,
  stoppedBy: LoopStoppedBy,
  warnings: string[],
  trail: TrailRecord[],
  agentsSpawned: number,
): PatternResult<LoopOutcome<TState>> {
  // Stats semantics (documented):
  // - itemsIn = itemsOut = completed iterations (the "work units" are loop ticks)
  // - dropped = truncated = 0 (no cap, no per-tick drop accounting)
  // - agentsSpawned = the number of agent() calls the BODY made through the
  //   counting rt it received (including calls inside rt.parallel thunks and
  //   rt.pipeline stages routed through that same rt)
  //
  // Trail semantics (loopUntilDone deviation from direct-spawn patterns):
  // - the trail stays per-ITERATION: one TrailRecord per executed tick
  //   (stage = 'loopUntilDone:tick:<i>', 0-based), so trail.length === iterations.
  // - agentsSpawned counts the body's agent() calls, NOT trail records — so
  //   trail.length !== agentsSpawned for this pattern (the direct-spawn
  //   invariant trail.length === agentsSpawned does NOT apply here).
  const stats: PatternStats = {
    itemsIn: iterations,
    itemsOut: iterations,
    agentsSpawned,
    dropped: 0,
    truncated: 0,
  }

  return {
    value: { state, iterations, stoppedBy },
    stats,
    warnings,
    trail,
  }
}
