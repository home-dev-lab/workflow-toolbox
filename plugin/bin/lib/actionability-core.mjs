// actionability-core.mjs — pure decision logic behind wt-actionable-gate-hook.mjs.
// Kept separate so tests can drive the decision contract without filesystem state
// or a spawned process.

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function nextCount(consecutiveBlocks) {
  return Math.max(0, finiteNumber(consecutiveBlocks) ? consecutiveBlocks : 0) + 1
}

function pass(nextConsecutiveBlocks = 0, extras = {}) {
  return { block: false, reason: '', nextConsecutiveBlocks, ...extras }
}

function hold(reason, consecutiveBlocks, blockMax, extras = {}) {
  const nextConsecutiveBlocks = nextCount(consecutiveBlocks)
  return {
    block: nextConsecutiveBlocks <= blockMax,
    reason,
    nextConsecutiveBlocks,
    ...extras,
  }
}

/**
 * @typedef {{
 *   status: 'present',
 *   at: number,
 *   actionable: number,
 *   next: string,
 *   workPossible: boolean,
 *   reason: string,
 *   blockedUntil: number | null,
 *   inFlightUntil: number | null,
 * }} PresentSnapshot
 */

/**
 * @typedef {{ status: 'never' } | { status: 'missing' } | { status: 'invalid' } | PresentSnapshot} Snapshot
 */

/**
 * @param {{
 *   snapshot?: Snapshot | null,
 *   now: number,
 *   staleAfterMs: number,
 *   inFlight?: boolean,
 *   consecutiveBlocks?: number,
 *   blockMax?: number,
 *   inFlightCapMs?: number,
 * }} input
 * @returns {{
 *   block: boolean,
 *   reason: string,
 *   nextConsecutiveBlocks: number,
 *   actionable?: number,
 *   next?: string,
 *   blockedReason?: string,
 *   blockedUntil?: number | null,
 *   inFlightUntil?: number | null,
 * }}
 */
export function decide({
  snapshot = null,
  now,
  staleAfterMs,
  inFlight = false,
  consecutiveBlocks = 0,
  blockMax = 3,
  inFlightCapMs = 10 * 60_000,
}) {
  if (!finiteNumber(now)) throw new Error('now must be a finite number')
  if (!finiteNumber(staleAfterMs) || staleAfterMs < 0) throw new Error('staleAfterMs must be a non-negative number')
  if (!finiteNumber(blockMax) || blockMax < 1) throw new Error('blockMax must be >= 1')
  if (!finiteNumber(inFlightCapMs) || inFlightCapMs < 0) throw new Error('inFlightCapMs must be a non-negative number')

  if (snapshot === null || snapshot?.status === 'never') return pass(0)
  if (snapshot?.status === 'invalid') return pass(0)
  if (inFlight) return pass(0)
  if (snapshot?.status === 'missing') return hold('snapshot-missing', consecutiveBlocks, blockMax)
  if (snapshot?.status !== 'present') return pass(0)

  const at = snapshot.at
  if (!finiteNumber(at) || now - at > staleAfterMs) {
    return hold('snapshot-stale', consecutiveBlocks, blockMax)
  }

  const actionable = snapshot.actionable
  const next = trimmedString(snapshot.next)
  const workPossible = snapshot.workPossible
  const blockedReason = trimmedString(snapshot.reason)
  const blockedUntil = snapshot.blockedUntil
  const inFlightUntil = snapshot.inFlightUntil
  const liveBlockedUntil = finiteNumber(blockedUntil) && blockedUntil > now
  // External lane detection now lives in the hook, because it depends on the host's
  // process table. This declared bound remains only as the fallback for work that
  // probe cannot see at all.
  //
  // ⚠ THE ASYMMETRY, AND WHY THE BOUND IS CAPPED FROM `at`, NOT FROM `now`. A stale-but-present
  // bound must fail only ONE way: forgetting to write it costs a spurious block, never a missed
  // one. A GENEROUS bound breaks that — a window reaching far into the future silences the gate
  // for its whole length, however old the snapshot declaring it has become. So the declared bound
  // is honoured only up to `inFlightCapMs` past the moment the snapshot was WRITTEN (`at`), never
  // past `now` — capping from `now` would let a stale file renew its own window merely by being
  // read. A declarer that needs longer must keep re-declaring while it is still true; that is the
  // property that makes a stale claim expire on its own.
  const inFlightCeiling = finiteNumber(at) ? at + inFlightCapMs : now
  const effectiveInFlightUntil = finiteNumber(inFlightUntil) ? Math.min(inFlightUntil, inFlightCeiling) : NaN
  const declaredInFlight = finiteNumber(effectiveInFlightUntil) && effectiveInFlightUntil > now

  if (declaredInFlight) return pass(0, { actionable, next, blockedReason, blockedUntil, inFlightUntil })

  if (workPossible === false && blockedReason && liveBlockedUntil) {
    return pass(0, { actionable, next, blockedReason, blockedUntil, inFlightUntil })
  }
  if (actionable === 0) return pass(0, { actionable, next })

  return hold('actionable-work-remains', consecutiveBlocks, blockMax, {
    actionable,
    next,
    blockedReason,
    blockedUntil,
    inFlightUntil,
  })
}
