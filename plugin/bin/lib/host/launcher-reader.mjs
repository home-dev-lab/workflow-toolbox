import { mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { hostAdapter } from './adapter.mjs'
import { refuseEventSymlink } from './launcher-event-io.mjs'
import { eventReason } from './launcher-maildir.mjs'

export function readerIdentity(pid) {
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

export function readerOwnerDead(owner, options) {
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

export function readerDead(directory, options) {
  try {
    const file = path.join(directory, 'owner.json'); refuseEventSymlink(file)
    return readerOwnerDead(JSON.parse(readFileSync(file, 'utf8')), options)
  }
  catch (error) { eventReason(options, 'reader-owner-unknown', error); return false }
}

function removeEmpty(directory) {
  try { rmdirSync(directory) }
  catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error }
}

function removeToken(directory, token) {
  // A stale reaper can address only its observed incarnation's unguessable name.
  try { unlinkSync(path.join(directory, token)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  removeEmpty(directory)
}

function reapWriter(directory, options) {
  try {
    refuseEventSymlink(directory)
    const names = readdirSync(directory)
    if (!names.length) { removeEmpty(directory); return }
    if (names.length !== 1 || !/^[0-9a-f-]{36}\.owner$/.test(names[0])) return
    const file = path.join(directory, names[0]); refuseEventSymlink(file)
    const owner = JSON.parse(readFileSync(file, 'utf8'))
    if (owner.token === names[0] && readerOwnerDead(owner, options)) removeToken(directory, names[0])
  } catch (error) { if (error.code !== 'ENOENT') eventReason(options, 'reader-owner-unknown', error) }
}

function writerStage(paths, owner) {
  const stage = mkdtempSync(path.join(paths.box, '.delivery-writer-'))
  try {
    writeFileSync(path.join(stage, owner.token), JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
    return stage
  } catch (error) { removeEmpty(stage); throw error }
}

export function acquireJournalWriter(paths, options) {
  const directory = path.join(paths.box, 'delivery.writer')
  for (const name of readdirSync(paths.box)) {
    if (name.startsWith('.delivery-writer-')) reapWriter(path.join(paths.box, name), options)
  }
  const owner = { pid: process.pid, startIdentity: readerIdentity(process.pid), token: `${randomUUID()}.owner` }
  const stage = writerStage(paths, owner)
  let acquired = false
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      reapWriter(directory, options)
      try { renameSync(stage, directory); acquired = true; return { directory, token: owner.token } }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error }
    }
    return null
  } finally { if (!acquired) removeToken(stage, owner.token) }
}

export function releaseJournalWriter(writer, options) {
  try { removeToken(writer.directory, writer.token) }
  catch (error) { eventReason(options, 'launcher-cleanup-failed', error) }
}
