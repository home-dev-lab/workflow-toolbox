import { unlinkSync } from 'node:fs'
import { readEventOffset, writeEventOffset } from './launcher-event-io.mjs'

const observations = new Map()

// The caller holds the spool lock. In-process intervals use a monotonic clock. Across
// processes only a bounded wall-clock interval is usable; a jump restarts the grace.
export function eventGraceElapsed(file, active, grace, options = {}) {
  const seen = options.observations ?? observations
  if (!active) {
    seen.delete(file)
    removeEventGrace(file)
    return 0
  }
  const wall = options.now ?? Date.now()
  const monotonic = options.monotonicClock?.() ?? performance.now()
  const previous = seen.get(file)
  if (previous && monotonic >= previous.at) return monotonic - previous.at + previous.elapsed
  const elapsed = restoreEventGrace(file, wall, grace)
  seen.set(file, { at: monotonic, elapsed })
  return elapsed
}

function removeEventGrace(file) {
  try { unlinkSync(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
}

function restoreEventGrace(file, wall, grace) {
  const persisted = readEventOffset(file)
  const delta = wall - persisted
  const elapsed = persisted && delta >= 0 && delta <= 2 * grace ? delta : 0
  writeEventOffset(file, Math.max(0, Math.trunc(wall - elapsed)))
  return elapsed
}
