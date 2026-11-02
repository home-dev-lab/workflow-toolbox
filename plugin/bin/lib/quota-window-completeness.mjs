// Shared completeness policy for cached and live quota readings. Seven-day usage is
// required to establish health. Five-hour usage is optional because some accounts no
// longer expose that window; when available it is still watched for events.

/** The watcher's event population, including optional windows. */
export const WATCHED_WINDOW_KEYS = ['five_hour', 'seven_day']
export const REQUIRED_WINDOW_KEYS = ['seven_day']

/** Missing keys, null windows and explicit null percentages mean not exposed by design. */
export function isUnexposedWindow(value) {
  return value === undefined || value === null ||
    (typeof value === 'object' && !Array.isArray(value) && value.pct === null)
}

function hasNumericPercentage(value) {
  return typeof value?.pct === 'number' && Number.isFinite(value.pct)
}

/** Diagnose raw probe data before extraction can discard a malformed optional window. */
export function incompleteWindowKeys(windows, requiredKeys = REQUIRED_WINDOW_KEYS) {
  const keys = [...new Set([...WATCHED_WINDOW_KEYS, ...requiredKeys])]
  return keys.filter((key) => {
    if (hasNumericPercentage(windows[key])) return false
    return requiredKeys.includes(key) || !isUnexposedWindow(windows[key])
  })
}

/**
 * @param {Record<string, unknown>} windows raw probe windows, before invalid values are dropped
 * @param {string[]} [requiredKeys] defaults to REQUIRED_WINDOW_KEYS
 * @returns {boolean} true only if required windows are numeric and supplied optional ones are usable
 */
export function hasCompleteWindows(windows, requiredKeys = REQUIRED_WINDOW_KEYS) {
  if (windows === null || typeof windows !== 'object' || Array.isArray(windows)) return false
  return incompleteWindowKeys(windows, requiredKeys).length === 0
}
