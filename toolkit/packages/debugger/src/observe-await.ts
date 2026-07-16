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
  return obs.elapsedMs > obs.missingGraceMs ? { kind: 'missing' } : { kind: 'pending' }
}

/** Defensive pull of { status, io.result } from a GET /api/runs/:runId payload — the
 *  awaited run's verdict tail. Never throws: a malformed payload degrades to nulls (the
 *  CLI still reports the terminal STATE it detected, just without the result body). */
export function extractAwaitOutcome(recall: unknown): { status: string | null; result: unknown } {
  if (typeof recall !== 'object' || recall === null) return { status: null, result: null }
  const r = recall as Record<string, unknown>
  const status = typeof r['status'] === 'string' ? r['status'] : null
  const io = r['io']
  const result = typeof io === 'object' && io !== null ? ((io as Record<string, unknown>)['result'] ?? null) : null
  return { status, result }
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
