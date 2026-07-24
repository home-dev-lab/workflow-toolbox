// observe-await.ts — pure decision core for `wt-observe await <runId>` (the launch-and-notify
// increment): the CLI shell polls the server and hands each tick's observations here; this
// module decides pending / done / missing / timeout and the process exit code. Pure and
// synchronous — no fetch, no clock, no sleep — so the whole waiting contract is unit-tested
// without a server.
//
// Observation sources, in trust order:
//   - `live`: this runId's entry in GET /api/runs/live (the in-process registry — knows
//     `finished` authoritatively for server-launched runs, including failed ones whose
//     completion artifact never landed).
//   - `recallStatus`: GET /api/runs/:runId `status` (disk-backed recall — survives registry
//     eviction and also covers externally-launched/attached runs). `null` = 404/unreachable.
// A run visible in NEITHER source is only an error after `missingGraceMs` — right after
// POST /api/launch there can be a brief window before the registry entry is observable.

export interface AwaitObservation {
  /** This runId's GET /api/runs/live entry, null when absent. */
  live: { finished: boolean; status: string | null } | null
  /** GET /api/runs/:runId `status`, null when the recall 404s or wasn't fetched. */
  recallStatus: string | null
  elapsedMs: number
  timeoutMs: number
  missingGraceMs: number
  /** True when this tick's multi-source runId search left ≥1 LOCAL source UNPROBED — an
   *  I/O failure reaching it (timeout/5xx under load), NOT a confirmed "run not here".
   *  A run "visible nowhere" while a source could not be reached has UNKNOWN absence, so
   *  it must never read as a confident `missing` (the never-latch discipline
   *  source-resolve.ts already applies to `resolveSource`, card #1821784328170899045).
   *  Absent/false on single-source servers and whenever every source was reached, so the
   *  existing missing behavior is unchanged there. */
  sourcesUnprobed?: boolean
}

export type AwaitVerdict = { kind: 'pending' } | { kind: 'done'; status: string } | { kind: 'missing' } | { kind: 'timeout' }

/** Statuses that mean "still going" on the disk-recall side. Anything else non-null is
 *  treated as terminal — deliberately permissive so a new terminal status (e.g. a future
 *  'stopped' variant) ends the wait instead of hanging it.
 *  NOTE (pr-review round 3): stop-detect.ts's isTerminalStatus classifies a DIFFERENT
 *  feed (Stop-hook background_tasks) with the OPPOSITE unknown-polarity (unknown = NOT
 *  terminal, to avoid surfacing a live run prematurely). The two fail-safe directions
 *  are each correct for their consumer — a blocking `await` must never hang forever, a
 *  stop surface must never claim a live run ended — so the duplication is kept ON
 *  PURPOSE; do not unify without re-deciding both polarities. */
const NON_TERMINAL = new Set(['running', 'pending'])

export function classifyAwaitTick(obs: AwaitObservation): AwaitVerdict {
  // A terminal observation WINS over the timeout on the same tick (pr-review round 3):
  // the CLI fetched live/recall BEFORE computing elapsed, so when completion becomes
  // visible exactly as the budget crosses, the true outcome is already in hand —
  // discarding it for 'timeout' would trade a correct answer for a deadline formality.
  if (obs.live !== null) {
    if (obs.live.finished) {
      // A finished registry entry can still carry its LAST STREAMED status ('running' —
      // the registry's stop path flips `finished` without touching `status`). Never
      // parrot a non-terminal word for a finished run; recall refines it at print time.
      const s = obs.live.status
      return { kind: 'done', status: s === null || NON_TERMINAL.has(s) ? 'unknown' : s }
    }
    if (obs.elapsedMs > obs.timeoutMs) return { kind: 'timeout' }
    return { kind: 'pending' }
  }
  if (obs.recallStatus !== null && !NON_TERMINAL.has(obs.recallStatus)) {
    return { kind: 'done', status: obs.recallStatus }
  }
  if (obs.elapsedMs > obs.timeoutMs) return { kind: 'timeout' }
  if (obs.recallStatus !== null) return { kind: 'pending' } // running/pending on disk
  // Visible nowhere. If this tick's multi-source runId search left a source UNPROBED (an
  // I/O failure reaching it, not a confirmed miss), the run's absence is UNKNOWN — keep
  // polling rather than assert a confident `missing` (never-latch, card
  // #1821784328170899045). The overall timeout above still bounds the wait, so a source
  // that never recovers ends the await as `timeout` (exit 3), never a false `missing`.
  if (obs.sourcesUnprobed === true) return { kind: 'pending' }
  return obs.elapsedMs > obs.missingGraceMs ? { kind: 'missing' } : { kind: 'pending' }
}

/** Defensive pull of { status, io.result, error } from a GET /api/runs/:runId payload — the
 *  awaited run's verdict tail. `error` is the run-level failure reason (journal.error, surfaced
 *  by the recall endpoint since card #1821485224316372412) — the ONLY human-readable "why" for a
 *  boot/input failure that spawns zero agents (no agent transcript ever carries it). Never throws:
 *  a malformed payload degrades to nulls (the CLI still reports the terminal STATE it detected,
 *  just without the result body or the reason). */
export function extractAwaitOutcome(recall: unknown): { status: string | null; result: unknown; error: string | null } {
  if (typeof recall !== 'object' || recall === null) return { status: null, result: null, error: null }
  const r = recall as Record<string, unknown>
  const status = typeof r['status'] === 'string' ? r['status'] : null
  const io = r['io']
  const result = typeof io === 'object' && io !== null ? ((io as Record<string, unknown>)['result'] ?? null) : null
  const error = typeof r['error'] === 'string' ? r['error'] : null
  return { status, result, error }
}

/** Cap for the `error` reason echoed by `wt-observe await` (its stdout JSON field + the human
 *  stderr line). The recall `error` carries the workflow's full failure string INCLUDING its
 *  stack, which is unbounded — the CLI shows a bounded head and points at the run record for the
 *  rest (the complete string, stack and all, always survives durably there). */
export const AWAIT_ERROR_MAX_CHARS = 2000

export function truncateAwaitError(message: string, max = AWAIT_ERROR_MAX_CHARS): string {
  return message.length <= max
    ? message
    : `${message.slice(0, max)}… [truncated ${message.length - max} chars — full error in the run record]`
}

/** Stable exit-code contract (documented in the CLI usage string): 0 = completed,
 *  2 = terminal but not completed (failed/stopped/unknown), 3 = timeout, 4 = never seen,
 *  5 = source resolution failed/ambiguous (AWAIT_SOURCE_UNRESOLVED_EXIT_CODE). */
export function awaitExitCode(verdict: Exclude<AwaitVerdict, { kind: 'pending' }>): number {
  if (verdict.kind === 'timeout') return 3
  if (verdict.kind === 'missing') return 4
  return verdict.status === 'completed' ? 0 : 2
}

/** Card #1819922556652619607 — DISTINCT from `missing` (exit 4): `missing` means a
 *  resolved, reachable source genuinely never saw this runId (a real "not found"). This
 *  code means the source itself could not be confirmed/matched in the first place — the
 *  run's existence is UNKNOWN, not "confirmed absent". Thrown by source-resolve.ts's
 *  `resolveSource` as a `SourceResolutionError`, caught by `cmdAwait` before the poll
 *  loop even starts (never conflated with the polling verdicts above, which all assume
 *  the source was already resolved). */
export const AWAIT_SOURCE_UNRESOLVED_EXIT_CODE = 5

// ── recall-probe classification (card #1825812079798388423 — the await→missing bug) ────────

/** One GET /api/runs/:runId HTTP outcome, abstracted away from fetch/JSON-parsing (the CLI
 *  shell owns those — see fetchRecall in observe-cli.ts) so the classification stays pure and
 *  unit-tested like the rest of this module. `network-error` covers a thrown fetch (timeout,
 *  connection reset, or a malformed 200 body that failed to parse). */
export type RecallHttpOutcome = { kind: 'response'; ok: boolean; status: number; body: unknown } | { kind: 'network-error' }

export interface RecallProbeResult {
  /** True when this tick's answer is TRUSTWORTHY enough to treat as a confirmed observation
   *  (a real 200 body, or a real 404 with no launch record anywhere). False means the run's
   *  absence from this source is UNKNOWN this tick — the caller must feed it into the
   *  never-latch `sourcesUnprobed` gate (classifyAwaitTick), never a confident `missing`. */
  reached: boolean
  recall: unknown
}

/** Turn one recall HTTP outcome into a {reached, recall} verdict. Three outcomes collapse to
 *  the SAME `recall: null` but are NOT equivalent to the caller:
 *   (a) ok 404, no `code` — a genuine, confirmed "no record anywhere" → reached: true
 *   (b) ok 404 with `code: 'launch-record-present'` — the server's OWN on-disk launch record
 *       says this run WAS launched and not yet reaped, but the in-memory registry lookup that
 *       would confirm it live came up momentarily empty (a registry gap, not an absence) →
 *       reached: false
 *   (c) network-error, or any other non-200/404 status (5xx, timeout) — no trustworthy answer
 *       was obtained at all → reached: false
 *  Never throws — a malformed body degrades to `recall: null` with whatever `reached` the
 *  status alone implies.
 *
 *  Review finding (codex, card #1825812079798388423) — a body that IS present but is not a
 *  well-formed object can never be trusted, on EITHER status: a malformed 200 (this endpoint
 *  always returns a real object on success — a non-object body means something is badly wrong
 *  in transit, not a confirmed answer) degrades to reached: false instead of a false confirmed
 *  presence; a 404 whose body the caller could not even PARSE (see observe-cli.ts's fetchRecall,
 *  which routes that case through `network-error`) can never rule out a truncated
 *  `code:'launch-record-present'` tag, so it must not be treated as a confirmed absence either. */
export function classifyRecallProbe(outcome: RecallHttpOutcome): RecallProbeResult {
  if (outcome.kind === 'network-error') return { reached: false, recall: null }
  if (outcome.ok) {
    if (typeof outcome.body !== 'object' || outcome.body === null) return { reached: false, recall: null }
    return { reached: true, recall: outcome.body }
  }
  if (outcome.status === 404) {
    const code = typeof outcome.body === 'object' && outcome.body !== null ? (outcome.body as Record<string, unknown>)['code'] : undefined
    if (code === 'launch-record-present') return { reached: false, recall: null }
    return { reached: true, recall: null }
  }
  return { reached: false, recall: null }
}
