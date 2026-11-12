import { createHash } from 'node:crypto'
import path from 'node:path'
import { normalizeSuiteLockProject } from '../suite-lock-rank-common.mjs'
import { pruneSuiteLockRankState, publishRankJson as publish, rankEntries as entries, readRankJson as readJson } from './suite-lock-rank-files.mjs'

const hash = (project) => createHash('sha256').update(project).digest('hex').slice(0, 16)
const stateFile = (root, kind, project) => path.join(root, kind, `${hash(project)}.json`)
const safeSequence = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0
let warned = false

export function readSuiteLockRankState(root, tickets = []) {
  const projects = new Set(tickets.map(({ record }) => normalizeSuiteLockProject(record?.project)))
  const current = (kind) => [...projects].map((project) => readJson(stateFile(root, kind, project)))
    .filter((entry) => projects.has(entry?.project))
  return {
    turns: Object.fromEntries(current('project-turns').map((entry) => [entry.project, safeSequence(entry.turn)])),
    history: Object.fromEntries(current('size-history').filter((entry) => entry.size === 'S' && Number.isFinite(entry.heldMs)).map((entry) => [entry.project, entry])),
    precedence: Object.fromEntries(current('precedence').map((entry) => [entry.project, entry])),
  }
}

function warn(error) {
  if (warned) return
  warned = true
  process.stderr.write(`wt-suite-lock: rank state unavailable (${error?.code ?? 'unknown'}); continuing admission\n`)
}

function advisoryWrite(write) {
  try { write() } catch (error) { warn(error) }
}

export function suiteLockReleaseOutcome(lease, outcome, now = Date.now()) {
  const elapsed = Math.max(0, now - Date.parse(lease.holder.startedAt))
  const heldMs = Number.isFinite(outcome.heldMs) && outcome.heldMs >= 0 ? outcome.heldMs : elapsed
  const served = outcome.served === true && outcome.exit !== 75 && !outcome.lost && !outcome.yielded
  return { ...outcome, heldMs, served }
}

/** Called by the sole holder, before lock.d is removed. Advisory failures never fail release. */
export function recordSuiteLockService(lease, outcome) {
  const { holder, root } = lease
  if (lease.staticDomain) return
  try {
    if (holder.light) return
    const project = normalizeSuiteLockProject(holder.project)
    if (outcome.served && holder.priority !== 'release') advisoryWrite(() => stampProjectTurn(root, project))
    if (holder.size === 'S' && (outcome.served || outcome.heldMs > 600_000)) advisoryWrite(() => publish(stateFile(root, 'size-history', project), {
      project, size: 'S', heldMs: outcome.heldMs, overran: outcome.heldMs > 600_000, at: new Date().toISOString(),
    }))
  } catch (error) { warn(error) }
  finally { pruneSuiteLockRankState(root) }
}

function stampProjectTurn(root, project) {
  // Recovery may enumerate at release, never on the acquisition poll path. Read the
  // high-water mark before pruning so a restarted counter cannot reuse a stale turn.
  let highest = safeSequence(readJson(path.join(root, 'turn-seq'))?.sequence)
  for (const entry of entries(root, 'project-turns', true)) highest = Math.max(highest, safeSequence(entry.turn))
  const sequence = highest + 1
  publish(path.join(root, 'turn-seq'), { sequence })
  publish(stateFile(root, 'project-turns', project), { project, turn: sequence })
}

export function setSuiteLockPrecedence(root, entry) {
  publish(stateFile(root, 'precedence', entry.project), entry)
}

export function clearSuiteLockPrecedence(root, project) {
  // Publishing a tombstone also makes concurrent set/clear atomic for this project.
  publish(stateFile(root, 'precedence', project), { project, until: null, source: null })
}

export function listSuiteLockPrecedence(root, now = Date.now()) {
  return entries(root, 'precedence').filter((entry) => Date.parse(entry.until) > now).sort((a, b) => a.project.localeCompare(b.project))
}
