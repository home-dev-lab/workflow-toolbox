/** The windows the quota watcher tracks. */
export const WATCHED_WINDOW_KEYS: readonly string[]

/** The windows a plan may legitimately not have (a plan without a five-hour limit). */
export const PLAN_OPTIONAL_WINDOW_KEYS: readonly string[]

/** True only for the literal `null`: the one probe window value that states the window does not exist. */
export function isStatedAbsentWindow(value: unknown): boolean

/** The optional window keys this reading states are not part of the plan. */
export function windowsAbsentFromPlan(source: unknown, optionalKeys?: readonly string[]): string[]

/** Watched keys neither present in `windows` nor stated absent from the plan. */
export function missingWindows(windows: unknown, absentFromPlan?: readonly string[], watchedKeys?: readonly string[]): string[]

/** True only if every watched key is present or stated absent from the plan. */
export function hasCompleteWindows(windows: unknown, watchedKeys?: readonly string[], absentFromPlan?: readonly string[]): boolean

/** "the 5-hour window" / "the 5-hour and 7-day windows". */
export function windowsInWords(keys: readonly string[]): string

/** Windows that just left, or came back to, the plan between two readings. */
export function planWindowChanges(previous: readonly string[], current: readonly string[]): { left: string[], returned: string[] }
