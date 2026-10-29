#!/usr/bin/env node
// wt-lane-wait.mjs -- wait for one detached external lane without reading its log body.

import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { classifyLane, laneHostPlatform, readCurrentSupervisions } from './lib/lane-supervisor-core.mjs'
import { laneHostDir } from './lib/host/lane-host-dir.mjs'
import { legacySupervision } from './lib/lane-supervisor-core.mjs'

const DEFAULT_POLL = 30
const DEFAULT_TIMEOUT = 5400
const TERMINAL_PUBLICATION_MS = 1_000
const WAIT_BUDGET_EXIT = 125
const ABANDONMENT_CAUSES = new Map([
  ['grace-default', 'timeout'], ['extension-ceiling', 'timeout'],
  ['idle', 'idle'], ['owner', 'owner'], ['grace-error', 'grace-error'],
])

function usage() {
  return [
    'Usage: node wt-lane-wait.mjs --dir <worktree> [--pid <n>] [--poll 30] [--timeout <s>]',
    '--timeout bounds this waiter only; it does not stop the lane.',
    'Exit codes: lane exit for LANE DONE; 1 unknown exit/refusal; 2 invalid arguments or supervision;',
    '125 WAIT BUDGET ENDED (lane still running or liveness unknown). Read the outcome, since lane exits can also be 125.',
    'A lane exit of 124 is LANE DONE, not evidence of a timeout. Abandonment is LANE DONE exit=126 cause=timeout|idle|owner|grace-error, from decisionSource.',
    'Non-running budget outcomes include state; decision-needed also includes timeoutAt and decisionDueAt.',
  ].join('\n')
}

function parseArguments(argv) {
  const out = { dir: null, pid: null, poll: DEFAULT_POLL, timeout: DEFAULT_TIMEOUT }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--dir': out.dir = argv[++i] ?? null; break
      case '--pid': out.pid = argv[++i] ?? null; break
      case '--poll': out.poll = Number(argv[++i]); break
      case '--timeout': out.timeout = Number(argv[++i]); break
      case '--help': case '-h': return { help: true }
      default: return { error: `unknown argument: ${arg}` }
    }
  }
  return out
}

function argumentError(out) {
  if (!out.dir) return 'missing required --dir'
  if (!Number.isFinite(out.poll) || out.poll <= 0) return '--poll must be a positive number of seconds'
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) return '--timeout must be a positive number of seconds'
  if (out.pid !== null && (!/^\d+$/.test(out.pid) || Number(out.pid) <= 0)) return '--pid must be a positive process id'
  return null
}

function parse(argv) {
  const out = parseArguments(argv)
  if (out.help || out.error) return out
  const error = argumentError(out)
  if (error) return { error }
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

function currentRecordFor(dir, pid) {
  return readCurrentSupervisions(dir).map((item) => item.record).find((item) => item.workerPid === pid) ?? null
}

function awaitingPublication(record, currentRecord, seenRecord) {
  return publicationPending(record) || (!currentRecord && seenRecord)
}

function abandonmentCause(source) {
  const cause = ABANDONMENT_CAUSES.get(source)
  return cause ? ` cause=${cause}` : ''
}

function terminalCause(exit, record) {
  if (record?.state === 'abandoned') return abandonmentCause(record.decisionSource)
  const cause = laneHostPlatform === 'win32' && exit.text === '137'
    ? ' cause=unavailable-on-this-platform signal=unavailable'
    : record?.killedBy ? ` cause=${record.killedBy.cause} signal=${record.killedBy.signal}` : ''
  return cause
}

function printDone(exit, record, lane, log) {
  const cause = terminalCause(exit, record)
  process.stdout.write(`LANE DONE exit=${exit.text}${cause} report=${reportSize(path.join(lane, 'report.md'))} log=${log}\n`)
  return exit.status
}

function terminalResult(record, lane, log) {
  if (['exited', 'abandoned', 'launch-failed'].includes(record?.state) && Number.isInteger(record.exit)) {
    const value = record.exit
    return printDone({ text: String(value), status: value >= 0 && value <= 255 ? value : 1 }, record, lane, record.log ?? log)
  }
  if (['exited', 'abandoned', 'launch-failed'].includes(record?.state) && record.exit !== undefined) {
    process.stdout.write('LANE DIED exit=unknown\n')
    return 1
  }
  return null
}

function budgetState(record) {
  if (!record || record.state === 'running') return ''
  const state = ` state=${record.state}`
  return record.state === 'decision-needed'
    ? `${state} timeoutAt=${record.timeoutAt ?? 'unknown'} decisionDueAt=${record.decisionDueAt ?? 'unknown'}`
    : state
}

function budgetEnded(pid, record, verdict) {
  let evidence = `liveness unknown (${verdict.reason ?? 'process evidence unavailable'})`
  if (verdict.worker === 'running') evidence = 'still running'
  else if (verdict.worker === 'gone' && verdict.child === 'running') {
    evidence = `gone; child pid ${record.childPid} still running`
  }
  process.stdout.write(`WAIT BUDGET ENDED: lane pid ${pid} ${evidence}${budgetState(record)}\n`)
  return WAIT_BUDGET_EXIT
}

function publicationBudgetEnded(record, currentRecord, pid) {
  if (currentRecord) {
    const verdict = classifyLane(record)
    const gone = verdict.worker === 'gone' && verdict.child === 'gone'
    if (!gone && verdict.status !== 'gone') return budgetEnded(pid, record, verdict)
  }
  process.stdout.write('LANE DIED exit=unknown\n')
  return 1
}

function inspectProgress(record, deadline, progress, pid) {
  const verdict = classifyLane(record)
  if (verdict.status === 'gone') {
    // Only a host record can supply the exit. Allow its detached publisher a bounded window.
    progress.goneSince ??= Date.now()
    if (!record || Date.now() >= Math.min(deadline, progress.goneSince + TERMINAL_PUBLICATION_MS)) {
      process.stdout.write('LANE DIED exit=unknown\n')
      return 1
    }
  } else progress.goneSince = null
  if (Date.now() >= deadline) {
    if (!record) { process.stdout.write('LANE DIED exit=unknown\n'); return 1 }
    return budgetEnded(pid, record, verdict)
  }
  return null
}

function waitForLane(opts, lane, pid, log) {
  const deadline = Date.now() + opts.timeout * 1000
  let seenRecord = null
  const progress = { goneSince: null }
  while (true) {
    const currentRecord = currentRecordFor(opts.dir, pid)
    if (currentRecord) seenRecord = currentRecord
    const record = currentRecord ?? seenRecord
    const terminal = terminalResult(record, lane, log)
    if (terminal !== null) return terminal
    if (awaitingPublication(record, currentRecord, seenRecord)) {
      if (Date.now() >= deadline) {
        return publicationBudgetEnded(record, currentRecord, pid)
      }
    } else {
      const result = inspectProgress(record, deadline, progress, pid)
      if (result !== null) return result
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(opts.poll * 1000, Math.max(1, deadline - Date.now())))
  }
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
  return waitForLane(opts, lane, pid, log)
}

process.exitCode = main()
