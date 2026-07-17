// stage-instance.ts — per-invocation stage salting (card #1816036725248493168).
//
// THE PROBLEM: every pattern builds its stage/label strings from a fixed
// module-level `const STAGE`. A composition that invokes the SAME pattern
// more than once on the SAME rt (pr-review's per-lens adversarialVerification
// calls; loopUntilDone's body re-invoking a pattern each iteration) emits
// IDENTICAL stage strings across invocations — the debugger's trail-by-stage
// index (packages/debugger/src/report.ts readEnvelopeTrail) and the observe
// effort bridge (ingest-core.ts effortByStage) cannot tell the invocations
// apart, so enrichment silently collides or is dropped (conflict-guarded, but
// still absent).
//
// THE FIX: claim a per-invocation discriminator ("salt") at pattern entry and
// append it TERMINALLY to every stage/label string that invocation builds —
// never on segment 0 (the pattern name), never on the role segment, never in
// digest.stage (digests stay bare — the `instance` field was considered and
// DROPPED, no consumer needs it: v1 amendment A5), never in warn prose.
//
// Registry: WeakMap<object, Map<pattern, count>> keyed on the rt object AS
// RECEIVED by the pattern — `rt` is used ONLY as an identity key here, NEVER
// read, called, .bind()'d, or spread (host-globals gotcha: in the real
// Workflow sandbox, rt's members are host-provided functions whose .bind is
// not usable; a fresh WeakMap key is the one thing that's always safe to take
// from an arbitrary object).
//
// Determinism: the auto counter is deterministic for SEQUENTIALLY invoked
// patterns only (claim order = code order, since claiming happens
// synchronously before the first await). CONCURRENT same-pattern invocations
// inside one rt.pipeline's per-item stages or one rt.parallel burst get
// completion-order numbers — not a bug, just not predictable from source
// order. Callers that need a stable, resume-safe discriminator for
// concurrent invocations should pass an explicit `stageKey` (e.g. pr-review's
// per-lens adversarialVerification calls, one lens per pipeline item).
//
// PURE aside from the module-level WeakMap: no IO, no wall clock, never
// throws (an invalid stageKey degrades to a warning + the auto counter,
// never an error — salting is an audit-trail nicety, not a correctness gate).

/** Per-rt, per-pattern invocation counters. WeakMap so entries for a
 *  garbage-collected rt (e.g. a FakeRuntime built inside one test) are
 *  collected too — no unbounded growth across a long-lived process. */
const registry = new WeakMap<object, Map<string, number>>()

/** Whitelist for an explicit stageKey (amendment A6, refined by the
 *  numeric-reservation review fix): letters, digits, underscore, dot,
 *  hyphen, 1-32 chars, and NOT purely numeric. Deliberately excludes ':'
 *  (the segment separator every pattern's stage grammar uses) and
 *  whitespace (which would admit the loop marker ' ⟲' or a
 *  leading/trailing-space key that reads as accidental input) — anything
 *  outside this set is rejected, never sanitized/stripped, so a caller sees
 *  the warning and can fix the source instead of silently getting a mangled
 *  key. Purely-numeric keys (e.g. a raw loop index passed as `stageKey:
 *  '2'`) are ALSO rejected: they'd produce salt ' #2', which is
 *  FORMAT-IDENTICAL to the AUTO counter's own ' #<n>' salt, so a caller
 *  could silently collide with a later auto-salted invocation on the same
 *  rt/pattern — numeric keys are reserved for the auto counter's own
 *  format, never assignable by a caller. This is the ONE canonical copy of
 *  the charset/shape rule; every pattern's `stageKey` JSDoc references this
 *  function in prose instead of repeating the regex literal, so a future
 *  charset change has a single source of truth. */
const STAGE_KEY_PATTERN = /^(?!\d+$)[A-Za-z0-9_.-]{1,32}$/

export interface ClaimStageInstanceResult {
  /** Terminal suffix to append to EVERY stage/label string this invocation
   *  builds (via stageBuilder): '' for the first bare auto invocation,
   *  ' #<n>' for the nth, or ' #<key>' when a valid explicit stageKey was
   *  given (always salted, even on the first invocation — an explicit key is
   *  author-meaningful and stays stable under insertion of new invocations). */
  salt: string
  /** Set ONLY when an explicit stageKey was provided but rejected by the
   *  whitelist — the caller MUST surface this via its own warn() (this
   *  module never calls rt.log/pushes to a warnings array itself, so it
   *  stays a pure function of its inputs). The claim still falls back to
   *  (and advances) the auto counter, so the invocation is never left
   *  unsalted-and-silent when a second real invocation follows. */
  warning?: string
}

/**
 * Claim a discriminator for ONE pattern invocation on `rt`.
 *
 * Call SYNCHRONOUSLY at pattern entry, AFTER all synchronous config-error
 * throws and BEFORE the first `await` — placing it after validation means a
 * call that throws before reaching this point never consumes a counter slot,
 * which is what keeps existing "rejects an empty/whitespace-only <role>Type"
 * tests (several patterns call the SAME pattern twice on ONE FakeRuntime,
 * each call expected to throw) byte-identical: neither throwing call ever
 * claims, so a real invocation that follows still gets the bare first slot.
 *
 * `pattern` is the pattern's own `STAGE` constant (e.g. 'classifyAndAct') —
 * the counter is scoped per (rt, pattern) pair, so unrelated patterns
 * invoked on the same rt never share or perturb each other's counters.
 */
export function claimStageInstance(
  rt: object,
  pattern: string,
  stageKey?: string,
): ClaimStageInstanceResult {
  if (stageKey !== undefined) {
    if (STAGE_KEY_PATTERN.test(stageKey)) {
      return { salt: ` #${stageKey}` }
    }
    const fallback = claimAuto(rt, pattern)
    const reason = /^\d+$/.test(stageKey)
      ? 'purely-numeric keys are reserved for the auto instance counter\'s own \' #<n>\' format ' +
        '(a numeric stageKey would be indistinguishable from an auto-salted invocation)'
      : `must match ${STAGE_KEY_PATTERN.source}`
    return {
      salt: fallback.salt,
      warning:
        `${pattern}: stageKey ${JSON.stringify(stageKey)} is invalid ` +
        `(${reason}) — falling back to the auto instance counter`,
    }
  }
  return claimAuto(rt, pattern)
}

function claimAuto(rt: object, pattern: string): ClaimStageInstanceResult {
  let byPattern = registry.get(rt)
  if (byPattern === undefined) {
    byPattern = new Map<string, number>()
    registry.set(rt, byPattern)
  }
  const n = (byPattern.get(pattern) ?? 0) + 1
  byPattern.set(pattern, n)
  return { salt: n === 1 ? '' : ` #${n}` }
}

/**
 * Build the shared per-call-site stage/label string function for ONE pattern
 * invocation, from its claimed `salt`. Every call site inside a pattern
 * should compute its stage string ONCE via this builder and reuse that SAME
 * string for both the rt.agent `label` and makeRecord's `stage` — the
 * load-bearing coupling invariant (card amendment A8): the debugger's
 * trail-by-label join (report.ts) and the observe effort bridge
 * (ingest-core.ts effortByStage) both key off full-string equality between
 * an agent's label and its trail record's stage.
 *
 * `stg()` (no suffix) → the bare STAGE + salt (patterns that emit an
 * unsuffixed stage, e.g. `planAndExecute:plan`, still call `stg('plan')` —
 * PURE convenience: this zero-arg form exists for symmetry/testability, no
 * shipped call site in this package currently needs it standalone).
 * `stg(suffix)` → `${STAGE}:${suffix}${salt}` — the salt is ALWAYS terminal,
 * after the suffix, never between segments.
 */
export function stageBuilder(stage: string, salt: string): (suffix?: string) => string {
  return (suffix?: string): string => (suffix !== undefined ? `${stage}:${suffix}${salt}` : `${stage}${salt}`)
}
