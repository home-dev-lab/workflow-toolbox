import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const RUN_TAG_ENV = 'WT_TEST_RUN_TAG'

export function listTaggedPids(tag, { platform = process.platform, procRoot = '/proc', runPs } = {}) {
  if (!/^[0-9a-f-]{36}$/.test(tag)) throw new Error('invalid test run tag')
  const token = `${RUN_TAG_ENV}=${tag}`
  if (platform === 'linux') {
    const pids = []
    let entries
    let unreadable = 0
    try { entries = readdirSync(procRoot) } catch (error) { return { supported: false, pids, reason: `cannot list ${procRoot}: ${error.code ?? error.message}` } }
    for (const entry of entries) {
      if (!/^[0-9]+$/.test(entry)) continue
      try {
        if (readFileSync(join(procRoot, entry, 'environ'), 'utf8').split('\0').includes(token)) pids.push(Number(entry))
      } catch (error) {
        // A process that exits (ENOENT, ESRCH) or belongs to another user (EACCES) during the scan
        // is expected; anything else is counted so the caller can report an incomplete sweep.
        if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) unreadable++
      }
    }
    return { supported: true, pids, unreadable }
  }
  if (platform === 'darwin') {
    let output
    try { output = runPs ? runPs() : execFileSync('ps', ['-wwEax', '-o', 'pid=,command='], { encoding: 'utf8' }) }
    catch (error) {
      const reason = error.code === 'ENOBUFS' ? 'ps output exceeded its buffer' : `ps failed: ${error.code ?? error.message}`
      return { supported: false, pids: [], reason }
    }
    const pids = []
    for (const line of output.split('\n')) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line)
      if (match && match[2].split(/\s+/).includes(token)) pids.push(Number(match[1]))
    }
    return { supported: true, pids }
  }
  return { supported: false, pids: [], reason: `process enumeration unavailable on ${platform}` }
}

export function reapTagged(tag, { exclude = [], kill = (pid) => process.kill(pid, 'SIGKILL'), ...listOptions } = {}) {
  const skipped = new Set([process.pid, ...exclude])
  const killed = []
  const errors = []
  for (let round = 0; round < 5; round++) {
    const { supported, pids, reason, unreadable = 0 } = listTaggedPids(tag, listOptions)
    if (!supported) return { supported, killed, errors, reason }
    if (unreadable) errors.push({ pid: 'scan', code: `${unreadable} unreadable environ` })
    const targets = pids.filter((pid) => !skipped.has(pid))
    if (!targets.length) return { supported, killed, errors }
    for (const pid of targets) {
      try {
        kill(pid)
        killed.push(pid)
      } catch (error) {
        if (error.code !== 'ESRCH') errors.push({ pid, code: error.code ?? 'UNKNOWN' })
      }
      skipped.add(pid)
    }
  }
  return { supported: true, killed, errors }
}

// /proc/<pid>/stat field 2 is the command name in parentheses and may itself contain spaces and
// parentheses, so fields are counted from the LAST ')': state is field 3, starttime field 22.
export function parseStatFields(stat) {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  return { state: fields[0], startTime: fields[19] }
}

export function linuxStartTime(pid, { readStat = (target) => readFileSync(`/proc/${target}/stat`, 'utf8') } = {}) {
  try { return parseStatFields(readStat(pid)).startTime } catch { return undefined }
}

// Only a vanished process (ESRCH, ENOENT), a zombie, or a different start time means the watched
// parent is gone. Any other failure to read it leaves it alive: reaping a live run is the worse error.
export function parentGone(pid, startTime, { platform = process.platform, probe = (target) => process.kill(target, 0), readStat = (target) => readFileSync(`/proc/${target}/stat`, 'utf8') } = {}) {
  try { probe(pid) } catch (error) { if (error.code === 'ESRCH') return true }
  if (platform !== 'linux' || startTime === undefined) return false
  let stat
  try { stat = readStat(pid) } catch (error) { return error.code === 'ENOENT' || error.code === 'ESRCH' }
  const { state, startTime: current } = parseStatFields(stat)
  return state === 'Z' || current !== startTime
}

// Start time guards against pid reuse between registration and this check. Node offers no
// pidfd to close the gap between the identity check and the signal.
export function reapRegisteredWorkers(registry, { platform = process.platform, startTimeOf = linuxStartTime, kill = (pid) => process.kill(pid, 'SIGKILL') } = {}) {
  const killed = []
  const errors = []
  if (platform !== 'linux') return { killed, errors }
  let entries
  try { entries = readdirSync(registry) } catch (error) {
    if (error.code === 'ENOENT') return { killed, errors }
    throw error
  }
  for (const entry of entries) {
    if (!/^[1-9][0-9]*$/.test(entry)) continue
    const pid = Number(entry)
    if (!Number.isSafeInteger(pid) || pid === process.pid) continue
    let recorded
    try { recorded = readFileSync(join(registry, entry), 'utf8') } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    if (!recorded || recorded !== startTimeOf(pid)) continue
    try { kill(pid); killed.push(pid) } catch (error) {
      if (error.code !== 'ESRCH') errors.push({ pid, code: error.code ?? 'UNKNOWN' })
    }
  }
  return { killed, errors }
}

export function onParentDeath({ tag, registry, reapTagged: sweep = reapTagged, reapRegisteredWorkers: workers = reapRegisteredWorkers, removeRegistry = (path) => rmSync(path, { recursive: true, force: true }) }) {
  const errors = []
  for (const [name, step] of [['workers', () => workers(registry)], ['tagged', () => sweep(tag)], ['remove', () => removeRegistry(registry)]]) {
    try { errors.push(...(step()?.errors ?? [])) }
    catch (error) { errors.push({ step: name, code: error.code ?? error.message ?? String(error) }) }
  }
  return errors
}

if (process.argv[1] === import.meta.filename && process.argv[2] === '--watch') {
  const pid = Number(process.argv[3])
  const tag = process.argv[4] === '--tag' ? process.argv[5] : undefined
  const registry = process.argv[6] === '--registry' ? process.argv[7] : undefined
  if (!Number.isSafeInteger(pid) || pid < 1 || !/^[0-9a-f-]{36}$/.test(tag ?? '') || !registry) throw new Error('invalid watchdog arguments')
  const startTime = process.platform === 'linux' ? linuxStartTime(pid) : undefined
  const poll = setInterval(() => {
    if (parentGone(pid, startTime)) {
      clearInterval(poll)
      const errors = onParentDeath({ tag, registry })
      if (errors.length) process.stderr.write(`orphan reaper: cleanup errors: ${errors.map((error) => `${error.step ?? error.pid}: ${error.code}`).join(', ')}\n`)
      process.exit(0)
    }
  }, 500)
}
