// digest.ts — the SHARED phase-digest line grammar.
//
// This is the ONE source of truth for the machine-parseable narrator line a
// pattern emits (via rt.log) to report its per-phase OUTCOME — the handoff value,
// the branches taken vs not taken (ghost branches), and any in/out/dropped counts.
// @workflow-toolbox/patterns formats it via emitDigest() (envelope.ts) — which all
// eight patterns call to report their per-phase outcome — and @workflow-toolbox/observe
// parses it back (parseDigest) at reload-ingest time. Both sides live here, in the only
// package both already depend on, so the LINE GRAMMAR of emit and parse cannot drift.
// (Caveat: only the grammar is contracted, NOT the count-KEY semantics — see the note on
// PhaseDigest.counts.)
//
// WHY a tagged log line (not a phaseIndex): a pattern runs WITHIN an ambient phase
// but the sandbox never tells it which index that is (WorkflowRuntime.phase(title)
// is write-only, title-keyed). So the pattern can only tag with its own `stage`
// (the pattern name, e.g. 'classifyAndAct'); observe resolves the phase downstream
// by matching that stage against the agents' labels (which DO carry phaseIndex).
//
// PURE: no imports, no IO, no wall clock, never throws.

/** The distinctive prefix that marks a run.log line as a structured phase digest.
 *  Any other narrator line is left untouched (still captured as a raw run.log). */
export const DIGEST_PREFIX = '[wt:digest]'

/** Pattern `stage` emitted by loopUntilDone (@workflow-toolbox/patterns). Shared here so
 *  the pattern (which uses it as its digest stage AND its default
 *  `loopUntilDone:iter:<n>` label prefix) and observe (which special-cases its
 *  attribution — see isLoopIterLabel) reference ONE literal: a rename can't desync them. */
export const LOOP_STAGE = 'loopUntilDone'

/** loopUntilDone tags every body agent's label with this iteration marker so each round
 *  is observable in the trace. When the body supplies its OWN label (a nested pattern's
 *  structured label, or a caller scheme like `dev-implement:*`), the marker is APPENDED —
 *  `<label> ⟲<n>` — preserving that prefix so the nested pattern's own digest still
 *  resolves. The consequence: the loop's OWN digest (stage=LOOP_STAGE) then has no
 *  `loopUntilDone:`-prefixed agent to anchor to. observe closes that gap with
 *  isLoopIterLabel() — attributing the loop digest to the phase whose agents carry this
 *  marker, but only when no OTHER digest already claimed that phase (nested digest keeps
 *  precedence). The default unlabelled body uses `loopUntilDone:iter:<n>` and never needs it. */
export const LOOP_ITER_MARKER = ' ⟲'

/** True when `label` carries loopUntilDone's appended iteration marker (`… ⟲<n>`, n a
 *  positive integer). observe uses this to attribute a loop's own digest when the body
 *  relabelled its agents (nested pattern / caller scheme). PURE. */
export function isLoopIterLabel(label: string): boolean {
  const i = label.lastIndexOf(LOOP_ITER_MARKER)
  if (i < 0) return false
  const tail = label.slice(i + LOOP_ITER_MARKER.length)
  return tail.length > 0 && /^[0-9]+$/.test(tail)
}

/** The structured payload a pattern reports for the phase it ran in.
 *  All fields beyond `stage` are optional — a pattern emits only what it knows
 *  (e.g. classifyAndAct fills taken/notTaken; generateAndFilter fills counts;
 *  fanOutAndSynthesize fills output). */
export interface PhaseDigest {
  /** The emitting pattern's name, e.g. 'classifyAndAct'. observe resolves this to a
   *  phaseIndex by matching agent labels that share this prefix. */
  stage: string
  /** A short summary of the value handed off out of this phase (the handoff node). */
  output?: string
  /** Branches/candidates that were taken (e.g. the chosen category). */
  taken?: string[]
  /** Branches that existed in the pattern's shape but were NOT taken (ghost branches). */
  notTaken?: string[]
  /** Cardinal counts the pattern wants surfaced. The count KEYS are pattern-specific
   *  and inconsistent (`in`/`out`, `planned`/`executed`, `attempts`, `iterations`, …);
   *  this stays an open `Record` because `parseDigest` rebuilds a PhaseDigest from an
   *  UNTRUSTED journal line (an unknown/future stage, partial counts) and must not reject
   *  it. The EMIT side is contracted separately — see `PatternCounts` / `TypedPhaseDigest`
   *  below, which `emitDigest` uses so a pattern's counts vocabulary is checked at the call
   *  site and stays aligned with observe's render descriptors. A consumer of the PARSED
   *  digest still keys off `stage` to interpret counts. */
  counts?: Record<string, number>
}

/** The contracted per-pattern `counts` vocabulary — the SINGLE source of truth for which
 *  count keys each pattern emits, AND (via `PatternName = keyof PatternCounts` below) the
 *  closed set of patterns that emit a digest. Both the emit side (`emitDigest` via
 *  `TypedPhaseDigest`) and observe's render descriptors (`COUNT_SEMANTICS` / `COUNT_ICONS`)
 *  are typed against this, so renaming a key is a compile break across all surfaces, not a
 *  silent desync. (The EMIT-side cousin of the render-side pattern-aware fix; resolves the
 *  count-vocab follow-up from card #1805897376322290763.) Grounded against
 *  `packages/patterns/src` 2026-06-29. */
export interface PatternCounts {
  classifyAndAct: { in: number; out: number }
  generateAndFilter: { requested: number; kept: number; rejected: number; failed: number }
  adversarialVerification: {
    claims: number
    confirmed: number
    refuted: number
    partiallyConfirmed: number
    unverifiable: number
    unverifiedByCap: number
  }
  planAndExecute: { planned: number; executed: number; dropped: number; truncated: number }
  loopUntilDone: { iterations: number }
  tournament: { attempts: number }
  scoreAndRank: { requested: number; kept: number; cut: number; dropped: number; truncated: number }
  fanOutAndSynthesize: { tasks: number; completed: number }
  chunkedAnalysis: { chunks: number; analyzed: number; dropped: number; truncated: number }
}

/** The closed set of pattern names that emit a phase digest. DERIVED from `PatternCounts`
 *  so the name set and the counts vocabulary can never drift (no separate union to maintain;
 *  observe-ui's pattern-topology re-exports this). */
export type PatternName = keyof PatternCounts

/** The EMIT-side digest shape: `PhaseDigest` with `stage` narrowed to `S` and `counts`
 *  contracted to that stage's vocabulary. The non-`stage`/`counts` fields are DERIVED from
 *  `PhaseDigest` via `Omit` (no field-for-field re-declaration → no drift if PhaseDigest
 *  grows). `S extends string` (not `PatternName`) keeps emitDigest open to custom-pattern
 *  authors: a BUILT-IN stage gets its exact `PatternCounts[S]` shape checked at the call
 *  site; any other stage falls back to the permissive `Record<string, number>`. */
export type TypedPhaseDigest<S extends string> = Omit<PhaseDigest, 'stage' | 'counts'> & {
  stage: S
  counts?: S extends PatternName ? PatternCounts[S] : Record<string, number>
}

/** Serialize a PhaseDigest to a single narrator line: `[wt:digest] {json}`.
 *  Keys are emitted in a FIXED order so the same digest always produces the same
 *  bytes (deterministic — matters for resume/replay stability). This applies to the
 *  nested `counts` record too: its keys are sorted before stringify, so two callers
 *  that build the same counts in different insertion orders still emit identical
 *  bytes. Absent fields are omitted entirely (never `null`/`undefined` valued). */
export function formatDigest(d: PhaseDigest): string {
  const body: Record<string, unknown> = { stage: d.stage }
  if (d.output !== undefined) body.output = d.output
  if (d.taken !== undefined) body.taken = d.taken
  if (d.notTaken !== undefined) body.notTaken = d.notTaken
  if (d.counts !== undefined) {
    const counts = d.counts
    const sorted: Record<string, number> = {}
    for (const k of Object.keys(counts).sort()) {
      const v = counts[k]
      if (v !== undefined) sorted[k] = v
    }
    body.counts = sorted
  }
  return `${DIGEST_PREFIX} ${JSON.stringify(body)}`
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  if (!v.every((e) => typeof e === 'string')) return null
  return v as string[]
}

function asNumberRecord(v: unknown): Record<string, number> | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const out: Record<string, number> = {}
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'number' || !Number.isFinite(val)) return null
    out[k] = val
  }
  return out
}

/** Parse a narrator line back to a PhaseDigest, or null if it is not a digest.
 *  TOLERANT — never throws: a non-string, a line without the prefix, non-JSON
 *  after the prefix, a non-object payload, or a missing/empty `stage` all return
 *  null. Optional fields of the wrong shape are dropped (not fatal) EXCEPT that a
 *  malformed value simply does not populate its field — `stage` is the only
 *  required key. */
export function parseDigest(line: string): PhaseDigest | null {
  if (typeof line !== 'string') return null
  const trimmed = line.trim()
  if (!trimmed.startsWith(DIGEST_PREFIX)) return null
  const rest = trimmed.slice(DIGEST_PREFIX.length).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(rest)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const rec = parsed as Record<string, unknown>
  if (typeof rec.stage !== 'string' || rec.stage.length === 0) return null
  const out: PhaseDigest = { stage: rec.stage }
  if (typeof rec.output === 'string') out.output = rec.output
  const taken = asStringArray(rec.taken)
  if (taken !== null) out.taken = taken
  const notTaken = asStringArray(rec.notTaken)
  if (notTaken !== null) out.notTaken = notTaken
  const counts = asNumberRecord(rec.counts)
  if (counts !== null) out.counts = counts
  return out
}
