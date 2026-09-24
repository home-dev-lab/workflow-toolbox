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

function readAt(fd, buffer, length, position) {
  return readSync(fd, buffer, 0, length, position)
}

function logReceipt(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const size = statSync(file).size
    if (size === 0) return { runId: null, marker: null }
    const prefix = Buffer.alloc(Math.min(size, 2048))
    readAt(fd, prefix, prefix.length, 0)
    const runId = /(?:^|\n)LANE_RUN_ID=([^\r\n]+)(?:\r?\n|$)/.exec(prefix.toString('utf8'))?.[1] ?? null
    const byte = Buffer.alloc(1)
    const chars = []
    let position = size - 1
    while (position >= 0) {
      readAt(fd, byte, 1, position)
      position -= 1
      if (byte[0] === 10) {
        if (chars.length === 0) continue
        break
      }
      if (byte[0] !== 13) chars.push(String.fromCharCode(byte[0]))
    }
    return { runId, marker: chars.reverse().join('') || null }
  } catch { return { runId: null, marker: null } }
  finally { if (fd !== undefined) closeSync(fd) }
}

function reportSize(file) {
  try { return `${statSync(file).size}` } catch { return 'none' }
}

function publicationPending(record) {
  return ['terminating', 'launch-failed', 'exited', 'abandoned'].includes(record?.state)
}

function publishedExit(file, record) {
  const receipt = logReceipt(file)
  if (!record?.runId || receipt.runId !== record.runId) return null
  const marker = receipt.marker
  const match = /^EXIT=(-?\d+)$/.exec(marker ?? '')
  if (!match) return null
  const value = BigInt(match[1])
  if (Number.isInteger(record.exit) && value !== BigInt(record.exit)) return null
  return { text: match[1], status: value >= 0n && value <= 255n ? Number(value) : 1 }
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
  const pid = opts.pid === null ? pidFromFile(path.join(lane, 'pid')) : Number(opts.pid)
  if (!pid) { process.stderr.write('wt-lane-wait: no valid lane pid; pass --pid or provide .lane/pid\n'); return 2 }
  const log = path.join(lane, 'run.log')
  const deadline = Date.now() + opts.timeout * 1000
  const launchRunId = logReceipt(log).runId
  let seenRecord = launchRunId ? { runId: launchRunId } : null
  while (true) {
    const currentRecord = readCurrentSupervisions(opts.dir).map((item) => item.record).find((item) => item.workerPid === pid) ?? null
    if (currentRecord) seenRecord = currentRecord
    const record = currentRecord ?? seenRecord
    if (publicationPending(record) || (!currentRecord && seenRecord)) {
      const exit = publishedExit(log, record)
      if (exit !== null) return printDone(exit, record, lane, log)
      if (Date.now() >= deadline) {
        process.stdout.write('LANE DIED exit=unknown\n')
        return 1
      }
    } else {
      const verdict = classifyLane(record)
      if (verdict.status === 'gone') {
        const exit = publishedExit(log, record)
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
