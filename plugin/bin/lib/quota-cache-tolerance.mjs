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

import { DEFAULT_CACHE_TTL_MS } from './quota-cache.mjs'

const TOLERANCE_MULTIPLIER = 3

/**
 * @param {number} pollSeconds the watcher's configured poll interval, in seconds
 * @returns {number} the maximum age (ms) of a cached reading this watcher will still use
 *   instead of probing live
 */
export function computeWatcherCacheToleranceMs(pollSeconds) {
  const pollMs = pollSeconds * 1000
  return Math.max(DEFAULT_CACHE_TTL_MS, pollMs) * TOLERANCE_MULTIPLIER
}
