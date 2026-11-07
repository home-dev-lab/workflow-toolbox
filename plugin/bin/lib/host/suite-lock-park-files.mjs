import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pidAlive } from '../artifact-server.mjs'
import { processStartTime } from './pid-namespace.mjs'

const PARK_FILE = /^(\d{16})\.parked$/
// Node's signal API accepts a signed 32-bit PID; larger values produce unknown liveness.
const MAX_PROCESS_PID = 2_147_483_647
export const parkFile = (queueDir, number) => path.join(queueDir, `${String(number).padStart(16, '0')}.parked`)
const jsonFile = (queueDir, number) => parkFile(queueDir, number).replace(/\.parked$/, '.json')
const MAX_PARK_BYTES = 65_536

function requireRegularPark(info) {
  if (!info.isFile() || info.size > MAX_PARK_BYTES) throw new Error('park control file must be regular and at most 65536 bytes')
}

function readParkText(file) {
  requireRegularPark(lstatSync(file))
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    requireRegularPark(fstatSync(fd))
    const buffer = Buffer.alloc(MAX_PARK_BYTES + 1)
    let size = 0
    while (size < buffer.length) {
      const bytes = readSync(fd, buffer, size, buffer.length - size, null)
      if (bytes === 0) break
      size += bytes
    }
    if (size > MAX_PARK_BYTES) throw new Error('park control file exceeds 65536 bytes')
    return buffer.toString('utf8', 0, size)
  } finally { closeSync(fd) }
}

export function readParkJson(file) {
  try { return JSON.parse(readParkText(file)) } catch { return null }
}

export function writeParkPrivate(directory, name, content) {
  const temporary = path.join(directory, `.${name}-${randomUUID()}`)
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path.join(directory, name))
  } finally { rmSync(temporary, { force: true }) }
}

function requireParkDirectory(directory) {
  if (typeof directory !== 'string' || !directory) throw new Error('--park-dir requires an existing directory')
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('--park-dir must be a real directory')
  if (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o700)) {
    throw new Error('--park-dir must be owned by the caller with mode 0700')
  }
}

function parkOwnerIdentity(ownerPid) {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || ownerPid > MAX_PROCESS_PID || !pidAlive(ownerPid)) throw new Error('--park-owner-pid must be a live pid')
  let pidNamespace = null
  try { pidNamespace = readlinkSync(`/proc/${ownerPid}/ns/pid`) } catch { /* unknown off Linux */ }
  return { pid: ownerPid, startTime: processStartTime(ownerPid), pidNamespace }
}

export function validateParkDirectory(directory, ownerPid) {
  requireParkDirectory(directory)
  const key = readFileSync(path.join(directory, 'key'))
  if (key.length < 32) throw new Error('--park-dir/key must contain at least 32 bytes')
  return { directory, keyHash: createHash('sha256').update(key).digest('hex'), owner: parkOwnerIdentity(ownerPid) }
}

export function listParkedFiles(queueDir, now) {
  let names
  try { names = readdirSync(queueDir) } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return names.flatMap((name) => {
    const match = PARK_FILE.exec(name)
    if (!match) return []
    const file = path.join(queueDir, name)
    try { return [{ number: Number(match[1]), park: readParkJson(file), ageMs: now - lstatSync(file).mtimeMs }] } catch { return [] }
  })
}

export function createParkedFile(queueDir, number, park) {
  writeFileSync(parkFile(queueDir, number), `${JSON.stringify(park)}\n`, { flag: 'wx', mode: 0o600 })
}

// The judged nonce belongs to one instance, never merely to a reusable filename.
export function removeParkedInstance(queueDir, number, nonce, seams = {}) {
  const file = parkFile(queueDir, number)
  const aside = `${file}.reclaimed-${Buffer.from(JSON.stringify(parkOwnerIdentity(process.pid))).toString('hex')}.${randomUUID()}`
  seams.beforeAside?.()
  try { renameSync(file, aside) } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  const matches = readParkJson(aside)?.nonce === nonce
  if (!matches) restoreParkAside(aside, file, seams.link)
  rmSync(aside, { force: true })
  return matches
}

function restoreParkAside(aside, file, link = linkSync) {
  // A failed restore must keep the saved instance, never delete a different nonce.
  try { link(aside, file) } catch (error) { if (error?.code !== 'EEXIST') throw error }
}

function asideCreator(name) {
  const encoded = name.split('.parked.reclaimed-')[1]?.split('.')[0]
  try { return JSON.parse(Buffer.from(encoded, 'hex').toString('utf8')) } catch { return null }
}

export function consumeParkAsides(queueDir, number, nonce) {
  const prefix = `${path.basename(parkFile(queueDir, number))}.reclaimed-`
  for (const name of readdirSync(queueDir)) {
    if (!name.startsWith(prefix)) continue
    const file = path.join(queueDir, name)
    if (readParkJson(file)?.nonce === nonce) rmSync(file, { force: true })
  }
}

export function recoverParkAsides(queueDir, now, ownerIsStale, parkIsLive) {
  let names
  try { names = readdirSync(queueDir) } catch (error) { if (error?.code === 'ENOENT') return; throw error }
  for (const name of names) {
    if (!/^\d{16}\.parked\.reclaimed-/.test(name)) continue
    const aside = path.join(queueDir, name)
    if (retainParkAside(name, aside, now, ownerIsStale)) continue
    const file = aside.slice(0, aside.indexOf('.parked.reclaimed-') + '.parked'.length)
    const park = readParkJson(aside)
    if (parkIsLive(park) && !existsSync(file) && !existsSync(file.replace(/\.parked$/, '.json'))) restoreParkAside(aside, file)
    rmSync(aside, { force: true })
  }
}

function retainParkAside(name, aside, now, ownerIsStale) {
  const creator = asideCreator(name)
  const judged = Number.isSafeInteger(creator?.pid) && typeof creator === 'object'
  return judged ? !ownerIsStale(creator) : now - lstatSync(aside).mtimeMs <= 60_000
}

function takeParkAttemptFile(context, ownerIsStale, candidate) {
  const file = path.join(context.directory, 'attempt')
  const claim = candidate.claim
  // Link a completed record exclusively: interruption cannot publish an ownerless empty claim.
  try { linkSync(candidate.file, file) } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const held = readParkJson(file)
    if (!Number.isSafeInteger(held?.pid) || !ownerIsStale(held)) throw new Error('another attempt holds this park directory')
    const aside = `${file}.reclaimed-${randomUUID()}`
    renameSync(file, aside)
    if (readParkJson(aside)?.nonce !== held.nonce) {
      restoreParkAside(aside, file)
      rmSync(aside, { force: true })
      throw new Error('another attempt holds this park directory')
    }
    rmSync(aside, { force: true })
    return takeParkAttemptFile(context, ownerIsStale, candidate)
  }
  return () => { if (readParkJson(file)?.nonce === claim.nonce) rmSync(file, { force: true }) }
}

function claimAttemptCandidate(directory, ownerIsStale) {
  const owner = parkOwnerIdentity(process.pid)
  const identity = Buffer.from(JSON.stringify(owner)).toString('hex')
  const claim = { ...owner, nonce: randomUUID() }
  const name = `.attempt-${identity}.${claim.nonce}`
  const file = path.join(directory, name)
  writeFileSync(file, JSON.stringify(claim), { flag: 'wx', mode: 0o600 })
  try {
    for (const other of readdirSync(directory)) {
      if (other === name || !other.startsWith('.attempt-')) continue
      const owner = candidateOwner(other)
      if (!owner || !ownerIsStale(owner)) throw new Error('another attempt holds this park directory')
      rmSync(path.join(directory, other), { force: true })
    }
    return { file, claim, release: () => rmSync(file, { force: true }) }
  } catch (error) { rmSync(file, { force: true }); throw error }
}

function candidateOwner(name) {
  try { return JSON.parse(Buffer.from(name.slice('.attempt-'.length).split('.')[0], 'hex').toString('utf8')) } catch { return null }
}

export function claimParkAttempt(context, ownerIsStale) {
  if (!context) return () => {}
  // Publish before scanning, and retain this unique candidacy for the whole run. Even competing
  // stale-claim reclaimers cannot rename a newer live attempt out from under a third acquirer.
  const candidate = claimAttemptCandidate(context.directory, ownerIsStale)
  try {
    const release = takeParkAttemptFile(context, ownerIsStale, candidate)
    return () => { try { release() } finally { candidate.release() } }
  } catch (error) { candidate.release(); throw error }
}

export function claimParkedTicket(queueDir, number, record) {
  try {
    writeFileSync(jsonFile(queueDir, number), `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
}

export function removeParkClaim(queueDir, number, record) {
  const file = jsonFile(queueDir, number)
  if (readParkJson(file)?.leaseId === record.leaseId) rmSync(file, { force: true })
}

export function parkClaimPresent(queueDir, number, record) {
  return readParkJson(jsonFile(queueDir, number))?.leaseId === record.leaseId
}

export const newParkNonce = () => randomUUID()
export const parkEnvironment = (env = process.env) => typeof env === 'function' ? (env() ?? process.env) : env
export const removeParkPrivate = (park, name) => rmSync(path.join(park.directory, name), { force: true })
export function readParkRequest(park) {
  try { return readParkText(path.join(park.directory, 'request')).split(/\r?\n/)[0] } catch (error) {
    if (error?.code !== 'ENOENT') process.stderr.write(`wt-suite-lock: ignoring request: ${error.message}\n`)
    return null
  }
}

export function watchParkWait() {
  const controller = new AbortController()
  let exit = 143
  const handlers = Object.entries({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGQUIT: 131 }).flatMap(([signal, code]) => {
    const handler = () => { exit = code; controller.abort() }
    try { process.once(signal, handler); return [[signal, handler]] } catch { return [] }
  })
  return { signal: controller.signal, exit: () => exit, close: () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler)
  } }
}

export const parkSignalExit = (signal) => ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGQUIT: 131 })[signal] ?? 143

export function watchParkChildSignals(forward) {
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'].flatMap((signal) => {
    const handler = () => forward(signal)
    try { process.once(signal, handler); return [[signal, handler]] } catch { return [] }
  })
  return () => { for (const [signal, handler] of handlers) process.removeListener(signal, handler) }
}
