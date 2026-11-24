import { mkdirSync, readFileSync, readdirSync, rmdirSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { hostAdapter } from './adapter.mjs'
import { eventName, eventNames, eventOperation, eventReason, privateEventDirectory, readEvent, removeEventFile } from './launcher-maildir.mjs'

function readerIdentity(pid) {
  const exact = hostAdapter.readProcessIdentity(pid)
  if (exact.status === 'known') return exact.startIdentity
  if (hostAdapter.platform === 'linux') return null
  return hostAdapter.readProcessSnapshot().processes?.find((item) => item.pid === pid)?.startIdentity ?? null
}

export function readerDead(directory, options) {
  let owner
  try { owner = JSON.parse(readFileSync(path.join(directory, 'owner.json'), 'utf8')) }
  catch { eventReason(options, 'reader-owner-unknown'); return false }
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) { eventReason(options, 'reader-owner-unknown'); return false }
  const execution = hostAdapter.readProcessExecutionState(owner.pid)
  const live = execution.status === 'unknown' ? hostAdapter.readProcessLiveness(owner.pid) : execution
  if (live.status === 'gone') return true
  const actual = live.status === 'alive' ? readerIdentity(owner.pid) : null
  if (actual != null && owner.startIdentity != null) return actual !== owner.startIdentity
  eventReason(options, 'reader-liveness-unknown')
  return false
}

export function claimDirectories(paths) {
  return readdirSync(paths.box).filter((name) => name.startsWith('claimed-')).map((name) => path.join(paths.box, name))
}

export function recoverClaims(paths, options) {
  for (const directory of claimDirectories(paths)) {
    try {
      privateEventDirectory(directory)
      if (!eventNames(directory).length || !readerDead(directory, options)) continue
      for (const name of eventNames(directory)) {
        try { eventOperation('rename', path.join(directory, name), path.join(paths.pending, name), options) }
        catch (error) { if (error.code !== 'ENOENT') eventReason(options, 'launcher-recovery-failed', error) }
      }
      cleanReader(directory, options)
    } catch (error) { eventReason(options, 'reader-owner-unknown', error) }
  }
}

export function claimEvent(paths, name, options) {
  const directory = path.join(paths.box, `claimed-${eventName()}`)
  mkdirSync(directory, { mode: 0o700 })
  writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid: process.pid, startIdentity: readerIdentity(process.pid) }), { flag: 'wx', mode: 0o600 })
  const file = path.join(directory, name)
  try { eventOperation('rename', path.join(paths.pending, name), file, options) }
  catch (error) { cleanReader(directory, options); if (error.code === 'ENOENT') { return null } throw error }
  return { file, name, event: readEvent(file) }
}

export function returnClaim(paths, claim, options) {
  try { eventOperation('rename', claim.file, path.join(paths.pending, claim.name), options); cleanReader(path.dirname(claim.file), options) }
  catch (error) { eventReason(options, 'launcher-return-failed', error) }
}

export function acknowledgeClaim(paths, claim, options) {
  const file = path.join(paths.done, claim.name)
  try { eventOperation('rename', claim.file, file, options) }
  catch (error) { eventReason(options, 'launcher-acknowledge-failed', error); return false }
  try { const now = new Date(options.now ?? Date.now()); utimesSync(file, now, now) }
  catch (error) { eventReason(options, 'launcher-retention-failed', error) }
  cleanReader(path.dirname(claim.file), options)
  return true
}

export function cleanReader(directory, options) {
  // Only remove empty, completed reader directories. A claim or malformed owner is retained.
  try {
    if (eventNames(directory).length) return
    const names = readdirSync(directory)
    if (names.length !== 1 || names[0] !== 'owner.json') return
    removeEventFile(path.join(directory, 'owner.json'), options)
    rmdirSync(directory)
  } catch (error) { if (!['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes(error.code)) eventReason(options, 'launcher-cleanup-failed', error) }
}
