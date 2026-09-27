#!/usr/bin/env node
// wt-lane-wait.mjs -- wait for one detached external lane without reading its log body.

import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { classifyLane, laneHostPlatform, readCurrentSupervisions } from './lib/lane-supervisor-core.mjs'
import { laneHostDir } from './lib/host/lane-host-dir.mjs'
import { legacySupervision } from './lib/lane-supervisor-core.mjs'

const DEFAULT_POLL = 30
const DEFAULT_TIMEOUT = 5400

function usage() {
  return 'Usage: node wt-lane-wait.mjs --dir <worktree> [--pid <n>] [--poll 30] [--timeout <s>]'
}

function parse(argv) {
  const out = { dir: null, pid: null, poll: DEFAULT_POLL, timeout: DEFAULT_TIMEOUT }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dir') out.dir = argv[++i] ?? null
    else if (arg === '--pid') out.pid = argv[++i] ?? null
    else if (arg === '--poll') out.poll = Number(argv[++i])
    else if (arg === '--timeout') out.timeout = Number(argv[++i])
    else if (arg === '--help' || arg === '-h') return { help: true }
    else return { error: `unknown argument: ${arg}` }
  }
  if (!out.dir) return { error: 'missing required --dir' }
  if (!Number.isFinite(out.poll) || out.poll <= 0) return { error: '--poll must be a positive number of seconds' }
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) return { error: '--timeout must be a positive number of seconds' }
  if (out.pid !== null && (!/^\d+$/.test(out.pid) || Number(out.pid) <= 0)) return { error: '--pid must be a positive process id' }
  // Keep the waiter and the recorded lane identity on the same spelling when TMPDIR
  // traverses a macOS /private symlink.
  try { out.dir = realpathSync(out.dir) } catch { out.dir = path.resolve(out.dir) }
  return out
}

function pidFromFile(file) {
  try {
    const value = readFileSync(file, 'utf8').trim()
    return /^\d+$/.test(value) ? Number(value) : null
  } catch { return null }
}

function reportSize(file) {
  try { return `${statSync(file).size}` } catch { return 'none' }
}

function publicationPending(record) {
  return ['terminating', 'launch-failed', 'exited', 'abandoned'].includes(record?.state)
}

function printDone(exit, record, lane, log) {
  const cause = laneHostPlatform === 'win32' && exit.text === '137'
    ? ' cause=unavailable-on-this-platform signal=unavailable'
    : record?.killedBy ? ` cause=${record.killedBy.cause} signal=${record.killedBy.signal}` : ''
  process.stdout.write(`LANE DONE exit=${exit.text}${cause} report=${reportSize(path.join(lane, 'report.md'))} log=${log}\n`)
  return exit.status
}

function main() {
  const opts = parse(process.argv.slice(2))
  if (opts.help) { process.stdout.write(`${usage()}\n`); return 0 }
  if (opts.error) { process.stderr.write(`wt-lane-wait: ${opts.error}\n${usage()}\n`); return 2 }
  if (typeof classifyLane !== 'function' || typeof readCurrentSupervisions !== 'function') {
    process.stderr.write('wt-lane-wait: Refused: the installed workflow-toolbox plugin is too old for this adopted waiter; update the plugin and re-adopt wt-lane-wait.mjs.\n')
    return 1
  }
  const lane = path.join(opts.dir, '.lane')
  const hostDir = laneHostDir(opts.dir)
  if (readCurrentSupervisions(opts.dir).length === 0 && legacySupervision(opts.dir).length) {
    process.stderr.write(`wt-lane-wait: legacy lane supervision in ${opts.dir} ignored (written by a pre-upgrade launcher; it lives in lane-writable space)\n`)
    return 2
  }
  const pid = opts.pid === null ? pidFromFile(path.join(hostDir, 'pid')) : Number(opts.pid)
  if (!pid) {
    process.stderr.write('wt-lane-wait: no valid lane pid; pass --pid or launch a lane\n')
    return 2
  }
  const log = path.join(hostDir, 'run.log')
  const deadline = Date.now() + opts.timeout * 1000
  let seenRecord = null
  while (true) {
    const currentRecord = readCurrentSupervisions(opts.dir).map((item) => item.record).find((item) => item.workerPid === pid) ?? null
    if (currentRecord) seenRecord = currentRecord
    const record = currentRecord ?? seenRecord
    if (['exited', 'abandoned', 'launch-failed'].includes(record?.state) && Number.isInteger(record.exit)) {
      const value = record.exit
      return printDone({ text: String(value), status: value >= 0 && value <= 255 ? value : 1 }, record, lane, record.log ?? log)
    }
    if (['exited', 'abandoned', 'launch-failed'].includes(record?.state) && record.exit !== undefined) {
      process.stdout.write('LANE DIED exit=unknown\n')
      return 1
    }
    if (publicationPending(record) || (!currentRecord && seenRecord)) {
      if (Date.now() >= deadline) {
        process.stdout.write('LANE DIED exit=unknown\n')
        return 1
      }
    } else {
      const verdict = classifyLane(record)
      if (verdict.status === 'gone') {
        process.stdout.write('LANE DIED exit=unknown\n')
        return 1
      }
      if (Date.now() >= deadline) {
        if (!record) { process.stdout.write('LANE DIED exit=unknown\n'); return 1 }
        break
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(opts.poll * 1000, Math.max(1, deadline - Date.now())))
  }
  process.stdout.write('LANE TIMEOUT exit=124\n')
  return 124
}

process.exitCode = main()
