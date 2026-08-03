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
export function decide({ snapshot = null, now, staleAfterMs, inFlight = false, consecutiveBlocks = 0, blockMax = 3 }) {
  if (!finiteNumber(now)) throw new Error('now must be a finite number')
  if (!finiteNumber(staleAfterMs) || staleAfterMs < 0) throw new Error('staleAfterMs must be a non-negative number')
  if (!finiteNumber(blockMax) || blockMax < 1) throw new Error('blockMax must be >= 1')

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
  // Producers declare external work with a self-expiring bound. If they forget to
  // write it, or let it expire, the hook may block spuriously; it must never miss
  // blocking because an absent signal was treated as live.
  const declaredInFlight = finiteNumber(inFlightUntil) && inFlightUntil > now

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
