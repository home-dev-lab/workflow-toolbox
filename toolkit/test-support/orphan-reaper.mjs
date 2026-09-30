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
    try { entries = readdirSync(procRoot) } catch { return { supported: false, pids } }
    for (const entry of entries) {
      if (!/^[0-9]+$/.test(entry)) continue
      try {
        if (readFileSync(join(procRoot, entry, 'environ'), 'utf8').split('\0').includes(token)) pids.push(Number(entry))
      } catch { /* A process may exit or deny access during the scan. */ }
    }
    return { supported: true, pids }
  }
  if (platform === 'darwin') {
    let output
    try { output = runPs ? runPs() : execFileSync('ps', ['-wwEax', '-o', 'pid=,command='], { encoding: 'utf8' }) }
    catch { return { supported: false, pids: [] } }
    const pids = []
    for (const line of output.split('\n')) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line)
      if (match && match[2].split(/\s+/).includes(token)) pids.push(Number(match[1]))
    }
    return { supported: true, pids }
  }
  return { supported: false, pids: [] }
}

export function reapTagged(tag, { exclude = [], kill = (pid) => process.kill(pid, 'SIGKILL'), ...listOptions } = {}) {
  const skipped = new Set([process.pid, ...exclude])
  const killed = []
  const errors = []
  for (let round = 0; round < 5; round++) {
    const { supported, pids } = listTaggedPids(tag, listOptions)
    if (!supported) return { supported, killed, errors }
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

export function linuxStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  } catch { return undefined }
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
    let alive = true
    try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') alive = false }
    if (alive && process.platform === 'linux' && startTime !== undefined) {
      if (linuxStartTime(pid) !== startTime) alive = false
      else {
        try {
          const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
          if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) alive = false
        } catch { alive = false }
      }
    }
    if (!alive) {
      clearInterval(poll)
      const errors = onParentDeath({ tag, registry })
      if (errors.length) process.stderr.write(`orphan reaper: cleanup errors: ${errors.map((error) => `${error.step ?? error.pid}: ${error.code}`).join(', ')}\n`)
      process.exit(0)
    }
  }, 500)
}
