#!/usr/bin/env node
// One exclusive lease across all release gates, with admission and an on-disk receipt even on
// failure. The default load ceiling is the host's available parallelism (one-minute load avg).
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism, loadavg } from 'node:os'
import { join } from 'node:path'
import { acquireSuiteLock, releaseSuiteLock, spawnNeedsShell, suiteLeaseMarker } from '../../plugin/bin/lib/suite-lock.mjs'
import { signalCoveredCommand, stopChildForLostSuiteLock } from '../../plugin/bin/lib/host/suite-lock-host.mjs'

export function sampleLoad({ platform = process.platform, cores = availableParallelism, read = readFileSync, osLoad = loadavg } = {}) {
  let capacity = null
  try { const value = Number(cores()); if (Number.isSafeInteger(value) && value > 0) capacity = value } catch { /* unavailable */ }
  let load = null
  let source = 'unavailable'
  try {
    if (platform === 'linux') {
      const token = String(read('/proc/loadavg', 'utf8')).trim().split(/\s+/)[0]
      load = token ? Number(token) : null
      source = '/proc/loadavg'
    }
    else if (platform === 'darwin') { const value = osLoad()[0]; load = value === null || value === undefined ? null : Number(value); source = 'os.loadavg()' }
  } catch { /* unavailable */ }
  if ((platform !== 'linux' && platform !== 'darwin') || !Number.isFinite(load) || load < 0 || capacity === null) {
    return { at: new Date().toISOString(), load: null, capacity, source: 'unavailable' }
  }
  return { at: new Date().toISOString(), load, capacity, source }
}

export function runGate(name, root, lease, spawnGate = spawn) {
  return new Promise((resolve) => {
    const child = spawnGate('pnpm', [name], { cwd: root, stdio: 'inherit', shell: spawnNeedsShell('pnpm'), env: { ...process.env, WT_SUITE_LEASE: suiteLeaseMarker(lease) } })
    let spawnFailed = false
    let lost = false
    let cancelForcedStop
    let finished = false
    const forward = (signal) => signalCoveredCommand(child, signal)
    const interrupt = () => forward('SIGINT')
    const terminate = () => forward('SIGTERM')
    const finish = (code, signal) => {
      if (finished) return
      finished = true
      cancelForcedStop?.()
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
      resolve(lost ? 75 : spawnFailed ? 2 : code ?? (signal === 'SIGINT' ? 130 : 143))
    }
    lease.lost?.then((reason) => {
      if (finished) return
      lost = true
      process.stderr.write(`certification ${name}: broker lease lost (${reason || 'broker gone'}); stopping gate\n`)
      cancelForcedStop = stopChildForLostSuiteLock(child)
    })
    process.on('SIGINT', interrupt)
    process.on('SIGTERM', terminate)
    child.once('error', (error) => { spawnFailed = true; process.stderr.write(`certification ${name}: ${error.message}\n`); finish(null, null) })
    child.once('exit', finish)
  })
}

export async function certify({ override = false, gates = ['typecheck', 'lint', 'quality', 'test'], root = process.cwd(), lockRoot, probe = sampleLoad, executeGate = runGate } = {}) {
  const record = { startedAt: new Date().toISOString(), threshold: 'one-minute load average < availableParallelism', override, admission: 'pending', start: null, end: null, gates: [], exit: 75 }
  const dir = join(root, '..', '.lane', 'certifications')
  mkdirSync(dir, { recursive: true })
  const receipt = join(dir, `${Date.now()}-${process.pid}.json`)
  let lease
  try {
    lease = await acquireSuiteLock({ ...(lockRoot ? { root: lockRoot } : {}), argv: ['pnpm', 'certify'], onWait: (line) => process.stderr.write(`${line}\n`) })
    record.start = probe()
    if (!override && record.start.load !== null && record.start.load >= record.start.capacity) {
      record.admission = `refused: load ${record.start.load} >= capacity ${record.start.capacity}; use pnpm certify -- --allow-high-load to override`
      process.stderr.write(`${record.admission}\n`)
      return 75
    }
    record.admission = record.start.source === 'unavailable' ? 'admitted: load unavailable' : override ? 'admitted: explicit load override' : 'admitted: below threshold'
    process.stderr.write(`certification: ${record.admission}; load=${record.start.load ?? 'unavailable'}, capacity=${record.start.capacity ?? 'unavailable'}; receipt=${receipt}\n`)
    for (const gate of gates) {
      const exit = await executeGate(gate, root, lease)
      record.gates.push({ name: gate, exit, finishedAt: new Date().toISOString() })
      if (exit !== 0) return exit
    }
    return 0
  } catch (error) {
    record.admission = `failed: ${error.message}`
    process.stderr.write(`certification: ${record.admission}\n`)
    return 75
  } finally {
    record.end = probe()
    record.exit = record.gates.find((gate) => gate.exit !== 0)?.exit ?? (record.admission.startsWith('admitted') && record.gates.length === gates.length ? 0 : 75)
    try {
      writeFileSync(receipt, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    } finally {
      if (lease) releaseSuiteLock(lease)
    }
    process.stderr.write(`certification: receipt=${receipt} exit=${record.exit}\n`)
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg !== '--allow-high-load')) throw new Error('usage: pnpm certify [-- --allow-high-load]')
  process.exitCode = await certify({ override: args.includes('--allow-high-load') })
}
