import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readCounterText } from './suite-lock-queue.mjs'

const hash = (project) => createHash('sha256').update(project).digest('hex').slice(0, 16)
const stateFile = (root, kind, project) => path.join(root, kind, `${hash(project)}.json`)
const safeSequence = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0
let warned = false

function readJson(file) {
  try { return JSON.parse(readCounterText(file)) } catch { return null }
}

function entries(root, kind) {
  try {
    return (readCounterText(path.join(root, kind), readdirSync) ?? []).filter((name) => /^[a-f0-9]{16}\.json$/.test(name))
      .map((name) => readJson(path.join(root, kind, name))).filter((entry) => typeof entry?.project === 'string')
  } catch { return [] }
}

export function readSuiteLockRankState(root) {
  return {
    turns: Object.fromEntries(entries(root, 'project-turns').map((entry) => [entry.project, safeSequence(entry.turn)])),
    history: Object.fromEntries(entries(root, 'size-history').filter((entry) => entry.size === 'S' && Number.isFinite(entry.heldMs)).map((entry) => [entry.project, entry])),
    precedence: Object.fromEntries(entries(root, 'precedence').map((entry) => [entry.project, entry])),
  }
}

function publish(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
  } finally { rmSync(temporary, { force: true }) }
}

function warn(error) {
  if (warned) return
  warned = true
  process.stderr.write(`wt-suite-lock: rank state unavailable (${error?.code ?? 'unknown'}); continuing admission\n`)
}

export function suiteLockReleaseOutcome(lease, outcome, now = Date.now()) {
  const elapsed = Math.max(0, now - Date.parse(lease.holder.startedAt))
  const heldMs = Number.isFinite(outcome.heldMs) && outcome.heldMs >= 0 ? outcome.heldMs : elapsed
  const served = outcome.served !== false && outcome.exit !== 75 && !outcome.lost && !outcome.yielded
  return { ...outcome, heldMs, served }
}

/** Called by the sole holder, before lock.d is removed. Advisory failures never fail release. */
export function recordSuiteLockService(lease, outcome) {
  const { holder, root } = lease
  if (!outcome.served || lease.staticDomain || holder.light || holder.priority === 'release' || !holder.project) return
  try {
    const turns = readSuiteLockRankState(root).turns
    const sequence = Math.max(safeSequence(readJson(path.join(root, 'turn-seq'))?.sequence), ...Object.values(turns), 0) + 1
    publish(path.join(root, 'turn-seq'), { sequence })
    publish(stateFile(root, 'project-turns', holder.project), { project: holder.project, turn: sequence })
    if (holder.size === 'S') publish(stateFile(root, 'size-history', holder.project), {
      project: holder.project, size: 'S', heldMs: outcome.heldMs, overran: outcome.heldMs > 600_000, at: new Date().toISOString(),
    })
  } catch (error) { warn(error) }
}

export function setSuiteLockPrecedence(root, entry) {
  publish(stateFile(root, 'precedence', entry.project), entry)
}

export function clearSuiteLockPrecedence(root, project) {
  // Publishing a tombstone also makes concurrent set/clear atomic for this project.
  publish(stateFile(root, 'precedence', project), { project, until: null, source: null })
}

export function listSuiteLockPrecedence(root) {
  return entries(root, 'precedence').filter((entry) => entry.until !== null).sort((a, b) => a.project.localeCompare(b.project))
}
