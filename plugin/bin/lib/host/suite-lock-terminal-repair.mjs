import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { repairSuiteLockJournal, warnSuiteLockJournal } from './suite-lock-journal-append.mjs'
import { completeTerminal, terminalCreator, TERMINAL_LEASE_ID, terminalOwnerGone } from './suite-lock-terminal.mjs'

const COMPLETE_RETENTION_MS = 24 * 60 * 60 * 1000
const present = (file) => statSync(file, { throwIfNoEntry: false }) !== undefined
const readOwner = (directory) => JSON.parse(readFileSync(path.join(directory, 'owner.json'), 'utf8'))

function retireDeadRepair(file, options) {
  if (!present(file)) return true
  const owner = readOwner(file)
  if (!TERMINAL_LEASE_ID.test(owner.token) || !terminalOwnerGone(owner, options)) return false
  try {
    // A nonempty, deterministic destination fences stale contenders even if a new
    // repair directory appears at the source: rename cannot replace that destination.
    renameSync(file, `${file}-retired-${owner.token}`)
    return true
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error?.code)) return false
    throw error
  }
}

function claimRepair(file, options) {
  if (!retireDeadRepair(file, options)) return null
  const owner = { ...terminalCreator(), token: randomUUID() }
  const staging = `${file}-stage-${owner.token}`
  mkdirSync(staging, { mode: 0o700 })
  try {
    writeFileSync(path.join(staging, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
    try { renameSync(staging, file) } catch (error) {
      if (['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error?.code)) return null
      throw error
    }
    // Retire atomically instead of unlinking owner.json first: a crash during
    // recursive removal must never leave an ownerless active repair claim.
    return () => renameSync(file, `${file}-retired-${owner.token}`)
  } finally { rmSync(staging, { recursive: true, force: true }) }
}

function storedEvent(marker, id) {
  if (typeof marker.line !== 'string' || !marker.line.endsWith('\n') || marker.line.indexOf('\n') !== marker.line.length - 1) return null
  if (Buffer.byteLength(marker.line) >= 4096) return null
  const event = JSON.parse(marker.line)
  if (event.leaseId !== id || !['abort', 'timeout', 'release'].includes(event.event)) return null
  // Repair appends the stored bytes, not a reconstructed event.
  return event
}

function repairTerminal(root, file, id, marker, options) {
  if (!storedEvent(marker, id) || !terminalOwnerGone(marker.creator, options)) return
  const release = claimRepair(`${file}.repair`, options)
  if (!release) return
  try {
    if (present(`${file}.written`)) return
    // Only the exclusive repair owner reads both generations, after creator death.
    if (repairSuiteLockJournal(root, marker.line)) completeTerminal(file)
  } finally { release() }
}

function pruneComplete(file, names, now, options) {
  // Retirement creates a name absent from this pass's directory snapshot.
  // Leave the complete set until the next pass can remove its whole marker set.
  if (present(`${file}.repair`)) { retireDeadRepair(`${file}.repair`, options); return }
  if (now - statSync(`${file}.written`).mtimeMs <= COMPLETE_RETENTION_MS) return
  const id = path.basename(file)
  for (const name of names.filter((name) => name.startsWith(`${id}.repair`))) {
    rmSync(path.join(path.dirname(file), name), { recursive: true, force: true })
  }
  rmSync(file, { force: true })
  // Keep completion until last, so an interrupted prune is still collectible.
  rmSync(`${file}.written`, { force: true })
}

// A creator killed inside the claim's own write leaves no identity and no stored line:
// nothing can repair it, so it is held for the same retention, then removed.
function readClaim(file, now) {
  const content = readFileSync(file, 'utf8')
  try { return JSON.parse(content) } catch {
    if (now - statSync(file).mtimeMs > COMPLETE_RETENTION_MS) rmSync(file, { force: true })
    return null
  }
}

function visitTerminal(root, file, id, names, now, options) {
  if (present(`${file}.written`)) return pruneComplete(file, names, now, options)
  const marker = readClaim(file, now)
  if (marker) repairTerminal(root, file, id, marker, options)
}

/** One directory read per queue reaper pass; no journal read unless repair is due. */
export function reapSuiteTerminals(root, options = {}) {
  const directory = path.join(root, 'terminal.d')
  let names
  try { names = readdirSync(directory) } catch (error) {
    if (error?.code !== 'ENOENT') warnSuiteLockJournal(error)
    return
  }
  const now = Date.now()
  const ids = names.map((name) => name.endsWith('.written') ? name.slice(0, -8) : name)
  for (const id of new Set(ids.filter((name) => TERMINAL_LEASE_ID.test(name)))) {
    const file = path.join(directory, id)
    try { visitTerminal(root, file, id, names, now, options) } catch (error) { if (error?.code !== 'ENOENT') warnSuiteLockJournal(error) }
  }
}
