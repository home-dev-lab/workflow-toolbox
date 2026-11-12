import { createHash } from 'node:crypto'
import path from 'node:path'
import { normalizeSuiteLockProject, suiteLockIsoTime } from '../suite-lock-rank-common.mjs'
import { pruneSuiteLockRankState, publishRankJson as publish, rankEntries as entries, readRankJson as readJson, warnRankState as warn } from './suite-lock-rank-files.mjs'
import { suiteLockBootClock } from './platform.mjs'

const hash = (project) => createHash('sha256').update(project).digest('hex').slice(0, 16)
const stateFile = (root, kind, project) => path.join(root, kind, `${hash(project)}.json`)
const safeSequence = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0
const unreadable = Symbol('unreadable rank state')

function validRankEntry(kind, entry, project) {
  if (entry?.project !== project) return false
  if (kind === 'project-turns') return Number.isSafeInteger(entry.turn) && entry.turn >= 0
  if (kind === 'size-history') return entry.size === 'S' && Number.isFinite(entry.heldMs) && entry.heldMs >= 0 && typeof entry.overran === 'boolean'
  return Number.isFinite(suiteLockIsoTime(entry.until))
}

function currentRankEntries(root, kind, projects) {
  return [...projects].flatMap((project) => {
    const entry = readJson(stateFile(root, kind, project), unreadable)
    if (entry === null) return []
    if (validRankEntry(kind, entry, project)) return [[project, entry]]
    warn()
    return [[project, null]]
  })
}

function mostRecentTurn(root, turns) {
  const sequence = readJson(path.join(root, 'turn-seq'))?.sequence
  const readable = Number.isSafeInteger(sequence) && sequence >= 0 ? [] : entries(root, 'project-turns')
  return Math.max(safeSequence(sequence), ...turns.map(([, entry]) => safeSequence(entry?.turn)), ...readable.map((entry) => safeSequence(entry.turn)))
}

export function readSuiteLockRankState(root, tickets = []) {
  const projects = new Set(tickets.map(({ record }) => normalizeSuiteLockProject(record?.project)))
  const turns = currentRankEntries(root, 'project-turns', projects)
  const latest = turns.some(([, entry]) => entry === null) ? mostRecentTurn(root, turns) : 0
  return {
    turns: Object.fromEntries(turns.map(([project, entry]) => [project, entry?.turn ?? latest])),
    history: Object.fromEntries(currentRankEntries(root, 'size-history', projects).map(([project, entry]) => [project, entry ?? { project, size: 'S', overran: true }])),
    precedence: Object.fromEntries(currentRankEntries(root, 'precedence', projects).filter(([, entry]) => entry !== null)),
  }
}

function advisoryWrite(write) {
  try { write() } catch (error) { warn(error) }
}

export function suiteLockReleaseOutcome(lease, outcome, now = Date.now()) {
  const elapsed = Math.max(0, Number.isFinite(lease.startedMonotonic) ? performance.now() - lease.startedMonotonic : now - Date.parse(lease.holder.startedAt))
  const heldMs = Number.isFinite(outcome.heldMs) && outcome.heldMs >= 0 ? outcome.heldMs : elapsed
  const served = outcome.served === true && !outcome.lost && !outcome.yielded
  return { ...outcome, heldMs, served }
}

/** Called by the sole holder, before lock.d is removed. Advisory failures never fail release. */
export function recordSuiteLockService(lease, outcome) {
  const { holder, root } = lease
  if (lease.staticDomain) return
  try {
    const project = normalizeSuiteLockProject(holder.project)
    if (outcome.served) advisoryWrite(() => stampProjectTurn(root, project))
    if (holder.light || holder.priority === 'release') return
    if (holder.size === 'S' && (outcome.served || outcome.heldMs > 600_000)) advisoryWrite(() => publish(stateFile(root, 'size-history', project), {
      project, size: 'S', heldMs: outcome.heldMs, overran: outcome.heldMs > 600_000, at: new Date().toISOString(),
    }))
  } catch (error) { warn(error) }
  finally { pruneSuiteLockRankState(root) }
}

function stampProjectTurn(root, project) {
  // Recovery may enumerate at release, never on the acquisition poll path. Read the
  // high-water mark before pruning so a restarted counter cannot reuse a stale turn.
  const counter = readJson(path.join(root, 'turn-seq'))?.sequence
  let highest = safeSequence(counter)
  const recovery = !Number.isSafeInteger(counter) || counter < 0
  for (const entry of entries(root, 'project-turns', recovery)) highest = Math.max(highest, safeSequence(entry.turn))
  const sequence = highest + 1
  publish(path.join(root, 'turn-seq'), { sequence })
  publish(stateFile(root, 'project-turns', project), { project, turn: sequence })
}

function sameBootIdentity(clock, holder) {
  return typeof clock.bootId === 'string' && clock.bootId.length > 0 && clock.bootId === holder?.bootId
}

function validBootStart(holder) {
  return Number.isFinite(holder?.startedUptimeMs) && holder.startedUptimeMs >= 0
}

function wallClockElapsed(holder, options) {
  const wall = typeof holder?.startedAt === 'string' ? (options.now?.() ?? Date.now()) - Date.parse(holder.startedAt) : NaN
  return Number.isFinite(wall) && wall >= 0 ? wall : 600_001
}

function abandonedElapsed(holder, options) {
  const clock = (options.bootClock ?? suiteLockBootClock)()
  const elapsed = clock.uptimeMs - holder?.startedUptimeMs
  const sameBoot = sameBootIdentity(clock, holder)
  if (sameBoot && validBootStart(holder) && Number.isFinite(elapsed) && elapsed >= 0) return elapsed
  return wallClockElapsed(holder, options)
}

/** Reclaim never serves a turn; unknown elapsed conservatively retains the S penalty. */
export function recordAbandonedSuiteLock(root, holder, options = {}) {
  try {
    const heldMs = abandonedElapsed(holder, options)
    if (heldMs > 600_000) recordSuiteLockService({ root, holder, staticDomain: options.staticDomain || path.basename(root) === 'static-lane' }, { heldMs, served: false })
  } catch (error) { warn(error) }
}

export function setSuiteLockPrecedence(root, entry) {
  publish(stateFile(root, 'precedence', entry.project), entry)
}

export function clearSuiteLockPrecedence(root, project) {
  // Publishing a tombstone also makes concurrent set/clear atomic for this project.
  publish(stateFile(root, 'precedence', project), { project, until: null, source: null })
}

export function listSuiteLockPrecedence(root, now = Date.now()) {
  return entries(root, 'precedence').filter((entry) => suiteLockIsoTime(entry.until) > now).sort((a, b) => a.project.localeCompare(b.project))
}
