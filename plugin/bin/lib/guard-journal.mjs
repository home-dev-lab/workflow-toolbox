// guard-journal.mjs — the ONE shared, durable record of a guard REFUSAL or WARNING.
//
// WHY THIS EXISTS. Of the 18 guard hooks under plugin/bin/*guard*.mjs, 14 wrote nothing durable
// at all: a guard fires, prints its JSON payload, and the fact that it fired is gone the moment
// the transcript scrolls past it. The insight "this recurring defect deserves a mechanism" is a
// judgement call and cannot itself be mechanised — but REPETITION can be counted, and counting
// is what turns "I think this happened before" (an impression that erodes at every recurrence)
// into "this guard fired 3 times this week" (a number). This module is the write side of that
// count; wt-guard-journal-scan.mjs (its sibling in plugin/bin/) is the read side.
//
// WHAT IT RECORDS, DELIBERATELY NARROW. Only decision === 'blocked' | 'warned' — the two shapes
// a guard's OWN payload already names (a `permissionDecision: 'deny'`, or a warning surfaced via
// `additionalContext` / an `allow` with a warning reason). Anything else (a silent no-op, an
// internal "journal-only, allowed" bookkeeping entry some guards already keep for their own
// purpose) is not this module's concern — recordGuardEvent() no-ops on any other decision value,
// so a caller that passes the wrong string fails silently rather than polluting the count.
//
// FAIL-OPEN, STRUCTURALLY. A guard's whole POINT can be to refuse a dangerous command; if this
// journal's bookkeeping could throw, a guard that already decided to block/warn correctly could
// be made to fail on a full disk or a read-only home directory — worse than no journal at all.
// Same posture as plugin/bin/lib/fail-open-trace.mjs's writeFailOpenTrace(): every failure mode
// is swallowed, nothing here ever throws, and the call always returns.
//
// WEEKLY ROTATION, NDJSON, APPEND-ONLY. The question this journal answers is "has this recurred
// THIS WEEK" — rotation falls out of that for free, and gives an unbounded number of guard
// events an unbounded lifetime shape (old weeks age out by simply not being read, never deleted
// here). NDJSON append is the one shape that survives two concurrent sessions writing to the
// same file without a lock: `fs.appendFileSync` on a POSIX filesystem is atomic for writes this
// small, so two interleaved single-line appends land as two complete lines, never a torn one.
// Windows note in the cross-platform verdict below.
//
// CROSS-PLATFORM VERDICT (this plugin ships on Linux, Windows, macOS — see the project rule
// naming that requirement):
//   - Location: `path.join(os.homedir(), '.local', 'state', 'wt-guard-journal')`. `os.homedir()`
//     resolves correctly on all three platforms (it reads $HOME on Linux/macOS, %USERPROFILE% on
//     Windows) — this is the SAME base wt-main-guard-hook.mjs already uses for its own journal,
//     already exercised on this machine. The `.local/state` segment is a Linux/XDG naming
//     convention, not a Windows one, but it is not a Windows PATH VIOLATION either: Windows
//     filesystems accept arbitrary directory names, dotted or not, so the directory is created
//     and used successfully — it simply does not look native there. Verdict: WORKS on all three,
//     unconventional-but-functional on Windows, never throws, never silently returns a plausible
//     wrong value.
//   - Concurrency: POSIX small-append atomicity (no interleaved/torn lines) is a property of
//     Linux and macOS filesystems. NTFS's guarantee for concurrent small appends from separate
//     processes is not the same documented guarantee — two sessions racing a write on the SAME
//     millisecond, on Windows, is UNVERIFIED here and stated as such rather than assumed safe.
//     The single-writer case (the overwhelmingly common one — one guard, one hook invocation)
//     is unaffected on every platform.
//   - `WT_GUARD_JOURNAL_DIR` / `WT_GUARD_JOURNAL_NOW` env overrides exist for tests only (see
//     guard-journal.test.ts) — normal operation never sets them.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_REASON_LEN = 400

function baseDir() {
  const override = process.env.WT_GUARD_JOURNAL_DIR
  if (override) return override
  return path.join(os.homedir(), '.local', 'state', 'wt-guard-journal')
}

/** now(), overridable only for tests (WT_GUARD_JOURNAL_NOW) — never read in normal operation. */
function now() {
  const override = process.env.WT_GUARD_JOURNAL_NOW
  if (override) {
    const d = new Date(override)
    if (!Number.isNaN(d.getTime())) return d
  }
  return new Date()
}

// ISO-8601 week number (Monday-start, week 1 = the week containing the year's first Thursday).
// Used only as a filename key — "which week" needs no more precision than this.
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const dayNum = (d.getUTCDay() + 6) % 7 // Monday=0 .. Sunday=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3) // move to this week's Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3)
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000))
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function journalPath() {
  return path.join(baseDir(), `${isoWeekKey(now())}.ndjson`)
}

/**
 * Record ONE guard decision durably. NEVER throws, always returns.
 *
 * @param {object} event
 * @param {string} event.guard   - the guard's own filename (e.g. 'wt-main-guard-hook.mjs').
 *                                 Required — no guard name, no write.
 * @param {'blocked'|'warned'} event.decision - required, and the ONLY two values recorded.
 *                                 Any other value (including a guard's own internal
 *                                 'allowed-journaled'/'override-allow' bookkeeping) is a no-op
 *                                 here by design — this journal counts refusals and warnings,
 *                                 nothing else.
 * @param {string} [event.class]  - the guard's own classification of what it matched, if any.
 * @param {string} [event.reason] - free text, truncated to 400 chars.
 * @param {string} [event.cwd]    - the cwd the decision was made in, if known.
 */
export function recordGuardEvent({ guard, decision, class: cls, reason, cwd } = {}) {
  try {
    if (!guard || (decision !== 'blocked' && decision !== 'warned')) return
    const dir = baseDir()
    fs.mkdirSync(dir, { recursive: true })
    const entry = {
      ts: now().toISOString(),
      guard,
      decision,
      ...(cls ? { class: cls } : {}),
      ...(reason ? { reason: String(reason).slice(0, MAX_REASON_LEN) } : {}),
      ...(cwd ? { cwd } : {}),
    }
    fs.appendFileSync(journalPath(), `${JSON.stringify(entry)}\n`)
  } catch {
    // Journalling must NEVER be the reason a guard's own decision fails to render. Same
    // fail-open posture as writeFailOpenTrace() in fail-open-trace.mjs.
  }
}

// Exposed for the reader (wt-guard-journal-scan.mjs) and for tests — never for a guard hook.
export const __internal = { baseDir, isoWeekKey, journalPath, now }
