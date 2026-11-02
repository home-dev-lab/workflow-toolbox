// Shared completeness policy for cached and live quota readings. Seven-day usage is
// required to establish health. Five-hour usage is optional because some accounts no
// longer expose that window; when available it is still watched for events.

/** The watcher's event population, including optional windows. */
export const WATCHED_WINDOW_KEYS = ['five_hour', 'seven_day']
export const REQUIRED_WINDOW_KEYS = ['seven_day']

/**
 * @param {Record<string, unknown>} windows a windows object as produced by extractWindows
 *   (keyed by window key, e.g. { five_hour: {...}, seven_day: {...} })
 * @param {string[]} [requiredKeys] defaults to REQUIRED_WINDOW_KEYS
 * @returns {boolean} true only if every required window has a finite numeric percentage
 */
export function hasCompleteWindows(windows, requiredKeys = REQUIRED_WINDOW_KEYS) {
  if (windows === null || typeof windows !== 'object' || Array.isArray(windows)) return false
  return requiredKeys.every((key) => typeof windows[key]?.pct === 'number' && Number.isFinite(windows[key].pct))
}
