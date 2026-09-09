// quota-drop.mjs — classify a DROP in a usage percentage between two polls.
//
// A percentage that falls between two polls has more than one cause: the window genuinely
// reset (capacity available), or the READING now describes something else — another account,
// another binding of the proxy session, another source. The watcher used to print
// `QUOTA RESET … new window, capacity available` on any drop along the proxy route, and a
// consumer measured it wrong: 42 % → 32 % at 18:41 while the previously reported reset time
// (14/09 20:00) had not come yet, and the reset time itself jumped to a different window
// (16/09 08:27). A window cannot reset before its own reset time, so that drop was a change of
// SUBJECT, not a reset — and the line asserted fresh capacity to every session that read it.
//
// The discriminator is time, not the size of the drop: a drop observed BEFORE the previously
// reported reset time is not a reset of that window. A drop observed at or after it is. When
// no reset time was reported the cause stays undetermined, and the line says so.
//
// Pure, no I/O; the watcher passes what it stored from the previous poll.

/** Epoch milliseconds from a `resets_at` value: ISO string, epoch seconds, or epoch millis. */
export function resetsAtToMs(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string') {
    const asNumber = Number(value)
    if (value.trim() !== '' && Number.isFinite(asNumber)) return asNumber < 1e12 ? asNumber * 1000 : asNumber
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * @returns {{ kind: 'reset' | 'not-a-reset' | 'undetermined', detail: string }}
 */
export function classifyQuotaDrop({ nowMs, previousResetsAt, currentResetsAt, previousPct, currentPct }) {
  const previousMs = resetsAtToMs(previousResetsAt)
  const currentMs = resetsAtToMs(currentResetsAt)
  const change = `${currentPct}% (was ${previousPct}%)`
  if (previousMs === null) {
    return { kind: 'undetermined', detail: `${change} — cause undetermined: no reset time was reported for the previous reading (reset or source change)` }
  }
  if (nowMs < previousMs) {
    const previousLabel = new Date(previousMs).toISOString()
    const currentLabel = currentMs === null ? 'none' : new Date(currentMs).toISOString()
    return { kind: 'not-a-reset', detail: `${change} — NOT a reset: the window was due to reset at ${previousLabel} and that time has not come (reading now reports ${currentLabel}); the source, account or binding changed — capacity not asserted` }
  }
  return { kind: 'reset', detail: `${change} — new window, capacity available` }
}
