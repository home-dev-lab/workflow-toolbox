#!/usr/bin/env node
// wt-lane-wait.mjs -- wait for one detached external lane without reading its log body.

import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { classifyLane, laneHostPlatform, readCurrentSupervisions } from './lib/lane-supervisor-core.mjs'

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

function lastLine(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const size = statSync(file).size
    if (size === 0) return null
    const byte = Buffer.alloc(1)
    const chars = []
    let position = size - 1
    while (position >= 0) {
      readSync(fd, byte, 0, 1, position)
      position -= 1
      if (byte[0] === 10) {
        if (chars.length === 0) continue
        break
      }
      if (byte[0] !== 13) chars.push(String.fromCharCode(byte[0]))
    }
    return chars.reverse().join('') || null
  } catch { return null }
  finally { if (fd !== undefined) closeSync(fd) }
}

function reportSize(file) {
  try { return `${statSync(file).size}` } catch { return 'none' }
}

function terminalRecord(record) {
  return ['launch-failed', 'exited', 'abandoned'].includes(record?.state)
}

function publishedExit(marker) {
  const match = /^EXIT=(-?\d+)$/.exec(marker ?? '')
  return match ? Number(match[1]) : null
}

function printDone(exit, record, lane, log) {
  const cause = laneHostPlatform === 'win32' && exit === 137
    ? ' cause=unavailable-on-this-platform signal=unavailable'
    : record?.killedBy ? ` cause=${record.killedBy.cause} signal=${record.killedBy.signal}` : ''
  process.stdout.write(`LANE DONE exit=${exit}${cause} report=${reportSize(path.join(lane, 'report.md'))} log=${log}\n`)
  return exit
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
  const pid = opts.pid === null ? pidFromFile(path.join(lane, 'pid')) : Number(opts.pid)
  if (!pid) { process.stderr.write('wt-lane-wait: no valid lane pid; pass --pid or provide .lane/pid\n'); return 2 }
  const log = path.join(lane, 'run.log')
  const deadline = Date.now() + opts.timeout * 1000
  while (true) {
    const record = readCurrentSupervisions(opts.dir).map((item) => item.record).find((item) => item.workerPid === pid) ?? null
    if (terminalRecord(record)) {
      const exit = publishedExit(lastLine(log))
      if (exit !== null) return printDone(exit, record, lane, log)
      if (Date.now() >= deadline) {
        process.stdout.write('LANE DIED exit=unknown\n')
        return 1
      }
    } else {
      const verdict = classifyLane(record)
      if (verdict.status === 'gone') {
        const exit = publishedExit(lastLine(log))
        if (exit !== null) return printDone(exit, record, lane, log)
        process.stdout.write('LANE DIED exit=unknown\n')
        return 1
      }
      if (Date.now() >= deadline) break
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(opts.poll * 1000, Math.max(1, deadline - Date.now())))
  }
  process.stdout.write('LANE TIMEOUT exit=124\n')
  return 124
}

process.exitCode = main()
