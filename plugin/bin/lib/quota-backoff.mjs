// quota-backoff.mjs — pure backoff math for wt-quota-watch.mjs, extracted so it is
// directly unit-testable without driving the watcher's real network-probing loop (which
// only observably behaves over real wall-clock polls).
//
// INVARIANT: repeated probe failures make the RETRY interval grow — so a probe that is
// failing because the endpoint is rate-limiting the account does not keep hitting it at
// the same rate that got it rate-limited in the first place. A single success resets the
// interval back to the caller's normal poll cadence. Growth is capped at a bounded
// multiple of the normal cadence: permanent silence (an unbounded or missing retry) is a
// worse failure than a slow one, so the watcher is never more than that bound away from
// trying again.

const MAX_MULTIPLIER = 8

/**
 * @param {number} pollSeconds the watcher's configured normal cadence, in seconds
 * @param {number} consecutiveFailures 0 (or non-finite/negative) → normal cadence;
 *   1, 2, 3, … → a growing, capped backoff
 * @returns {number} milliseconds to wait before the next probe attempt
 */
export function computeBackoffMs(pollSeconds, consecutiveFailures) {
  const pollMs = pollSeconds * 1000
  if (!Number.isFinite(consecutiveFailures) || consecutiveFailures <= 0) return pollMs
  const multiplier = Math.min(2 ** Math.floor(consecutiveFailures), MAX_MULTIPLIER)
  return pollMs * multiplier
}
