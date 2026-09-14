// Queue snapshot contract v2. Producers write `at` (epoch ms), `startable` (items this session
// can begin without the owner), `awaitingOwner` (items blocked only on an owner decision),
// `unclassified` (items not placeable in either bucket), and `next` (the proposed startable item,
// empty when startable is 0). Producer-specific fields are ignored. An `open`-only snapshot is
// legacy: readers retain its old open-work behavior but make its unknown classification explicit.
// The mission end condition is `startable === 0`; readers must name unclassified in that verdict.

function validEpoch(value) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
}

function validCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
}

export function parseQueueSnapshot(text, now, staleAfterMs) {
  if (typeof text !== 'string') return { kind: 'unknown', reason: 'missing queue snapshot' }

  let snapshot
  try {
    snapshot = JSON.parse(text)
  } catch {
    return { kind: 'unknown', reason: 'unreadable queue snapshot' }
  }

  if (!snapshot || typeof snapshot !== 'object' || !validEpoch(snapshot.at) || typeof snapshot.next !== 'string') {
    return { kind: 'unknown', reason: 'malformed queue snapshot' }
  }
  if (now - snapshot.at > staleAfterMs) return { kind: 'unknown', reason: 'stale queue snapshot' }

  const hasAnyClassification = ['startable', 'awaitingOwner', 'unclassified'].some((field) => field in snapshot)
  if (!hasAnyClassification) {
    if (!validCount(snapshot.open)) return { kind: 'unknown', reason: 'malformed queue snapshot' }
    const next = snapshot.next.trim()
    return {
      kind: 'legacy',
      at: snapshot.at,
      open: snapshot.open,
      next,
      reason: `legacy snapshot: no startable field — treated as ${snapshot.open} open, classification unknown`,
    }
  }

  if (!validCount(snapshot.startable) || !validCount(snapshot.awaitingOwner) || !validCount(snapshot.unclassified)) {
    return { kind: 'unknown', reason: 'malformed queue snapshot' }
  }
  return {
    kind: 'known',
    at: snapshot.at,
    startable: snapshot.startable,
    awaitingOwner: snapshot.awaitingOwner,
    unclassified: snapshot.unclassified,
    next: snapshot.next.trim(),
  }
}
