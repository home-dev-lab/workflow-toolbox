// Admission uses raw observations, never the rounded status catalogue.
import { SUITE_RESOURCE_MIN_RUNS as MIN_RUNS, validSuiteResources } from './suite-lock-resources.mjs'

const ADMISSION_HISTORY_RUNS = 10
/** @knipTestSeam Standalone admission selftest imports this through an OS-temp copy. */
export const ADMISSION_BYPASS_LIMIT = 8
const SAFETY_MARGIN = 1.25
const finite = (value) => Number.isFinite(value) && value >= 0
const complete = (run) => validSuiteResources(run) && finite(run.peakCores) && finite(run.peakMemMiB)
  && finite(run.wallMs) && run.unknownReasons.length === 0

function timingSensitive(runs) {
  const red = runs.some(({ release }) => Number.isInteger(release?.exit) && release.exit !== 0
    && !release.cause && release.overlaps?.some((peer) => peer.durationMs > 0))
  const alone = runs.some(({ release }) => release?.exit === 0 && Array.isArray(release.overlaps) && release.overlaps.length === 0)
  return red && alone
}

export function reservationForJob(runs, declared, capacity) {
  const resources = runs.map((run) => run.release?.resources).filter(complete).slice(-ADMISSION_HISTORY_RUNS)
  const exclusive = { mode: 'exclusive', cores: capacity.cores, memMiB: capacity.memMiB, basis: 'declared' }
  if (timingSensitive(runs)) return { ...exclusive, basis: 'timing-history' }
  if (resources.length < MIN_RUNS) {
    return declared === 'light' ? { mode: 'reservation', cores: 1, memMiB: 512, basis: 'declared' } : exclusive
  }
  return { mode: 'reservation', cores: Math.max(...resources.map((run) => run.peakCores)) * SAFETY_MARGIN,
    memMiB: Math.max(...resources.map((run) => run.peakMemMiB)) * SAFETY_MARGIN, basis: 'measured' }
}

function fits(reservation, holders, capacity) {
  if (!reservation || holders.some((holder) => holder.reservation.mode === 'exclusive')) return false
  if (reservation.mode === 'exclusive') return holders.length === 0
  const total = holders.reduce((sum, holder) => ({ cores: sum.cores + holder.reservation.cores,
    memMiB: sum.memMiB + holder.reservation.memMiB }), { cores: reservation.cores, memMiB: reservation.memMiB })
  return total.cores <= capacity.cores && total.memMiB <= capacity.memMiB
}

/** Queue is already ranked by the existing release/precedence/level/S/turn/FIFO order. */
export function admissionPlan(queue, holders, capacity, bypasses) {
  const admit = []
  const blocked = []
  const running = [...holders]
  if (!finite(capacity.load) || capacity.load > capacity.loadLimit) return { admit, blocked }
  for (const candidate of queue) {
    if (fits(candidate.reservation, running, capacity)) {
      admit.push(candidate.number)
      running.push(candidate)
    } else {
      blocked.push(candidate.number)
      if ((bypasses[candidate.number] ?? 0) >= ADMISSION_BYPASS_LIMIT) break
    }
  }
  return { admit, blocked }
}

export function watchdogDecision(holders, memory) {
  if (!finite(memory?.availableMiB) || memory.availableMiB >= memory.floorMiB || holders.some((holder) => holder.stop)) return null
  const candidates = holders.filter((holder) => holders.length === 1 || holder.priority !== 'release')
  return candidates.sort((left, right) => watchdogPriority(right, 0) - watchdogPriority(left, 0)
    || watchdogPriority(right, 1) - watchdogPriority(left, 1)
    || youngestFirst(left, right))[0] ?? null
}

function youngestFirst(left, right) {
  if (Number.isFinite(left.admittedSequence) && Number.isFinite(right.admittedSequence)) return right.admittedSequence - left.admittedSequence
  return right.startedAtMs - left.startedAtMs
}

function watchdogPriority(holder, index) {
  return holder.watchdogPriority?.[index] ?? (index === 0 ? 2 : holder.level ?? 1)
}

export function releaseOverlaps(holder, now) {
  return (holder.overlaps ?? []).map((peer) => ({ leaseId: peer.leaseId,
    durationMs: Math.max(0, (peer.endMs ?? now) - peer.startMs) })).filter((peer) => peer.durationMs > 0)
}
