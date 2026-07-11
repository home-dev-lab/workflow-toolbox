// budget.ts — pure pieces of canary C2: re-verifies the claim "two
// orchestrator-launched Workflow runs have SEPARATE budget pools" — i.e.
// `budget.spent()` does NOT leak across two independent launches.
//
// The sandbox's `budget` global is documented (packages/runtime/src/types.ts)
// as "shared across all workflows running in the same turn" — confirmed live
// for workflow()-nesting and parallel()/pipeline() fan-out WITHIN one session
// (see docs/public/architecture.md's budgetFloor honesty note: "the pool is
// global and shared with sibling workflows in the same turn"). What was NOT
// pinned before this canary: whether that sharing crosses a SECOND, separate
// orchestrator launch — i.e. two independent SDK sessions, the shape the
// multi-level-pipeline execution model actually uses (dev-full's
// workflow()-composition pattern launches each stage as its own session, not
// as nested workflow() calls within one). If budget.spent() were process-wide
// (e.g. keyed by a shared on-disk counter rather than per-session state), a
// second launch would see the first run's spend baked into its own
// spentAtStart. Expected (per the "same turn" wording): separate pools — this
// canary measures it rather than assuming it.
//
// Design: each probe script reads its OWN spentAtStart/spentAfter around one
// real agent() call (so spend is non-zero and observable) and returns them
// verbatim — no cross-run comparison happens inside the sandbox; judgeBudget
// compares the two completed results after the fact. See budget-canaries.ts
// for the live runner (launches probe A to completion, THEN probe B, as two
// separate runDriverSession calls — two separate SDK sessions).

import { isRecord } from './lib.js'
import type { CheckResult } from './lib.js'

// LIVE-VERIFIED 2026-07-03 (see budget-canaries.ts's runBudgetChecks, canary C2):
// each session-launch carries a small non-zero baseline spend even before the
// workflow's own agent() call runs (observed spentAtStart ≈ 15-140 across two
// live runs, on BOTH probes, independent of each other) — almost certainly the orchestrating
// turn's own tool-call generation, charged to the same "this turn" pool the
// workflow's agent() calls use. This matters for the isolation threshold below:
// a near-zero start is NOT what a genuinely separate pool looks like in
// practice, so the check must not assume one.

export type ProbeLabel = 'a' | 'b'

/** The probe: reads budget.spent()/budget.total before and after one real
 *  agent() call, and returns the raw numbers. `meta` is the first statement
 *  and a pure literal (JSON-shaped, values interpolated as plain strings —
 *  no template literals or calls survive into the emitted script text). */
export function budgetProbeScript(label: ProbeLabel): string {
  return (
    `export const meta = { "name": "wt-canary-budget-${label}", "description": "C2 budget-pool probe ${label}", "phases": [{ "title": "x" }] }\n` +
    `const spentAtStart = budget.spent()\n` +
    `const totalAtStart = budget.total\n` +
    `const out = await agent('Output the word ping 100 times separated by spaces. Nothing else.', { label: 'budget-probe', model: 'haiku', effort: 'low' })\n` +
    `return { spentAtStart, totalAtStart, spentAfter: budget.spent(), agentChars: String(out ?? '').length }\n`
  )
}

// Exported so budget-canaries.ts can name its OWN failure CheckResults (launch
// rejected, run never completed) with the exact identifiers judgeBudget uses —
// one name per check, defined once. NOT prefixed with the canary's serial
// number ("C2") — version.ts's diffSnapshot persists this string as the
// cross-run identity key in the marker, and a canary's serial is an
// authoring-time label, not a stable identity (sibling canaries use the same
// position-free convention: 'edge: …', 'tier1 launch: …').
export const BUDGET_COUNTER_NAME = 'budget-pool: budget.spent() advances within a run [positive control]'
export const BUDGET_ISOLATION_NAME = 'budget-pool: a second orchestrator launch starts with a fresh budget pool'

interface ProbeFields {
  spentAtStart: number
  spentAfter: number
}

/** Defensively narrow one probe's completed result. Null (not a thrown error)
 *  on any shape mismatch — judgeBudget turns that into an explicit, honest
 *  failure rather than a crash or a silently-wrong number. */
function readProbeFields(result: unknown): ProbeFields | null {
  if (!isRecord(result)) return null
  const { spentAtStart, spentAfter } = result
  if (typeof spentAtStart !== 'number' || typeof spentAfter !== 'number') return null
  return { spentAtStart, spentAfter }
}

function rawNumbers(a: ProbeFields | null, resultA: unknown, b: ProbeFields | null, resultB: unknown): string {
  const side = (fields: ProbeFields | null, raw: unknown, label: string): string =>
    fields !== null
      ? `${label}: spentAtStart=${fields.spentAtStart}, spentAfter=${fields.spentAfter}`
      : `${label}: unreadable (got ${JSON.stringify(raw)})`
  return `${side(a, resultA, 'A')} · ${side(b, resultB, 'B')}`
}

/** The two probe results judgeBudget compares. Order is semantically
 *  load-bearing (the isolation check is asymmetric: `second` must NOT
 *  inherit `first`'s spend, not the other way round) — a plain
 *  `(unknown, unknown)` signature let a transposed call site silently turn a
 *  real shared-pool leak into a false PASS. Naming the fields forces a swap to
 *  be a visible, deliberate typo at the call site instead of an invisible
 *  argument-order mistake. */
export interface BudgetProbePair {
  /** The run that launched AND COMPLETED before `second` was even launched. */
  first: unknown
  /** The run launched strictly after `first` finished. */
  second: unknown
}

/** Verdict over TWO completed probe results (`probes.first` launched and
 *  completed fully BEFORE `probes.second` was launched — see
 *  budget-canaries.ts). Two checks, in this order:
 *
 *   1. the counter check (positive control) — both runs' OWN counters
 *      advanced. If the counter is inert (e.g. always 0, or agent() never
 *      actually spends against it), pool isolation is unobservable from these
 *      numbers — this check fails explicitly, and isolation is never given a
 *      hollow pass on top of a broken observable.
 *   2. the isolation check (the claim) — B's pool did not inherit A's spend.
 *      Threshold: B.spentAtStart < A.spentAfter, no safety margin. This is
 *      deliberately a STRICT inequality with no slack, derived from
 *      monotonicity rather than an assumed near-zero baseline (see the
 *      2026-07-03 live-verified note above — real sessions carry a non-zero
 *      per-launch baseline, so "starts near zero" is the WRONG separator). A
 *      genuinely shared/leaking pool is a single counter that only grows —
 *      B's start is a LATER read of that same counter than A's end, so under
 *      sharing B.spentAtStart can only be >= A.spentAfter, never below it.
 *      Any strict decrease already falsifies sharing; no margin is needed or
 *      wanted (a margin only invites false negatives from baseline noise, as
 *      the live run above demonstrated: 133 * 2 = 266 is not < 253, a false
 *      FAIL, even though 133 ≪ 253 is unambiguous separate-pool evidence).
 *
 * Every detail string carries the raw observed numbers, never just a verdict —
 * the report is evidence.
 */
export function judgeBudget(probes: BudgetProbePair): CheckResult[] {
  const { first: resultA, second: resultB } = probes
  const a = readProbeFields(resultA)
  const b = readProbeFields(resultB)
  const numbers = rawNumbers(a, resultA, b, resultB)

  if (a === null || b === null) {
    const which = a === null && b === null ? 'both A and B' : a === null ? 'A' : 'B'
    return [
      {
        name: BUDGET_COUNTER_NAME,
        ok: false,
        detail: `probe result unreadable (${which}) — cannot observe the counter (${numbers})`,
      },
      {
        name: BUDGET_ISOLATION_NAME,
        ok: false,
        detail: `skipped — a probe result was unreadable (${numbers})`,
      },
    ]
  }

  const aAdvanced = a.spentAfter > a.spentAtStart
  const bAdvanced = b.spentAfter > b.spentAtStart
  const counterOk = aAdvanced && bAdvanced
  const counter: CheckResult = counterOk
    ? { name: BUDGET_COUNTER_NAME, ok: true, detail: `both A and B advanced their own counter (${numbers})` }
    : {
        name: BUDGET_COUNTER_NAME,
        ok: false,
        detail: `counter inert — pool isolation unobservable (${numbers})`,
      }

  if (!counterOk) {
    return [
      counter,
      {
        name: BUDGET_ISOLATION_NAME,
        ok: false,
        detail: `skipped — counter inert, isolation unobservable (${numbers})`,
      },
    ]
  }

  const isolationOk = b.spentAtStart < a.spentAfter
  const isolation: CheckResult = {
    name: BUDGET_ISOLATION_NAME,
    ok: isolationOk,
    detail: isolationOk
      ? `B started below A's final spend — a shared, monotonic counter could not produce this (${numbers})`
      : `B's spentAtStart is at or above A's final spend — a shared pool is suspected (${numbers})`,
  }
  return [counter, isolation]
}
