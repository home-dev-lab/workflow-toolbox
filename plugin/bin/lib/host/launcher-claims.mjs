import { mkdirSync, readFileSync, readdirSync, rmdirSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { hostAdapter } from './adapter.mjs'
import { eventName, eventNames, eventOperation, eventReason, privateEventDirectory, readEvent, removeEventFile } from './launcher-maildir.mjs'

function readerIdentity(pid) {
  const exact = hostAdapter.readProcessIdentity(pid)
  if (exact.status === 'known') return exact.startIdentity
  if (hostAdapter.platform === 'linux') return null
  const value = hostAdapter.readProcessSnapshot().processes?.find((item) => item.pid === pid)?.startIdentity
  return Number.isFinite(value) && value >= 0 ? `snapshot:${hostAdapter.platform}:${value}` : null
}

function identityKind(value) {
  if (typeof value !== 'string') return null
  if (/^linux:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:\d+$/i.test(value)) return 'linux'
  const match = /^snapshot:(darwin|win32|aix|freebsd|sunos):(\d+(?:\.\d+)?)$/.exec(value)
  return match && Number.isFinite(Number(match[2])) ? `snapshot:${match[1]}` : null
}

export function readerDead(directory, options) {
  let owner
  try { owner = JSON.parse(readFileSync(path.join(directory, 'owner.json'), 'utf8')) }
  catch { eventReason(options, 'reader-owner-unknown'); return false }
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) { eventReason(options, 'reader-owner-unknown'); return false }
  const execution = hostAdapter.readProcessExecutionState(owner.pid)
  const live = execution.status === 'unknown' ? hostAdapter.readProcessLiveness(owner.pid) : execution
  if (live.status === 'gone') return true
  const actual = live.status === 'alive' ? readerIdentity(owner.pid) : null
  const kind = identityKind(owner.startIdentity)
  if (kind && kind === identityKind(actual)) return actual !== owner.startIdentity
  eventReason(options, 'reader-liveness-unknown')
  return false
}

function claimDirectories(paths) {
  return readdirSync(paths.box).filter((name) => name.startsWith('claimed-')).map((name) => path.join(paths.box, name))
}

export function recoverClaims(paths, options) {
  for (const directory of claimDirectories(paths)) {
    try {
      privateEventDirectory(directory)
      if (!eventNames(directory).length || !readerDead(directory, options)) continue
      for (const name of eventNames(directory)) recoverClaim(paths, directory, name, options)
      cleanReader(directory, options)
    } catch (error) { eventReason(options, 'reader-owner-unknown', error) }
  }
}

function recoverClaim(paths, directory, name, options) {
  const file = path.join(directory, name)
  try {
    if (printedAt(file, options, true) !== null) acknowledgeClaim(paths, { file, name, printed: true }, options)
    else eventOperation('rename', file, path.join(paths.pending, name), options)
  } catch (error) { if (error.code !== 'ENOENT') eventReason(options, 'launcher-recovery-failed', error) }
}

export function claimEvent(paths, name, options) {
  const directory = path.join(paths.box, `claimed-${eventName()}`)
  mkdirSync(directory, { mode: 0o700 })
  writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid: process.pid, startIdentity: readerIdentity(process.pid) }), { flag: 'wx', mode: 0o600 })
  const file = path.join(directory, name)
  try { eventOperation('rename', path.join(paths.pending, name), file, options) }
  catch (error) { cleanReader(directory, options); if (error.code === 'ENOENT') { return null } throw error }
  try { return { file, name, event: readEvent(file) } }
  catch (error) { returnClaim(paths, { file, name }, options); throw error }
}

export function returnClaim(paths, claim, options) {
  try { eventOperation('rename', claim.file, path.join(paths.pending, claim.name), options); cleanReader(path.dirname(claim.file), options) }
  catch (error) { eventReason(options, 'launcher-return-failed', error) }
}

export function acknowledgeClaim(paths, claim, options) {
  const file = path.join(paths.done, claim.name)
  try {
    if (!claim.printed && printedAt(claim.file, options) === null && !storePrintedMarker(claim, options)) return false
    const now = new Date(options.now ?? Date.now())
    // Stamp before exposing done to pruning, including after a recovery or interruption.
    utimesSync(claim.file, now, now)
    eventOperation('rename', claim.file, file, options)
  }
  catch (error) { eventReason(options, 'launcher-acknowledge-failed', error); return false }
  cleanReader(path.dirname(claim.file), options)
  return true
}

function unknownPrint(options, reason, error) {
  eventReason(options, reason, error)
  return options.now ?? Date.now()
}

function printedAt(file, options, includePartial = false) {
  if (path.basename(path.dirname(file)).startsWith('claimed-printed-unknown-')) {
    return unknownPrint(options, 'launcher-printed-unknown-directory')
  }
  try {
    const value = JSON.parse(readFileSync(`${file}.printed`, 'utf8'))
    if (!Number.isFinite(value?.at)) throw new Error('launcher-printed-marker-invalid')
    return value.at
  } catch (error) {
    if (error.code !== 'ENOENT') return unknownPrint(options, 'launcher-printed-marker-unknown', error)
  }
  if (!includePartial) return null
  // A crash during a private marker write is also post-output evidence. Its bytes
  // need not be readable or complete for recovery to prefer acknowledgement.
  const prefix = `${path.basename(file)}.`
  const partial = readdirSync(path.dirname(file)).some((name) => name.startsWith(prefix) && name.endsWith('.printed'))
  return partial ? unknownPrint(options, 'launcher-printed-marker-unknown') : null
}

function storePrintedMarker(claim, options) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const temporary = `${claim.file}.${eventName()}.printed`
    try {
      writeFileSync(temporary, JSON.stringify({ at: options.now ?? Date.now() }), { flag: 'wx', mode: 0o600 })
      eventOperation('rename', temporary, `${claim.file}.printed`, options)
      return true
    } catch (error) { eventReason(options, 'launcher-printed-marker-write-failed', error) }
    finally { removeEventFile(temporary, options) }
  }
  claim.deliveryUnknown = true
  const directory = path.dirname(claim.file)
  const unknown = path.join(path.dirname(directory), `claimed-printed-unknown-${eventName()}`)
  try {
    eventOperation('rename', directory, unknown, options)
    claim.file = path.join(unknown, claim.name)
    eventReason(options, 'launcher-printed-unknown-recorded')
  } catch (error) { eventReason(options, 'launcher-printed-unknown-unrecorded', error) }
  return false
}

export function claimWasPrinted(claim, options = {}) {
  try { return printedAt(claim.file, options) !== null } catch { return false }
}

function cleanReader(directory, options) {
  // Only remove empty, completed reader directories. A claim or malformed owner is retained.
  try {
    if (eventNames(directory).length) return
    for (const name of readdirSync(directory)) {
      if (/^\d+-\d+-[A-Za-z0-9-]+\.json(?:\.\d+-\d+-[A-Za-z0-9-]+)?\.printed$/.test(name)) removeEventFile(path.join(directory, name), options)
    }
    const names = readdirSync(directory)
    if (names.length !== 1 || names[0] !== 'owner.json') return
    removeEventFile(path.join(directory, 'owner.json'), options)
    rmdirSync(directory)
  } catch (error) { if (!['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes(error.code)) eventReason(options, 'launcher-cleanup-failed', error) }
}
