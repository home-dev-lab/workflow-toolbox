// quota-window-completeness.mjs — "does this reading cover every window the watcher
// tracks", extracted so it is directly unit-testable without driving the watcher's real
// process (which only observably behaves through end-to-end fixtures and, for the
// baseline-vs-steady-state distinction, real process timing).
//
// FINDING (cross-family review, 2026-07-31): a reading — cached OR freshly probed —
// covering only SOME of the watched windows used to be accepted as a success: the check
// was "at least one window present", not "every window present". That silently stopped
// watching whichever window was missing — its prior threshold/last-pct state got cleared
// with no DEGRADED line, so it could cross every threshold and reset while the process
// reported nothing at all. "Some windows present" must never count as success.

/** The windows this watcher tracks. Kept here (not derived from wt-quota-watch.mjs's own
 * WINDOWS array) so this file has no dependency on the executable script — it is a pure,
 * standalone unit. If wt-quota-watch.mjs's WINDOWS ever changes, update this list too; the
 * watcher imports and uses THIS list as the source of truth for "complete", so a drift
 * here is the only way the two could disagree. */
export const WATCHED_WINDOW_KEYS = ['five_hour', 'seven_day']

/**
 * @param {Record<string, unknown>} windows a windows object as produced by extractWindows
 *   (keyed by window key, e.g. { five_hour: {...}, seven_day: {...} })
 * @param {string[]} [watchedKeys] defaults to WATCHED_WINDOW_KEYS
 * @returns {boolean} true only if EVERY watched key is present — never true for a partial
 *   reading, however many windows it does contain
 */
export function hasCompleteWindows(windows, watchedKeys = WATCHED_WINDOW_KEYS) {
  if (windows === null || typeof windows !== 'object') return false
  return watchedKeys.every((key) => key in windows)
}
