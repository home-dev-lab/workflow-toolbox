import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, homedir, loadavg } from 'node:os'
import { join } from 'node:path'
import { resolvePluginDataDir } from './plugin-data-dir.mjs'

const POLL_MS = 2_000
let writeSerial = 0

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

function atomicWrite(file, value) {
  writeSerial += 1
  const temporary = `${file}.${process.pid}.${writeSerial}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    throw error
  }
}

function coreCount(probe = availableParallelism) {
  try {
    const count = Number(probe())
    return Number.isSafeInteger(count) && count > 0 ? count : null
  } catch { return null }
}

function measurePilotLoad(options = {}) {
  const platform = options.platform ?? process.platform
  const cores = coreCount(options.availableParallelism)
  if (cores === null) return { available: false, load: null, cores: null, reason: 'available core count is unreadable; using concurrency cap only' }
  if (platform === 'linux') {
    try {
      const value = Number((options.readFile ?? readFileSync)('/proc/loadavg', 'utf8').trim().split(/\s+/)[0])
      if (Number.isFinite(value) && value >= 0) return { available: true, load: value, cores, source: '/proc/loadavg' }
    } catch { /* The named cap-only result below is the fail-safe. */ }
    return { available: false, load: null, cores, reason: 'Linux /proc/loadavg is unreadable; using concurrency cap only' }
  }
  if (platform === 'darwin') {
    try {
      const value = Number((options.loadavg ?? loadavg)()[0])
      if (Number.isFinite(value) && value >= 0) return { available: true, load: value, cores, source: 'os.loadavg()' }
    } catch { /* The named cap-only result below is the fail-safe. */ }
    return { available: false, load: null, cores, reason: 'macOS os.loadavg() is unreadable; using concurrency cap only' }
  }
  if (platform === 'win32') return { available: false, load: null, cores, reason: 'Windows os.loadavg() reports zeros; using concurrency cap only' }
  return { available: false, load: null, cores, reason: `${platform} has no supported load probe; using concurrency cap only` }
}

function admissionDecision(records, id, conditions) {
  const queued = records.filter((record) => record.state === 'queued')
    .sort((left, right) => left.enqueuedAt - right.enqueuedAt || left.id.localeCompare(right.id))
  const position = queued.findIndex((record) => record.id === id) + 1
  const active = records.filter((record) => record.state === 'active').length
  if (position !== 1) return { admit: false, position, waiting: { kind: 'fifo' } }
  if (conditions.load !== null && conditions.load >= conditions.cores) {
    return { admit: false, position, waiting: { kind: 'load', load: conditions.load, cores: conditions.cores } }
  }
  if (active >= conditions.maxActive) return { admit: false, position, waiting: { kind: 'slot', active, limit: conditions.maxActive } }
  return { admit: true, position }
}

function defaultRoot(env) {
  const fallback = join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'workflow-toolbox', 'sdk-pilot-admission')
  return resolvePluginDataDir({ env, fallback }).dir
}

function readRecord(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

function entryFiles(root) {
  try { return readdirSync(join(root, 'entries')).filter((name) => name.endsWith('.json')).map((name) => join(root, 'entries', name)) } catch { return [] }
}

async function withQueueLock(root, work, options = {}) {
  const lock = join(root, 'lock.d')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  while (true) {
    try {
      mkdirSync(lock)
      atomicWrite(join(lock, 'holder.json'), { pid: process.pid })
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const holder = readRecord(join(lock, 'holder.json'))
      if (holder && !(options.isAlive ?? pidAlive)(holder.pid)) { rmSync(lock, { recursive: true, force: true }); continue }
      await (options.sleep ?? sleep)(options.pollMs ?? 50)
    }
  }
  try { return work() } finally { rmSync(lock, { recursive: true, force: true }) }
}

function liveRecords(root, isAlive) {
  const records = []
  for (const file of entryFiles(root)) {
    const record = readRecord(file)
    if (!record || !isAlive(record.pid)) { rmSync(file, { force: true }); continue }
    records.push({ ...record, file })
  }
  return records
}

function publish(record) {
  atomicWrite(record.file, record)
  atomicWrite(record.statusFile, record)
}

async function awaitPilotAdmission(options) {
  const env = options.env ?? process.env
  const maxActive = Number(options.maxActive)
  if (!Number.isSafeInteger(maxActive) || maxActive <= 0) throw new Error('sdk_pilot_max_active must be a positive integer')
  const root = options.root ?? defaultRoot(env)
  const entries = join(root, 'entries')
  const statusFile = join(options.worktree, '.lane', 'admission.json')
  const now = options.now ?? Date.now
  const isAlive = options.isAlive ?? pidAlive
  mkdirSync(entries, { recursive: true, mode: 0o700 })
  mkdirSync(join(options.worktree, '.lane'), { recursive: true })
  const enqueuedAt = now()
  const id = `${String(options.card).replace(/[^A-Za-z0-9_-]/g, '_')}-${options.pid ?? process.pid}-${enqueuedAt}`
  const record = { id, cardId: String(options.card), pid: options.pid ?? process.pid, worktree: options.worktree, enqueuedAt, state: 'queued', position: null, waiting: { kind: 'fifo' }, statusFile, file: join(entries, `${id}.json`) }
  await withQueueLock(root, () => publish(record), { ...options, isAlive })

  let fallbackLogged = false
  while (true) {
    const measured = (options.measureLoad ?? measurePilotLoad)()
    if (!measured.available && !fallbackLogged) {
      options.log?.(`admission load unavailable: ${measured.reason}`)
      fallbackLogged = true
    }
    const result = await withQueueLock(root, () => {
      const records = liveRecords(root, isAlive)
      const decision = admissionDecision(records, id, { load: measured.available ? measured.load : null, cores: measured.cores, maxActive })
      const next = { ...record, state: decision.admit ? 'active' : 'queued', position: decision.position, waiting: decision.admit ? null : decision.waiting, load: measured, ...(decision.admit ? { admittedAt: now() } : {}) }
      publish(next)
      Object.assign(record, next)
      return decision
    }, { ...options, isAlive })
    if (result.admit) return { root, record }
    await (options.sleep ?? sleep)(options.pollMs ?? POLL_MS)
  }
}

async function finishPilotAdmission(lease, options = {}) {
  if (!lease) return
  await withQueueLock(lease.root, () => {
    const current = readRecord(lease.record.file)
    if (current?.id === lease.record.id) rmSync(lease.record.file, { force: true })
    atomicWrite(lease.record.statusFile, { ...lease.record, state: 'finished', position: null, waiting: null, finishedAt: (options.now ?? Date.now)() })
  }, options)
}

export const pilotAdmission = Object.freeze({ admissionDecision, measurePilotLoad, awaitPilotAdmission, finishPilotAdmission })
