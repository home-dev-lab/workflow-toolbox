// autonomy-mandate.mjs — the ONE place that decides whether a mandate marker is live, expired,
// or absent, and who declared it. Shared by wt-autonomy-arm.mjs (`--status`) and
// wt-autonomy-watch.mjs (the poll gate and the arming banner).
//
// WHY THIS EXISTS. The two callers used to each carry their own copy of "is this marker still
// fresh". They drifted: the watcher correctly read the marker's `declaredAtMs` field and reported
// `mandate=stale(540min) · CANNOT FIRE` on an expired mandate, while `--status` still read the
// marker's mere EXISTENCE and reported `armed`. Both statements were about the exact same file at
// the exact same instant. A reader asking "do I still have a mandate?" got a confident, wrong
// answer from the tool built specifically to answer that question — worse than no status command,
// because it produces belief instead of an honest "I don't know". A duplicated freshness check
// does not fail loudly; it drifts silently until two readouts disagree, which is what happened
// here. This module is the fix: one classification, two callers, no second copy to drift again.
//
// THREE STATES, distinct because each calls for a different reader action:
//   'live'    — present, inside the freshness window. Nothing to do.
//   'expired' — present on disk, past the freshness window. Will NOT fire. Re-arm.
//   'absent'  — no marker, or the file could not be parsed as one. Arm it.
// 'absent' also covers an unreadable/malformed file — a marker this module cannot trust to state
// its own age is treated exactly like no marker at all, never as a guessed 'live'.

import { existsSync, readFileSync } from 'node:fs'

/** Reads and validates the marker's content. Returns null on anything short of a well-formed
 *  record — missing file, unparseable JSON, or either required field absent/wrong-typed. Never
 *  reads mtime: a marker's freshness and provenance live in its CONTENT (`declaredAtMs`,
 *  `sessionId`), because a file can be copied or touched without a real re-declaration behind it. */
export function readMandateRecord(mandatePath) {
  if (!existsSync(mandatePath)) return null
  let parsed
  try {
    parsed = JSON.parse(readFileSync(mandatePath, 'utf8'))
  } catch {
    return null
  }
  const declaredAtMs = parsed?.declaredAtMs
  const sessionId = parsed?.sessionId
  if (typeof declaredAtMs !== 'number' || !Number.isFinite(declaredAtMs)) return null
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  return { declaredAtMs, sessionId }
}

/** Classifies a mandate marker at `mandatePath` as of `now`, against `freshnessMs`, from the point
 *  of view of `currentSessionId` (used only to tell own-session vs inherited apart — it never
 *  affects live/expired/absent). Returns:
 *    { kind: 'absent' }
 *    { kind: 'live'    | 'expired', declaredBy, declaredAtMs, ageMin, inherited }
 *  `ageMin` is unrounded (minutes) — callers format it (`.toFixed(0)`) so both readouts render the
 *  SAME age string for the SAME record, rather than each rounding independently. */
export function classifyMandate(mandatePath, freshnessMs, now, currentSessionId) {
  const record = readMandateRecord(mandatePath)
  if (!record) return { kind: 'absent' }
  const ageMin = (now - record.declaredAtMs) / 60_000
  const inherited = record.sessionId !== currentSessionId
  const kind = now - record.declaredAtMs > freshnessMs ? 'expired' : 'live'
  return { kind, declaredBy: record.sessionId, declaredAtMs: record.declaredAtMs, ageMin, inherited }
}
