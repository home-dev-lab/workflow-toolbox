// quota-cache-tolerance.mjs — how old a cached usage reading the QUOTA WATCHER (not the
// per-turn hook) will accept before it insists on a live probe.
//
// WHY A SEPARATE, LARGER TOLERANCE THAN THE HOOK'S OWN TTL. The per-turn hook
// (inject-context-quota.mjs, private) displays a number to a human on every turn, so it
// wants a RECENT one — its 300s TTL exists to throttle a human-facing refresh rate, not to
// bound the SAFETY of acting on the number. The watcher exists only to notice a THRESHOLD
// CROSSING or a WINDOW RESET — a coarse, slow-moving signal: the five-hour and seven-day
// usage windows move over hours to days, not seconds. A reading several minutes old serves
// that purpose exactly as well as one from a few seconds ago.
//
// THE DEFECT THIS FIXES (measured 2026-07-31). The watcher was reading the cache with the
// hook's own 300s TTL, and its own default poll interval is ALSO 300s — the worst possible
// pairing: the watcher wakes, by construction, at almost exactly the moment its cached
// reading expires, so it probes live on nearly every cycle. A 429 followed. The watcher's
// own tolerance never having been distinguished from the hook's was the bug; matching the
// hook's TTL was a reasonable first reading of "a fresh reading suppresses the probe", but
// "fresh" was never defined as "fresh for whom".
//
// THE BOUND: max(the hook's own TTL, this watcher's poll interval) × 3.
//   - Taking the MAX keeps the watcher's tolerance always at or above the hook's 300s floor
//     — it never insists on fresher data than the hook itself already treats as current.
//   - Scaling by the POLL INTERVAL keeps the bound proportional to whatever cadence this
//     particular watcher was armed with: a watcher polling once an hour tolerating an
//     hour-old reading is exactly as conservative, relatively, as the default watcher
//     tolerating a few minutes — a fixed constant would collide again the moment someone
//     configured a --poll larger than it.
//   - The ×3 margin is what actually fixes the collision: it guarantees the tolerance
//     exceeds ONE poll interval by a comfortable amount regardless of what either value is,
//     so at most 1 in 3 poll cycles needs a live probe once the cache is warm. The price is
//     a worst-case threshold-detection lag of up to 2 extra poll intervals — on a window
//     that moves over hours, a few extra minutes is not the safety margin that matters
//     here; hammering an endpoint until it 429s is.
//
// This lives OUTSIDE quota-cache.mjs on purpose: the cache lib's job is to read/write a
// caller-supplied TTL faithfully (it already takes one as a parameter) and stay agnostic
// about who's asking. Deciding HOW MUCH staleness is acceptable is a policy call that
// belongs to the specific consumer — here, the watcher — not to the shared cache mechanism.
//
// SECOND DEFECT, cross-family review (2026-07-31): the ×3-of-poll bound above has NO upper
// limit — it inherits whatever `--poll` the operator passes. With `--poll 3600`, the
// tolerance becomes 3 hours: a cache warmed at 79% could sit unrefreshed while real usage
// crosses 80% and 90% AND the five-hour window resets, and the watcher — trusting a 3-hour-
// old reading — would never observe any of it, only the post-reset value. A reading older
// than the window's own dynamics cannot detect anything that happened inside it; scaling
// the tolerance by the poll interval alone has no bound that prevents this, because nothing
// ties it to how fast the WATCHED SIGNAL itself can move.
//
// THE CAP: the tolerance is also capped at a small, fixed fraction of the SHORTER of the two
// windows this watcher tracks (the five-hour window — the account's usage windows are five
// hours and seven days; if a shorter window is ever added to WINDOWS in wt-quota-watch.mjs,
// update SHORTEST_WATCHED_WINDOW_MS here too). 1/20th of 5h = 15 minutes: short enough that
// even a maximally-stale cache reading cannot span a meaningful fraction of the window's own
// reset cadence, so the crossing-then-reset race described above shrinks from "up to 3 hours
// of blind spot" to "at most 15 minutes, regardless of what --poll is configured". This is
// deliberately NOT proportional to poll — that is the property that failed. A large --poll
// still reduces network traffic exactly as intended (SUIVI 2); it can no longer buy an
// unbounded blind spot as a side effect.
//
// Exported so tests can assert against the REAL constant rather than a copy of the number.

import { DEFAULT_CACHE_TTL_MS } from './quota-cache.mjs'

const TOLERANCE_MULTIPLIER = 3

// The account's five-hour usage window — the shorter of the two windows wt-quota-watch.mjs
// tracks (WINDOWS: five_hour, seven_day). Kept here rather than derived, because this file
// has no visibility into the watcher's WINDOWS list; see the header comment above for the
// coupling this creates and what to do if that list ever changes.
export const SHORTEST_WATCHED_WINDOW_MS = 5 * 60 * 60 * 1000

const MAX_TOLERANCE_FRACTION_OF_SHORTEST_WINDOW = 1 / 20 // 15 min for a 5h window

export const MAX_TOLERANCE_MS = SHORTEST_WATCHED_WINDOW_MS * MAX_TOLERANCE_FRACTION_OF_SHORTEST_WINDOW

/**
 * @param {number} pollSeconds the watcher's configured poll interval, in seconds
 * @returns {number} the maximum age (ms) of a cached reading this watcher will still use
 *   instead of probing live — always <= MAX_TOLERANCE_MS, regardless of how large
 *   pollSeconds is
 */
export function computeWatcherCacheToleranceMs(pollSeconds) {
  const pollMs = pollSeconds * 1000
  const proportional = Math.max(DEFAULT_CACHE_TTL_MS, pollMs) * TOLERANCE_MULTIPLIER
  return Math.min(proportional, MAX_TOLERANCE_MS)
}
