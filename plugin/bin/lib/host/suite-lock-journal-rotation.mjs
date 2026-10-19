import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pidAlive } from '../artifact-server.mjs'
import { processStartTime } from './pid-namespace.mjs'
import { abandonEmptyLockDir, discardDirectory, readHolderIn, removeDirectoryOlderThan, setLockAside } from './suite-lock-queue.mjs'

const GRACE_MS = 60_000

function abandonedEmptyRotation(claim) {
  const entry = statSync(claim, { throwIfNoEntry: false })
  return Boolean(entry && Date.now() - entry.mtimeMs >= GRACE_MS)
}

function rotationOwnerGone(claim, holder) {
  if (!Number.isSafeInteger(holder?.pid)) return abandonedEmptyRotation(claim)
  if (!pidAlive(holder.pid)) return true
  const start = processStartTime(holder.pid)
  return Number.isFinite(holder.startTime) && start !== null && start !== holder.startTime
}

function reclaimRotation(root, claim) {
  if (!rotationOwnerGone(claim, readHolderIn(claim))) return
  const guard = path.join(root, 'journal-reclaim.d')
  try { mkdirSync(guard) } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    removeDirectoryOlderThan(guard, GRACE_MS)
    return
  }
  try {
    const holder = readHolderIn(claim)
    if (!rotationOwnerGone(claim, holder)) return
    const aside = setLockAside(claim)
    if (!aside) return
    if (readHolderIn(aside)?.leaseId === holder?.leaseId) discardDirectory(aside)
    else renameSync(aside, claim) // One attempt only: telemetry never waits for restoration.
  } finally { rmSync(guard, { recursive: true, force: true }) }
}

/** Non-blocking, identity-guarded rotation mutex. Busy rotation degrades telemetry, never admission. */
export function claimJournalRotation(root) {
  const claim = path.join(root, 'journal-rotate.d')
  try { mkdirSync(claim) } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    reclaimRotation(root, claim)
    try { mkdirSync(claim) } catch { return null }
  }
  removeDirectoryOlderThan(path.join(root, 'journal-reclaim.d'), GRACE_MS)
  if (statSync(path.join(root, 'journal-reclaim.d'), { throwIfNoEntry: false })) {
    abandonEmptyLockDir(claim)
    return null
  }
  const holder = { pid: process.pid, leaseId: randomUUID(), startTime: processStartTime(process.pid) }
  try { writeFileSync(path.join(claim, 'holder.json'), JSON.stringify(holder), { flag: 'wx', mode: 0o600 }) } catch {
    return null // Another incarnation won publication after a half-created claim was reclaimed.
  }
  return () => {
    if (readHolderIn(claim)?.leaseId === holder.leaseId) rmSync(claim, { recursive: true, force: true })
  }
}
