import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, openSync, closeSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { admissionPlan, releaseOverlaps, reservationForJob, watchdogDecision } from '../suite-lock-admission.mjs'
import { journalCommand, readSuiteLockJournal, readSuiteResourceRuns, suiteJournalEvent, validSuiteJobClass } from '../suite-lock-journal.mjs'
import { closeQueuedReplacement } from './suite-lock-replace.mjs'
import { orderSuiteLockTickets } from '../suite-lock-order.mjs'
import { currentPidNamespace, processStartTime } from './pid-namespace.mjs'
import { readSuiteLockRankState, recordSuiteLockService } from './suite-lock-rank-state.mjs'
import { claimOwnedSuiteSection, claimSuiteSection, RECLAIM_BUSY, retrySuiteSection } from './suite-lock-section.mjs'
import { abandonEmptyLockDir, reclaimInFlight, readHolderIn, readLightCounter, readP0Counter, readQueueSnapshot, recordAdmissionGrant, recordLightGrant, recordP0Grant } from './suite-lock-queue.mjs'
import { staticSemaphoreRoot } from './suite-lock-static-semaphore.mjs'
import { ticketIsStale } from './suite-lock-liveness.mjs'
import { readSuiteMachine } from './suite-lock-machine.mjs'
import { stageReservationRetry } from './suite-lock-memory-retry.mjs'
import { expireMemoryStops, memoryStopRequest } from '../suite-lock-safety-net.mjs'

export const RESERVATION_PROTOCOL = 1
const WATCHDOG_STALE_MS = 5000
const stateFile = (root) => path.join(root, 'reservations.json')
const fenceFile = (root) => path.join(root, 'lock.d', 'holder.json')
const isFence = (holder) => holder?.reservationProtocol === RESERVATION_PROTOCOL
// A foreign PID is not a local liveness probe. With zero silence age this uses
// only the queue's existing namespace/PID/start-identity evidence, never time.
const watchdogProvesGone = (watchdog) => ticketIsStale({ holder: watchdog, ageMs: 0 })

export function reservationAdmissionSwitch(root, env = process.env, warn = (line) => process.stderr.write(`${line}\n`)) {
  const value = env.WT_SUITE_LOCK_ADMISSION
  if (value === 'exclusive' || value === 'reservation') return { enabled: value === 'reservation', source: 'environment' }
  if (value !== undefined) warn('wt-suite-lock: invalid WT_SUITE_LOCK_ADMISSION; expected reservation or exclusive; treating as unset')
  const enabled = !root.startsWith('broker:') && existsSync(path.join(root, 'admission-reservation.enabled'))
  return { enabled, source: enabled ? 'marker' : 'default' }
}

export function readReservationState(root) {
  try {
    const state = JSON.parse(readFileSync(stateFile(root), 'utf8'))
    if (state.version !== RESERVATION_PROTOCOL || !Array.isArray(state.holders)) throw new Error('invalid reservation state')
    return state
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

function publish(root, state) {
  const temporary = `${stateFile(root)}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 })
  renameSync(temporary, stateFile(root))
}

function reservationSection(root, critical) {
  return claimSuiteSection(root, () => claimOwnedSuiteSection(root, 'reservation-write.d', () => {
    reconcileLaunchers(root)
    return critical()
  }))
}

function reconcileLaunchers(root) {
  const state = readReservationState(root)
  if (!state) return
  const dead = state.holders.filter((holder) => watchdogProvesGone(holder))
  if (!dead.length) { closeFence(root, state); return }
  for (const holder of dead) journalDeadLauncher(root, holder)
  state.holders = state.holders.filter((holder) => !dead.includes(holder))
  for (const peer of state.holders) {
    for (const overlap of peer.overlaps ?? []) if (dead.some((holder) => holder.leaseId === overlap.leaseId)) overlap.endMs = Date.now()
  }
  publish(root, state)
  if (!state.holders.length) {
    removeOwnedFence(root, state.generation)
    removeOwnedFence(staticSemaphoreRoot(root), state.generation)
  }
}

function journalDeadLauncher(root, holder) {
  if (terminalRecorded(root, holder.leaseId)) return
  suiteJournalEvent({ base: { ...holder.journal, root,
    leaseId: holder.leaseId, kind: holder.light ? 'light' : 'exclusive', cmd: journalCommand(holder.argv),
    jobClass: holder.jobClass, ticket: holder.ticket } }, 'release', { exit: null, cause: 'launcher-dead', served: false,
    reservation: holder.reservation, overlaps: releaseOverlaps(holder, Date.now()) })
}

// POSIX init is the legacy compatibility fence, NOT an owned/signalable job.
// Old clients see a live holder even if a reservation client or watchdog dies.
function createFence(root, state, withdrawDuringReclaim = false) {
  const lockDir = path.join(root, 'lock.d')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  try { mkdirSync(lockDir, { mode: 0o700 }) } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
  if (withdrawDuringReclaim && reclaimInFlight(root)) { abandonEmptyLockDir(lockDir); return false }
  try {
    writeFileSync(fenceFile(root), JSON.stringify({ pid: 1, startTime: processStartTime(1),
      pidNamespace: currentPidNamespace(), platform: process.platform, leaseId: state.generation,
      startedAt: new Date().toISOString(), argv: ['reservation admission; inspect holders in status --json'],
      reservationProtocol: RESERVATION_PROTOCOL }), { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EEXIST') return false
    throw error
  }
}

function startWatchdog(root, state) {
  if (state.watchdog && !watchdogProvesGone(state.watchdog)
    && Date.now() - (state.watchdog.heartbeat || state.watchdog.startedAt || state.createdAt) <= 15_000) return
  const log = openSync(path.join(root, 'watchdog.log'), 'a', 0o600)
  let child
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL('./suite-lock-watchdog.mjs', import.meta.url)), root, state.generation],
      { detached: true, stdio: ['ignore', log, log], env: { ...process.env, WT_SUITE_LEASE: '' } })
  } finally { closeSync(log) }
  child.on('error', (error) => process.stderr.write(`wt-suite-lock: watchdog unavailable (${error.code}); reservation admission closed\n`))
  child.unref()
  state.watchdog = { pid: child.pid, startTime: processStartTime(child.pid), pidNamespace: currentPidNamespace(), heartbeat: 0, startedAt: Date.now() }
}

function prepareState(root) {
  let state = readReservationState(root)
  const holders = compatibilityHolders(root)
  if (!holders) return null
  if (!state && (holders.main || holders.static)) return null
  if (needsReservationEpoch(state, holders)) {
    state = { version: RESERVATION_PROTOCOL, generation: randomUUID(), holders: [], bypasses: state?.bypasses ?? {}, createdAt: Date.now() }
  }
  startWatchdog(root, state)
  publish(root, state)
  return state
}

function needsReservationEpoch(state, holders) {
  if (!state) return true
  if (state.holders.length || holders.main || holders.static) return false
  return Boolean(state.watchdog && watchdogProvesGone(state.watchdog))
}

function compatibilityHolders(root) {
  const main = readHolderIn(path.join(root, 'lock.d'))
  const analysis = readHolderIn(path.join(staticSemaphoreRoot(root), 'lock.d'))
  if ((main && !isFence(main)) || (analysis && !isFence(analysis))) return null
  return { main, static: analysis }
}

function ensureCompatibilityFences(root, state, holders) {
  if (holders.main && holders.main.leaseId !== state.generation) return false
  if (holders.static && holders.static.leaseId !== state.generation) return false
  if (!holders.static && !createFence(staticSemaphoreRoot(root), state, true)) return false
  return holders.main || createFence(root, state)
}

function claimCompatibilityFences(root, state) {
  const holders = compatibilityHolders(root)
  return holders && ensureCompatibilityFences(root, state, holders)
}

function rankedQueue(root, now, options) {
  const tickets = readQueueSnapshot(path.join(root, 'queue.d'), now)
    .filter((ticket) => !ticketIsStale(ticket, options)).map((ticket) => ({ number: ticket.number, record: ticket.holder }))
  return orderSuiteLockTickets(tickets, readLightCounter(root), now, readP0Counter(root), readSuiteLockRankState(root, tickets)).tickets
}

function reservedQueue(root, options, machine, waiting) {
  const history = readSuiteResourceRuns(root)
  return rankedQueue(root, options.now?.() ?? Date.now(), options).map((ticket) => {
    const record = ticket.number === waiting.ticket ? waiting.record : ticket.record
    const runs = jobClassHistory(history, record)
    const declared = record.light === true ? 'light' : 'heavy'
    const reservation = record.reservationProtocol === RESERVATION_PROTOCOL
      ? reservationForJob(runs, declared, machine) : { mode: 'exclusive', cores: machine.cores, memMiB: machine.memMiB, basis: 'declared' }
    return { ...ticket, reservation }
  })
}

function jobClassHistory(history, record) {
  const jobClass = record.jobClass ?? record.journal?.jobClass
  return validSuiteJobClass(jobClass) ? history.filter((run) => run.release?.jobClass === jobClass) : []
}

export function reservationQueueStatus(root, tickets) {
  if (!tickets.some((ticket) => ticket.record?.reservationProtocol === RESERVATION_PROTOCOL)) return tickets
  const machine = readSuiteMachine()
  const history = readSuiteResourceRuns(root)
  return tickets.map((ticket) => {
    const record = ticket.record
    if (record?.reservationProtocol !== RESERVATION_PROTOCOL) return ticket
    const runs = jobClassHistory(history, record)
    const reservation = machine.unknown ? { unknown: machine.unknown }
      : reservationForJob(runs, record.light === true ? 'light' : 'heavy', machine)
    return { ...ticket, reservation }
  })
}

function resolveReservationCommand(waiting, candidate, holders, machine, options) {
  closeQueuedReplacement(waiting, options.replacementSeams, options.onWait)
  const cmd = journalCommand(waiting.record.argv)
  if (waiting.record.journal && cmd !== waiting.record.journal.cmd) {
    waiting.record.journal.cmd = cmd
    const history = jobClassHistory(readSuiteResourceRuns(waiting.root), waiting.record)
    candidate.reservation = reservationForJob(history, waiting.record.light ? 'light' : 'heavy', machine)
  }
  if (machine.fallbackExclusive) candidate.reservation = exclusiveFallback(machine)
  return reservationPlan([candidate], { holders, bypasses: {} }, machine).admit.length > 0
}

function grantReservation(root, state, candidate, holder, options) {
  const now = performance.timeOrigin + performance.now()
  state.admittedSequence = (state.admittedSequence ?? 0) + 1
  holder = { ...holder, reservation: candidate.reservation, startedAtMs: now, ticket: candidate.number, overlaps: [],
    admittedSequence: state.admittedSequence, watchdogPriority: [candidate.reason.tier ?? 2, candidate.effectiveLevel ?? holder.level] }
  for (const peer of state.holders) {
    peer.overlaps.push({ leaseId: holder.leaseId, startMs: now })
    holder.overlaps.push({ leaseId: peer.leaseId, startMs: now })
  }
  if (holder.light === true) recordLightGrant(root)
  if (holder.level === 0 && holder.priority !== 'release') recordP0Grant(root, options.p0GrantSeams)
  recordAdmissionGrant(root)
  state.holders.push(holder)
  state.used = true
  publish(root, state)
  return holder
}

export function pollReservationLease(waiting, holder, options) {
  const { root, ticket, record } = waiting
  const result = reservationSection(root, () => {
    const state = prepareState(root)
    if (!state) return null
    const machine = admissionMachine(state, options)
    const queue = safeReservationQueue(reservedQueue(root, options, machine, waiting), machine)
    const plan = reservationPlan(queue, state, machine)
    if (plan.admit[0] !== ticket) return null
    const candidate = queue.find((entry) => entry.number === ticket)
    if (!resolveReservationCommand(waiting, candidate, state.holders, machine, options)) return null
    options.beforePublish?.()
    const freshState = readReservationState(root)
    const freshMachine = admissionMachine(freshState, options)
    if (freshMachine.fallbackExclusive) candidate.reservation = exclusiveFallback(freshMachine)
    if (!reservationPlan([candidate], state, freshMachine).admit.includes(ticket)) return null
    if (!claimCompatibilityFences(root, state)) return null
    recordFitBypasses(state, plan, queue, candidate, ticket)
    const granted = grantReservation(root, state, candidate, { ...holder, argv: record.argv }, options)
    return { root, lockDir: waiting.lockDir, holder: granted, reservationLease: true, ticket, record,
      rankLevel: candidate.effectiveLevel, reason: candidate.reason, startedMonotonic: performance.now(),
      ...(record.replaceToken ? { replacementArgv: record.argv } : {}) }
  })
  return result === RECLAIM_BUSY ? null : result
}

function admissionMachine(state, options) {
  const machine = machineReading(state, options)
  return !machine.unknown && reservationSensorsFresh(state, machine) ? machine : fallbackMachine(machine)
}

function machineReading(state, options) {
  return (options.readMachine ?? readSuiteMachine)({ windowsMemory: state?.windowsMemory })
}

function reservationSensorsFresh(state, machine, now = Date.now()) {
  const fresh = recentSample(state?.watchdog?.heartbeat, now, WATCHDOG_STALE_MS)
    && (!machine.wsl || freshWindowsSample(state?.windowsMemory, now))
  return fresh
}

function fallbackMachine(machine) {
  return { ...machine, fallbackExclusive: true, cores: machine.cores ?? 1, memMiB: machine.memMiB ?? 1, load: 0, loadLimit: Infinity }
}

function recentSample(timestamp, now, maxAge) {
  return Number.isFinite(timestamp) && timestamp > 0 && now >= timestamp && now - timestamp <= maxAge
}

function freshWindowsSample(sample, now) {
  return Number.isFinite(sample?.availableMiB) && sample.availableMiB >= 0 && recentSample(sample.sampledAt, now, 10_000)
}

function exclusiveFallback(machine) {
  return { mode: 'exclusive', cores: machine.cores, memMiB: machine.memMiB, basis: 'sensor-unavailable' }
}

function safeReservationQueue(queue, machine) {
  return machine.fallbackExclusive ? queue.map((candidate) => ({ ...candidate, reservation: exclusiveFallback(machine) })) : queue
}

function reservationPlan(queue, state, machine) {
  const capacity = queue[0]?.reservation.mode === 'exclusive' && !state.holders.length ? { ...machine, load: 0, loadLimit: Infinity } : machine
  return admissionPlan(queue, state.holders, capacity, state.bypasses)
}

function recordFitBypasses(state, plan, queue, candidate, ticket) {
  for (const number of plan.blocked.filter((number) => queue.findIndex((entry) => entry.number === number) < queue.indexOf(candidate))) {
    state.bypasses[number] = (state.bypasses[number] ?? 0) + 1
  }
  delete state.bypasses[ticket]
}

function terminalRecorded(root, id) {
  return readSuiteLockJournal(root).tickets.some((ticket) => ticket.leaseId === id && (ticket.release || ticket.abort || ticket.timeout))
}

function closeFence(root, state) {
  if (!state.used && Date.now() - state.createdAt < 10_000) return
  if (state.holders.length) return
  removeOwnedFence(root, state.generation)
  removeOwnedFence(staticSemaphoreRoot(root), state.generation)
}

function removeOwnedFence(root, generation) {
  if (readHolderIn(path.join(root, 'lock.d'))?.leaseId !== generation) return
  rmSync(path.join(root, 'lock.d'), { recursive: true, force: true })
}

export function releaseReservationLease(lease, outcome) {
  return retrySuiteSection(lease.root, () => claimOwnedSuiteSection(lease.root, 'reservation-write.d', () => {
    reconcileLaunchers(lease.root)
    return finishReservationRelease(lease, outcome)
  }), { timeoutMs: 60_000, maxPauseMs: 250, retryErrors: true })
}

function finishReservationRelease(lease, outcome) {
    const state = readReservationState(lease.root)
    const holder = state?.holders.find((entry) => entry.leaseId === lease.holder.leaseId)
    if (!holder) return true
    const now = performance.timeOrigin + performance.now()
    const stop = holder.stop?.abandoned ? null : holder.stop
    const fields = { ...outcome, ...stoppedReleaseFields(stop),
      reservation: holder.reservation, overlaps: releaseOverlaps(holder, now) }
    retryStoppedLease(lease, outcome, stop)
    if (!terminalRecorded(lease.root, holder.leaseId)) {
      recordSuiteLockService(lease, fields)
      suiteJournalEvent(lease.journal, 'release', fields)
    }
    removeReleasedHolder(state, holder, stop, now)
    publish(lease.root, state)
    closeFence(lease.root, state)
    return true
}

function retryStoppedLease(lease, outcome, stop) {
  if (outcome.requeue && stop?.cause === 'memory-pressure') stageReservationRetry(lease)
}

function removeReleasedHolder(state, holder, stop, now) {
  state.holders = state.holders.filter((entry) => entry.leaseId !== holder.leaseId)
  if (stop?.cause === 'memory-pressure') state.lastStopConfirmedAt = Date.now()
  for (const peer of state.holders) {
    for (const overlap of peer.overlaps.filter((entry) => entry.leaseId === holder.leaseId)) overlap.endMs = now
  }
}

function stoppedReleaseFields(stop) {
  if (!stop) return {}
  return { cause: stop.cause, served: false,
    ...(stop.floorOverrideMiB === undefined ? {} : { floorOverrideMiB: stop.floorOverrideMiB }),
    stopRequestedAt: stop.at, stopConfirmedAt: Date.now() }
}

export function watchReservationMemory(root, machine, identity) {
  return reservationSection(root, () => {
    const state = readReservationState(root)
    if (!state || (identity && (state.generation !== identity.generation || state.watchdog.pid !== identity.pid))) return false
    const now = Date.now()
    state.watchdog.heartbeat = now
    if (machine.windowsMemory) state.windowsMemory = machine.windowsMemory
    state.memory = machine.unknown ? { unknown: machine.unknown } : { availableMiB: machine.availableMiB, floorMiB: machine.floorMiB }
    expireMemoryStops(state.holders, now)
    const victim = watchdogDecision(state.holders, machine, { now, lastStopConfirmedAt: state.lastStopConfirmedAt })
    if (victim) victim.stop = memoryStopRequest(machine, now)
    publish(root, state)
    closeFence(root, state)
    return true
  })
}

export function reservationStopReason(lease) {
  try {
    const state = readReservationState(lease.root)
    const stop = state?.holders.find((holder) => holder.leaseId === lease.holder.leaseId)?.stop
    return stop?.cause === 'memory-pressure' && !stop.abandoned && (stop.deadline ?? Infinity) >= Date.now() ? 'memory-pressure' : null
  } catch { return null }
}

export function maintainReservationWatchdog(lease) {
  try {
    return reservationSection(lease.root, () => {
      const state = readReservationState(lease.root)
      if (!state) return false
      const prior = state.watchdog?.pid
      const healthy = !state.memory?.unknown && Number.isFinite(state.watchdog?.heartbeat)
        && Date.now() - state.watchdog.heartbeat <= WATCHDOG_STALE_MS
      startWatchdog(lease.root, state)
      publish(lease.root, state)
      return healthy && prior === state.watchdog?.pid
    })
  } catch { return false }
}

export function reservationLeaseHeld(root, id) {
  return readReservationState(root)?.holders.some((holder) => holder.leaseId === id) === true
}

export function reservationEnvironment(lease) {
  if (!lease.reservationLease) return {}
  const reservation = lease.holder.reservation
  return { WT_SUITE_LEASE_MODE: reservation?.mode ?? 'exclusive',
    WT_SUITE_LEASE_RESERVATION: JSON.stringify(reservation ?? null),
    ...(reservation?.mode === 'reservation' ? {
      WT_SUITE_LEASE_RESERVATION_CORES: String(Math.max(1, Math.ceil(reservation.cores))),
      WT_SUITE_LEASE_RESERVATION_MEM_MIB: String(Math.max(1, Math.ceil(reservation.memMiB))),
    } : {}) }
}
