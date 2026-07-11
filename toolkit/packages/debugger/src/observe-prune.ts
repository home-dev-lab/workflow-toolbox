// observe-prune.ts — PURE selection logic for `wt-observe prune`, the verb that deletes
// test/probe workflow run records so they stop lingering in the observe "recent runs".
//
// A run lives on disk as three sibling artifacts under a config dir (ground truth: run-attach.ts):
//   <configDir>/projects/<slug>/<sessionId>/workflows/<runId>.json            — completion record (what the timeline lists)
//   <configDir>/projects/<slug>/<sessionId>/workflows/scripts/<name>-<runId>.js — the launch script (carries the workflow NAME)
//   <configDir>/projects/<slug>/<sessionId>/subagents/workflows/<runId>/       — the per-agent transcript sidecar dir
// The workflow's `meta.name` is recoverable from the SCRIPT filename (cheaper + more reliable
// than parsing the JSON), which is what lets `--name-prefix` target test runs precisely.
//
// This module is PURE (no fs) so the selection contract is unit-tested directly; the scan +
// unlink live in observe-cli's cmdPrune. NB this is a SEPARATE scan from run-attach's
// findLaunchSeed (that one is one-live-session-scoped for attach; prune walks ALL historical
// runs across every session/project) — different reason to change, so deliberately not shared.

/** A discovered run and the on-disk paths that constitute it. `name` is the workflow's
 *  `meta.name` recovered from the script filename, or null when no script artifact was found
 *  (a run with no recoverable name can only be pruned by explicit `--run <id>`, never by prefix). */
export type PruneRunRecord = {
  runId: string
  name: string | null
  mtimeMs: number
  jsonPath: string
  scriptPath: string | null
  sidecarDir: string
}

/** Reserved `meta.name` prefixes for throwaway/test/probe workflows. `prune` with no explicit
 *  `--name-prefix` (and no `--run`) targets ONLY these, so a production run is never deleted by
 *  default. Author test workflows as `probe-*` / `_probe-*` / `_test-*` to make them auto-prunable. */
export const DEFAULT_TEST_PREFIXES: readonly string[] = ['probe-', '_probe-', '_test-']

export type PruneCriteria = {
  /** Exact run id — when set, matches that one run and ignores every other criterion (the escape hatch). */
  runId?: string | null
  /** Name prefixes to match. Empty/absent → DEFAULT_TEST_PREFIXES (safe: test runs only).
   *  An explicit `['']` matches ALL names (the documented "prune everything" escape hatch). */
  namePrefixes?: readonly string[] | null
  /** Only runs at least this old (nowMs - mtimeMs >= olderThanMs). Absent → no age bound. */
  olderThanMs?: number | null
  nowMs: number
}

/** Select the runs to delete. `runId` is exact and wins outright. Otherwise a run matches when
 *  its name starts with one of the prefixes AND (if an age bound is given) it is old enough.
 *  The name/prefix gate ALWAYS applies (defaulting to the reserved test prefixes), so age alone
 *  can never sweep a production run — that requires an explicit `--name-prefix` or `--run`. */
export function selectRuns(records: readonly PruneRunRecord[], criteria: PruneCriteria): PruneRunRecord[] {
  if (criteria.runId) return records.filter((r) => r.runId === criteria.runId)
  const prefixes =
    criteria.namePrefixes && criteria.namePrefixes.length > 0 ? criteria.namePrefixes : DEFAULT_TEST_PREFIXES
  const hasAge = typeof criteria.olderThanMs === 'number' && criteria.olderThanMs >= 0
  return records.filter((r) => {
    const nameOk = r.name != null && prefixes.some((p) => r.name!.startsWith(p))
    const ageOk = !hasAge || criteria.nowMs - r.mtimeMs >= (criteria.olderThanMs as number)
    return nameOk && ageOk
  })
}

/** Recover a workflow's `meta.name` from its script filename: `<name>-<runId>.js` → `<name>`.
 *  Returns null when the filename does not carry the given runId suffix (so a mismatched or
 *  malformed script never yields a bogus name). */
export function runNameFromScript(scriptFilename: string, runId: string): string | null {
  const suffix = `-${runId}.js`
  if (!scriptFilename.endsWith(suffix)) return null
  const name = scriptFilename.slice(0, -suffix.length)
  return name.length > 0 ? name : null
}

/** Parse a compact duration (`45s`, `30m`, `2h`, `7d`, or a bare integer = ms) to milliseconds.
 *  Returns null on anything unparseable (a caller surfaces that as a usage error, never a
 *  silent 0 that would make `--older-than` match everything). */
export function parseDurationMs(input: string): number | null {
  const m = /^(\d+)(ms|s|m|h|d)?$/.exec(input.trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2] ?? 'ms'
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] as number
  return n * mult
}

/** The on-disk paths to unlink for a run (existing ones only), newest-safe: the JSON record, the
 *  script artifact (if known), and the sidecar transcript dir. Pure — the deleter rm's each. */
export function pathsToDelete(record: PruneRunRecord): string[] {
  return [record.jsonPath, record.scriptPath, record.sidecarDir].filter((p): p is string => typeof p === 'string')
}
