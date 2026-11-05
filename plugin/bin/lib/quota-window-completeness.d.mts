/** The windows the quota watcher tracks. */
export const WATCHED_WINDOW_KEYS: readonly string[]

/** The watched keys a reading did not carry. */
export function missingWindows(windows: unknown, watchedKeys?: readonly string[]): string[]

/** True when the reading carries at least one watched window and every required one. */
export function isUsableReading(windows: unknown, requiredKeys?: readonly string[]): boolean

/** "the 5-hour window" / "the 5-hour and 7-day windows". */
export function windowsInWords(keys: readonly string[]): string
