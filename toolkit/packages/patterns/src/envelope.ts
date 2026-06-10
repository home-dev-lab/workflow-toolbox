// envelope.ts — shared result envelope, stats type, and two tiny helpers.
//
// §7 "no silent caps": warn() pushes AND rt.log()s the message so the
// /workflows UI shows degradation live while the pattern is running.
//
// applyCap() implements the mandatory truncation reporting required by §8.

import type { WorkflowRuntime } from '@workflow-toolbox/runtime'

// ---------------------------------------------------------------------------
// PatternStats — five counters, one source of truth across all patterns
// ---------------------------------------------------------------------------

export interface PatternStats {
  /** Work units received by the pattern (before any cap). */
  itemsIn: number
  /** Work units that produced a non-null result. */
  itemsOut: number
  /** Agent calls spawned directly by THIS pattern (not caller callbacks). */
  agentsSpawned: number
  /** Null results (skip / agent error) — counted, never silent.
   *  The WORK UNIT is pattern-specific and documented per pattern: e.g.
   *  adversarialVerification counts null verifier VOTES (claims are never
   *  dropped), tournament counts lost ATTEMPTS (null judge votes are
   *  warning-only — a partially-judged attempt survives via the median of
   *  the remaining votes). Read the pattern's stats comment, not just this one. */
  dropped: number
  /** Cap-induced omissions — counted, never silent. */
  truncated: number
}

// ---------------------------------------------------------------------------
// TrailRecord — one audit-trail record (metadata only, no agent payloads,
// no timestamps — array order IS the chronology, built deterministically
// so resume replays identically).
//
// Trail semantics are per-pattern (like `dropped`):
// - Direct-spawn patterns: one record per agent spawned
//   (invariant: trail.length === stats.agentsSpawned).
// - loopUntilDone's trail records loop ITERATIONS (stage `loopUntilDone:tick:<i>`,
//   trail.length === iterations) while agentsSpawned counts the BODY's agent()
//   calls through the rt it received — so trail.length !== agentsSpawned there.
// ---------------------------------------------------------------------------

export interface TrailRecord {
  /** Pattern-qualified step id, e.g. 'planAndExecute:work:3'. */
  stage: string
  /** 'null' = the agent returned null (skip / error / budget) — or, for
   *  loopUntilDone's iteration records, the tick produced a null state. */
  outcome: 'ok' | 'null'
  /** Only set when the pattern passed an explicit model override. */
  model?: string
  /**
   * The control decision taken at this step, when the pattern has one.
   * STRICT RULE: typed control values only (e.g. 'subtasks=5', a verdict
   * enum value, a category name, a stoppedBy value) — never free prose,
   * never payload excerpts.
   */
  decision?: string
}

// ---------------------------------------------------------------------------
// makeRecord — factory for TrailRecord literals.
//
// Spreads keep `model`/`decision` ABSENT (not undefined-valued) when not
// provided — tests pin this key-absence rule.
// ---------------------------------------------------------------------------

/** Build one TrailRecord. Spreads keep `model`/`decision` ABSENT (not
 *  undefined-valued) when not provided — tests pin this key-absence rule. */
export function makeRecord(
  stage: string,
  ok: boolean,
  extra?: { model?: string; decision?: string },
): TrailRecord {
  return {
    stage,
    outcome: ok ? 'ok' : 'null',
    ...(extra?.model !== undefined ? { model: extra.model } : {}),
    ...(extra?.decision !== undefined ? { decision: extra.decision } : {}),
  }
}

// ---------------------------------------------------------------------------
// PatternResult<T> — the standard envelope every pattern returns
// ---------------------------------------------------------------------------

export interface PatternResult<T> {
  value: T
  stats: PatternStats
  warnings: string[]
  /** Audit trail: which agent did what, in deterministic order. See TrailRecord.
   *  REQUIRED: every pattern populates it — tsc enforces that no construction
   *  site can omit it (the "all 7 patterns are instrumented" guarantee). */
  trail: TrailRecord[]
}

// ---------------------------------------------------------------------------
// warn() — push + log (§7 "warnings are reported live")
//
// Convention: patterns always call warn() instead of pushing to warnings or
// calling rt.log() directly, so the two are never out of sync.
// ---------------------------------------------------------------------------

export function warn(
  rt: WorkflowRuntime,
  warnings: string[],
  message: string,
): void {
  warnings.push(message)
  rt.log(message)
}

// ---------------------------------------------------------------------------
// applyCap() — truncation with mandatory reporting
//
// - cap undefined  → no-op (kept = items, truncated = 0)
// - cap >= 1       → keep first cap items, report how many were dropped
// - cap < 1        → throw synchronously with actionable message (§7)
// ---------------------------------------------------------------------------

export function applyCap<T>(
  items: readonly T[],
  cap: number | undefined,
): { kept: readonly T[]; truncated: number } {
  if (cap === undefined) {
    return { kept: items, truncated: 0 }
  }
  if (cap < 1) {
    throw new Error(
      `applyCap: cap must be >= 1, got ${cap} — set maxItems to a positive integer or omit it`,
    )
  }
  if (cap >= items.length) {
    return { kept: items, truncated: 0 }
  }
  return {
    kept: items.slice(0, cap),
    truncated: items.length - cap,
  }
}
