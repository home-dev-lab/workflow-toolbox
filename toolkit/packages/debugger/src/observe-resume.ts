// observe-resume.ts — PURE decision core for `wt-observe resume <runId>` (card
// #1819953357465323377): the CLI shell (observe-cli.ts's cmdResume) POSTs
// /api/runs/:runId/recover and hands this module the response's {status, ok, code} to
// decide the process exit code. Pure and synchronous — no fetch, no I/O — so the mapping
// is unit-tested without a server, same split as observe-await.ts's awaitExitCode /
// observe-prune.ts's selection logic (the CLI shell owns HTTP + fs; the verb's own file
// owns the decision).
//
// DISTINCT from `wt-observe await`'s own exit-code contract (observe-await.ts) — a resume
// is a single accept/refuse DISPATCH decision, never a poll loop, so there is no 'timeout'
// or 'pending' state here. The refusal reasons themselves (not-failed, no-disk-state,
// already-running, not-allowlisted, resume-budget-exhausted, launch-disabled, pro-required)
// live server-side (workflow-observatory's app.ts handleRecoverRun / resume-recovery.ts's
// RecoveryRefusalReason) — this module only decides the COARSE exit code a shell script
// branches on; the printed JSON line's own `code` field always carries the exact reason.

/** A run genuinely refused for a NAMED reason (409/402/403/429, or a 404 whose `code` is
 *  something OTHER than 'not-found' — e.g. 'not-allowlisted', where the run's journal DOES
 *  exist but its workflow no longer does). */
export const RECOVER_REFUSED_EXIT_CODE = 2
/** No journal exists for this runId at all (server: 404, code:'not-found') — mirrors
 *  `wt-observe await`'s own "never seen" (exit 4), the closest existing analogue. */
export const RECOVER_NOT_FOUND_EXIT_CODE = 4

/**
 * Map a POST /api/runs/:runId/recover HTTP outcome to the CLI's exit code. `ok` is
 * `res.ok` (2xx); `status` is the HTTP status; `code` is the response body's own `code`
 * field when present (undefined on a malformed/codeless body — degrades to the generic
 * refused bucket, never thrown). Never called for the source-unresolved case — that
 * short-circuits BEFORE any HTTP call (AWAIT_SOURCE_UNRESOLVED_EXIT_CODE, observe-await.ts,
 * reused as-is by cmdResume — a resume shares await's source-resolution outcome, not its
 * own).
 */
export function recoverExitCodeFor(status: number, ok: boolean, code: string | undefined): number {
  if (ok) return 0
  if (status === 404 && code === 'not-found') return RECOVER_NOT_FOUND_EXIT_CODE
  return RECOVER_REFUSED_EXIT_CODE
}
