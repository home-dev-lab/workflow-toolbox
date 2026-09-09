// quota-drop.mjs — classify a DROP in a usage percentage between two polls.
//
// A percentage that falls between two polls has more than one cause: the window genuinely
// reset (capacity available), a provider reset it by hand before its own deadline (observed on
// CLIProxy, 2026-09-09 morning), or the READING now describes something else — another account,
// another binding of the proxy session, another source. The watcher used to print
// `QUOTA RESET … new window, capacity available` on any drop along the proxy route, and a
// consumer measured it wrong: 42 % → 32 % at 18:41 while the previously reported reset time
// (14/09 20:00) had not come and the reset time itself jumped to another window (16/09 08:27).
//
// What TIME can and cannot establish (claude-mem-cc-1's control cases, same day): a drop BEFORE
// the previously reported reset time is not that window's scheduled reset — it may be a manual
// reset or a change of subject, and the line must not choose; a drop AT OR AFTER it is consistent
// with the scheduled reset, but an account switch past the old deadline produces the same drop.
// So time is EVIDENCE the line prints, never a complete classifier: the "reset" verdict is issued
// only past the deadline, and it names what it did not verify (source continuity) so a reader
// does not credit more than the instrument measured. The Claude route adds the account
// fingerprint on top; the proxy route has no identity signal and says so.
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
 * @returns {{ kind: 'reset' | 'unverified' | 'undetermined', detail: string }}
 *   'reset'        — past the previously reported reset time AND identity continuity established
 *                    by the caller (`continuity`, e.g. 'account fingerprint unchanged'). Without
 *                    continuity the verdict never reaches 'reset': an account switch past the old
 *                    deadline drops the percentage exactly like a reset, and a consumer acts on
 *                    the event TYPE without reading the caveat (claude-mem-cc-1, #44).
 *   'unverified'   — before the previously reported reset time (a manual reset or a change of
 *                    subject), or past it without continuity evidence (reset likely, unproven).
 *                    Both reset times printed; capacity not asserted.
 *   'undetermined' — no previous reset time reported.
 */
export function classifyQuotaDrop({ nowMs, previousResetsAt, currentResetsAt, previousPct, currentPct, continuity = null }) {
  const previousMs = resetsAtToMs(previousResetsAt)
  const currentMs = resetsAtToMs(currentResetsAt)
  const change = `${currentPct}% (was ${previousPct}%)`
  if (previousMs === null) {
    return { kind: 'undetermined', detail: `${change} — cause undetermined: no reset time was reported for the previous reading (reset or source change)` }
  }
  const previousLabel = new Date(previousMs).toISOString()
  const currentLabel = currentMs === null ? 'none' : new Date(currentMs).toISOString()
  if (nowMs < previousMs) {
    return { kind: 'unverified', detail: `${change} — reset unverified: before the reported reset time ${previousLabel} (reading now reports ${currentLabel}); a manual reset, or the source, account or binding changed — capacity not asserted` }
  }
  if (!continuity) {
    return { kind: 'unverified', detail: `${change} — reset likely but unverified: past the reported reset time ${previousLabel} (now ${currentLabel}), source continuity not verified on this route — probe before relying on the capacity` }
  }
  return { kind: 'reset', detail: `${change} — past the reported reset time ${previousLabel} (now ${currentLabel}); ${continuity} — new window, capacity available` }
}
