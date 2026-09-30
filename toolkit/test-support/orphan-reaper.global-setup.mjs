import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reapTagged, RUN_TAG_ENV } from './orphan-reaper.mjs'

export function launchWatchdog(tag, registry, { spawn: launch = spawn, report = (line) => process.stderr.write(line) } = {}) {
  const env = { ...process.env }
  delete env[RUN_TAG_ENV]
  const watchdog = launch(process.execPath, [fileURLToPath(new URL('./orphan-reaper.mjs', import.meta.url)), '--watch', String(process.pid), '--tag', tag, '--registry', registry], {
    detached: true,
    cwd: tmpdir(),
    stdio: 'ignore',
    windowsHide: true,
    env,
  })
  watchdog.on('error', (error) => report(`orphan reaper: watchdog failed to start: ${error.message}; killed runs will not be reaped\n`))
  watchdog.unref()
  return watchdog
}

export default function setup(project) {
  if (process.env.WT_TEST_ORPHAN_REAPER === '0') return
  const tag = randomUUID()
  const registry = mkdtempSync(join(tmpdir(), 'wt-test-workers-'))
  project.provide('wtTestRunTag', tag)
  project.provide('wtTestWorkerRegistry', registry)
  const watchdog = process.env.WT_TEST_ORPHAN_REAPER_WATCHDOG === '0' ? undefined : launchWatchdog(tag, registry)
  return () => {
    const { supported, killed, errors, reason } = reapTagged(tag, { exclude: watchdog?.pid ? [watchdog.pid] : [] })
    if (!supported) process.stderr.write(`orphan reaper: ${reason}; test orphans are not reaped\n`)
    if (killed.length) process.stderr.write(`orphan reaper: killed ${killed.length} test orphans (pids: ${killed.join(', ')})\n`)
    if (errors.length) process.stderr.write(`orphan reaper: cleanup errors: ${errors.map(({ pid, code }) => `${pid}: ${code}`).join(', ')}\n`)
  }
}
