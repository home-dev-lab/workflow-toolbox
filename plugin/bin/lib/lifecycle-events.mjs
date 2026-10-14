// Lifecycle event order owns blocked detection, independently of runner text and clocks.
export function createLifecycleEvents(state) {
  const events = []
  state.eventSeq = 0
  const record = (kind, detail = {}) => { const event = { seq: ++state.eventSeq, kind, ...detail }; events.push(event); return event }
  const progress = () => record('progress')
  const route = (cardId, finding) => record('route', { cardId, finding })
  function refused(text, code = 'other') { record('refusal', { text, code }); return text }
  function blocked() {
    const refusal = events.findLast((event) => event.kind === 'refusal')
    if (!refusal || !['receipt', 'ownership'].includes(refusal.code)) return null
    if ([...state.ownedLanes.values()].some((record) => record.phase === state.phase)) return null
    const newestProgress = events.findLast((event) => event.kind === 'progress')?.seq ?? 0
    const routed = events.findLast((event) => event.kind === 'route' && event.seq > newestProgress && event.seq < refusal.seq)
    return routed ? { cardId: routed.cardId, refusal: { code: refusal.code, text: refusal.text } } : null
  }
  function transition(operation) {
    return (event) => {
      const before = state.handled.size
      const result = operation(event)
      if (state.handled.size > before && result.startsWith('accepted phase=')) progress()
      return result
    }
  }
  return { progress, route, refused, blocked, transition }
}
