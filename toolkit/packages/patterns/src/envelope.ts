// envelope.ts — shared result envelope, stats type, and two tiny helpers.
//
// §7 "no silent caps": warn() pushes AND rt.log()s the message so the
// /workflows UI shows degradation live while the pattern is running.
//
// applyCap() implements the mandatory truncation reporting required by §8.

import { formatDigest } from '@workflow-toolbox/runtime'
import type { TypedPhaseDigest, WorkflowRuntime } from '@workflow-toolbox/runtime'

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
  /** Only set when the pattern passed an explicit effort override. The harness records
   *  NOTHING about effort per agent (no journal field, no meta sidecar — grounded
   *  2026-07-10), so this trail entry is the ONLY durable per-stage effort record; the
   *  audit report and the observe agent panel read it from here. Absent = inherited. */
  effort?: string
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

/** Build one TrailRecord. Spreads keep `model`/`effort`/`decision` ABSENT (not
 *  undefined-valued) when not provided — tests pin this key-absence rule. */
export function makeRecord(
  stage: string,
  ok: boolean,
  extra?: { model?: string; effort?: string; decision?: string },
): TrailRecord {
  return {
    stage,
    outcome: ok ? 'ok' : 'null',
    ...(extra?.model !== undefined ? { model: extra.model } : {}),
    ...(extra?.effort !== undefined ? { effort: extra.effort } : {}),
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
   *  site can omit it (the "all 8 patterns are instrumented" guarantee). */
  trail: TrailRecord[]
}

// ---------------------------------------------------------------------------
// collectTrail() — concatenate a composition's per-pattern trails, in order.
//
// Compositions attach `envelope: { trail: collectTrail(a, b, …) }` to their
// return value — the contract the debugger report builder (Decisions
// enrichment) and the observe per-agent effort chip read. Ground truth
// 2026-07-10: no composition produced it before.
// ---------------------------------------------------------------------------

/**
 * Concatenate the `trail` of every given PatternResult, in call order,
 * skipping `null`/`undefined` entries (a pattern stage that was skipped or
 * never ran — e.g. a conditional Critique/Verify phase, or a survivor list
 * that ended up empty).
 */
export function collectTrail(
  ...results: Array<{ trail: TrailRecord[] } | null | undefined>
): TrailRecord[] {
  const trail: TrailRecord[] = []
  for (const r of results) {
    if (r === null || r === undefined) continue
    trail.push(...r.trail)
  }
  return trail
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
// emitDigest() — report a pattern's per-phase OUTCOME as ONE structured rt.log
// narrator line (the phase digest). @workflow-toolbox/observe parses it back at
// reload time into phase.output/phase.choices and attributes it to this pattern's
// phase by matching `d.stage` against the agents' labels.
//
// CONTRACT: `d.stage` MUST equal the pattern-name prefix this pattern uses for its
// agent labels (e.g. 'classifyAndAct' for labels 'classifyAndAct:classify:0'), or
// observe cannot resolve the phase. Reload-only (rt.log is absent from the live
// SDK stream). Call once PER PATTERN RUN, with only the fields the pattern actually
// knows (all PhaseDigest fields beyond `stage` are optional) — including before a
// failure early-return, so a failed run still reports an outcome.
//
// ATTRIBUTION: observe resolves a digest to a phase in priority order: (1) `d.phase`
// (the caller's `opts.phase`, when the pattern accepts one and the caller passed it) —
// matched directly against a `workflow_phase` event's title, so it resolves even a
// phase with zero surviving agents (an early-failure digest); (2) failing that,
// stage→agent-label prefix match, surfacing ONLY when exactly one digest resolves to
// that phase (if the SAME pattern is invoked more than once under ONE phase title,
// both digests resolve to that phase and observe drops BOTH — explicit absence, never
// a guess — give repeated invocations distinct phases, or distinct `phase` values, to
// keep their digests attributable); (3) a pattern-specific fallback (loopUntilDone's
// iteration-marker match) as last resort for patterns with no phase notion of their own.
// ---------------------------------------------------------------------------

export function emitDigest<S extends string>(rt: WorkflowRuntime, d: TypedPhaseDigest<S>): void {
  rt.log(formatDigest(d))
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

// ---------------------------------------------------------------------------
// assertAgentTypeOption() — validate an optional per-role agentType routing input
//
// The `<role>Type` options (taskType, generatorType, judgeType, …) route a role's
// agents through a custom subagent type (the Agent tool's `agentType`), e.g.
// 'codex:codex-rescue' or 'workflow-toolbox:opencode-verifier' — the mechanism for
// cross-family decorrelation. Mirrors adversarialVerification's verifierType guard:
// omit (undefined) for the standard Claude subagent; a defined-but-blank string is a
// config error (it would spawn an invalid empty agentType), thrown synchronously at
// entry like every other pattern config error.
// ---------------------------------------------------------------------------

export function assertAgentTypeOption(
  stage: string,
  name: string,
  value: string | undefined,
): void {
  if (value !== undefined && value.trim().length === 0) {
    throw new Error(
      `${stage}: ${name} must be a non-empty subagent-type string (e.g. 'codex:codex-rescue') — omit it for the standard subagent`,
    )
  }
}
