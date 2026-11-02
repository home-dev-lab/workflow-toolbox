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

// A PLAN CAN LACK A WINDOW, and that is not a partial reading. A subscription plan may have no
// five-hour limit and be managed on the seven-day window alone. The probe STATES such a window
// absent with exactly one shape: the literal `null` for that window key (`five_hour: null`).
// Rejecting such a reading whole left the watcher blind to the seven-day window too.
//
// Everything else is a window the reading failed to deliver, and degrades: an omitted key (the probe
// said nothing — the bundled probe keeps an omitted API key omitted, so a window the endpoint
// silently dropped is never taken for plan absence), a non-object, and ANY object, including the
// empty-looking `{ pct: null, resets_at: null }` (with or without `pctRaw`): an object says the
// window exists and its reading is unusable. Treating the empty object as absence let a dropped
// window read as "not part of this plan", wiped its crossing history, and spread through the shared
// cache to every other watcher (cross-family review, 2026-11-02). Only the windows listed below may
// be absent from a plan; the seven-day window is the one a plan is managed by, so a reading without
// it is never usable.
export const PLAN_OPTIONAL_WINDOW_KEYS = ['five_hour']

const WINDOW_WORDS = { five_hour: '5-hour', seven_day: '7-day' }

/** @returns {boolean} true only for the literal `null`, the one shape that states a window does not exist. */
export function isStatedAbsentWindow(value) {
  return value === null
}

/**
 * @param {unknown} source a probe-shaped reading (live or cached)
 * @param {string[]} [optionalKeys] defaults to PLAN_OPTIONAL_WINDOW_KEYS
 * @returns {string[]} the optional window keys this reading states are not part of the plan
 */
export function windowsAbsentFromPlan(source, optionalKeys = PLAN_OPTIONAL_WINDOW_KEYS) {
  if (source === null || typeof source !== 'object') return []
  return optionalKeys.filter((key) => Object.hasOwn(source, key) && isStatedAbsentWindow(source[key]))
}

/**
 * @param {Record<string, unknown>} windows a windows object as produced by extractWindows
 * @param {string[]} [absentFromPlan] keys the probe stated are not part of the plan
 * @param {string[]} [watchedKeys] defaults to WATCHED_WINDOW_KEYS
 * @returns {string[]} watched keys neither present nor stated absent
 */
export function missingWindows(windows, absentFromPlan = [], watchedKeys = WATCHED_WINDOW_KEYS) {
  if (windows === null || typeof windows !== 'object') return [...watchedKeys]
  return watchedKeys.filter((key) => !(key in windows) && !absentFromPlan.includes(key))
}

/**
 * @param {Record<string, unknown>} windows a windows object as produced by extractWindows
 *   (keyed by window key, e.g. { five_hour: {...}, seven_day: {...} })
 * @param {string[]} [watchedKeys] defaults to WATCHED_WINDOW_KEYS
 * @param {string[]} [absentFromPlan] keys the probe stated are not part of the plan
 * @returns {boolean} true only if EVERY watched key is present or stated absent from the plan —
 *   never true for a partial reading, however many windows it does contain
 */
export function hasCompleteWindows(windows, watchedKeys = WATCHED_WINDOW_KEYS, absentFromPlan = []) {
  if (windows === null || typeof windows !== 'object') return false
  return missingWindows(windows, absentFromPlan, watchedKeys).length === 0
}

/** "the 5-hour window" /"the 5-hour and 7-day windows", in words for the reader. */
export function windowsInWords(keys) {
  const words = keys.map((key) => WINDOW_WORDS[key] ?? key)
  return `the ${words.join(' and ')} window${words.length > 1 ? 's' : ''}`
}

/**
 * @param {string[]} previous keys absent from the plan at the previous reading
 * @param {string[]} current keys absent from the plan now
 * @returns {{ left: string[], returned: string[] }} windows that just left, or came back to, the plan
 */
export function planWindowChanges(previous, current) {
  return {
    left: current.filter((key) => !previous.includes(key)),
    returned: previous.filter((key) => !current.includes(key)),
  }
}
