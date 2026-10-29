// The model tracker's mutable state, and its plain-JSON snapshot. A snapshot restored here must
// continue observing exactly as the tracker that took it would have; a malformed one throws, so the
// caller can treat it as absent rather than build a tracker on it.

const ARRAYS = ['runs', 'fallbacks', 'refusals', 'notices']

function freshTrackerState() {
  return { runs: [], fallbacks: [], refusals: [], notices: [], seenMessages: new Set(), seenRefusals: new Set(), lastFromRun: new Map(), position: 0, initialModel: null, lastServedPosition: 0 }
}

export function snapshotTrackerState(state) {
  return {
    runs: state.runs, fallbacks: state.fallbacks, refusals: state.refusals, notices: state.notices,
    seenMessages: [...state.seenMessages], seenRefusals: [...state.seenRefusals], lastFromRun: [...state.lastFromRun],
    position: state.position, initialModel: state.initialModel, lastServedPosition: state.lastServedPosition,
  }
}

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isCount = (value) => Number.isSafeInteger(value) && value >= 0
const isPair = (value) => Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && isCount(value[1])
// The answer is built from these two event lists: each element must carry the fields it is read by.
const isRun = (run) => isRecord(run) && typeof run.model === 'string' && Number.isSafeInteger(run.calls) && run.calls > 0 && Number.isSafeInteger(run.position)
const isFallback = (event) => isRecord(event) && typeof event.from === 'string' && typeof event.to === 'string' && Number.isSafeInteger(event.position)
const hasEvents = (snapshot) => snapshot.runs.every(isRun) && snapshot.fallbacks.every(isFallback)

const hasCollections = (snapshot) => ARRAYS.every((key) => Array.isArray(snapshot[key]) && snapshot[key].every(isRecord))
  && Array.isArray(snapshot.seenMessages) && Array.isArray(snapshot.seenRefusals)
  && Array.isArray(snapshot.lastFromRun) && snapshot.lastFromRun.every(isPair)
const hasScalars = (snapshot) => isCount(snapshot.position) && isCount(snapshot.lastServedPosition)
  && (snapshot.initialModel === null || typeof snapshot.initialModel === 'string')

function checkShape(snapshot) {
  if (!isRecord(snapshot) || !hasCollections(snapshot) || !hasScalars(snapshot) || !hasEvents(snapshot)) throw new Error('malformed model tracker snapshot')
}

// Deep copy through JSON: the restored tracker never shares an object with the snapshot it came from.
function restoreTrackerState(snapshot) {
  checkShape(snapshot)
  const copy = JSON.parse(JSON.stringify(snapshot))
  return {
    runs: copy.runs, fallbacks: copy.fallbacks, refusals: copy.refusals, notices: copy.notices,
    seenMessages: new Set(copy.seenMessages), seenRefusals: new Set(copy.seenRefusals), lastFromRun: new Map(copy.lastFromRun),
    position: copy.position, initialModel: copy.initialModel, lastServedPosition: copy.lastServedPosition,
  }
}

export const trackerState = (snapshot) => snapshot ? restoreTrackerState(snapshot) : freshTrackerState()
