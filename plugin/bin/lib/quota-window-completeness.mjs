// quota-window-completeness.mjs — "is this reading usable, and which watched windows did it not
// carry", extracted so it is directly unit-testable without driving the watcher's real process
// (which only observably behaves through end-to-end fixtures and, for the baseline-vs-steady-state
// distinction, real process timing).
//
// EACH WINDOW IS WATCHED ON ITS OWN (card 1899394115301279304, round 3). A reading used to be judged
// WHOLE: one window without a numeric percentage made it DEGRADED, and the watcher watched nothing,
// the window it did carry included. No source can say a window is absent from a plan: the rate-limit
// headers omit a window the plan lacks, and the host documents omission as also meaning "its reset
// passed". So a window without a numeric percentage is only "not reported by the probe": the watcher
// says so once, in words, keeps that window's crossing and reset history, and keeps watching every
// window that IS reported. Only a reading with no numeric window at all is unusable.
//
// The older finding still holds in its new form (cross-family review, 2026-07-31): a partial reading
// must never stop watching a window SILENTLY. The missing window is named in words, and the cache
// door below refuses a cached reading that lacks a window the previous reading carried, so a partial
// cache written by another process can never blind a window the live probe still reports.

/** The windows this watcher tracks. Kept here (not derived from wt-quota-watch.mjs's own
 * WINDOWS array) so this file has no dependency on the executable script — it is a pure,
 * standalone unit. If wt-quota-watch.mjs's WINDOWS ever changes, update this list too. */
export const WATCHED_WINDOW_KEYS = ['five_hour', 'seven_day']

const WINDOW_WORDS = { five_hour: '5-hour', seven_day: '7-day' }

/**
 * @param {Record<string, unknown>} windows a windows object as produced by extractWindows
 * @param {string[]} [watchedKeys] defaults to WATCHED_WINDOW_KEYS
 * @returns {string[]} the watched keys this reading did not carry
 */
export function missingWindows(windows, watchedKeys = WATCHED_WINDOW_KEYS) {
  if (windows === null || typeof windows !== 'object') return [...watchedKeys]
  return watchedKeys.filter((key) => !(key in windows))
}

/**
 * @param {Record<string, unknown>} windows a windows object as produced by extractWindows
 *   (only windows with a numeric pct are in it)
 * @param {string[]} [requiredKeys] windows the reading must also carry: the cache door passes the
 *   windows the previous reading carried
 * @returns {boolean} true when the reading carries at least one watched window and every required one
 */
export function isUsableReading(windows, requiredKeys = []) {
  if (missingWindows(windows).length === WATCHED_WINDOW_KEYS.length) return false
  return missingWindows(windows, requiredKeys).length === 0
}

/** "the 5-hour window" /"the 5-hour and 7-day windows", in words for the reader. */
export function windowsInWords(keys) {
  const words = keys.map((key) => WINDOW_WORDS[key] ?? key)
  return `the ${words.join(' and ')} window${words.length > 1 ? 's' : ''}`
}
