#!/usr/bin/env node
// wt-command-repeat-check.mjs — record one executed command/result pair and flag
// only when the SAME normalized command shape produced the SAME result for the
// third time in one session. Not registered as a hook here; this is a standalone
// CLI so the project can verify the behavior before deciding where to arm it.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path, { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  DEFAULT_MAX_CLASS_SHAPES,
  DEFAULT_MAX_PAIRS,
  DEFAULT_THRESHOLD,
  DEFAULT_TTL_MS,
  normalizeCommandShape,
  observeCommandRepeat,
  pruneState,
} from './lib/command-repeat-core.mjs'

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

function nextValue(argv, index, flag) {
  if (index + 1 >= argv.length) fail(`${flag} requires a value`)
  return argv[index + 1]
}

function parseInteger(raw, flag) {
  const value = Number(raw)
  if (!Number.isFinite(value)) fail(`${flag} must be a finite number, got: ${raw}`)
  return value
}

function parseArgs(argv) {
  const out = {
    session: '',
    command: '',
    cwd: process.cwd(),
    exitCode: null,
    stdout: '',
    stderr: '',
    signal: '',
    at: Date.now(),
    json: false,
    stateDir: null,
    threshold: DEFAULT_THRESHOLD,
    classThreshold: DEFAULT_THRESHOLD,
    ttlMs: DEFAULT_TTL_MS,
    maxPairs: DEFAULT_MAX_PAIRS,
    maxClassShapes: DEFAULT_MAX_CLASS_SHAPES,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--session') out.session = nextValue(argv, i++, arg)
    else if (arg === '--command') out.command = nextValue(argv, i++, arg)
    else if (arg === '--cwd') out.cwd = nextValue(argv, i++, arg)
    else if (arg === '--exit-code') out.exitCode = parseInteger(nextValue(argv, i++, arg), arg)
    else if (arg === '--stdout') out.stdout = nextValue(argv, i++, arg)
    else if (arg === '--stderr') out.stderr = nextValue(argv, i++, arg)
    else if (arg === '--signal') out.signal = nextValue(argv, i++, arg)
    else if (arg === '--stdout-file') out.stdout = readFile(nextValue(argv, i++, arg), arg)
    else if (arg === '--stderr-file') out.stderr = readFile(nextValue(argv, i++, arg), arg)
    else if (arg === '--at') out.at = parseInteger(nextValue(argv, i++, arg), arg)
    else if (arg === '--state-dir') out.stateDir = nextValue(argv, i++, arg)
    else if (arg === '--threshold') out.threshold = parseInteger(nextValue(argv, i++, arg), arg)
    else if (arg === '--class-threshold') out.classThreshold = parseInteger(nextValue(argv, i++, arg), arg)
    else if (arg === '--ttl-ms') out.ttlMs = parseInteger(nextValue(argv, i++, arg), arg)
    else if (arg === '--max-pairs') out.maxPairs = parseInteger(nextValue(argv, i++, arg), arg)
    else if (arg === '--max-class-shapes') out.maxClassShapes = parseInteger(nextValue(argv, i++, arg), arg)
    else if (arg === '--json') out.json = true
    else fail(`unknown argument: ${arg}`)
  }

  if (!out.session.trim()) fail('--session is required')
  if (!out.command.trim()) fail('--command is required')
  if (out.exitCode === null) fail('--exit-code is required')
  return out
}

function readFile(filePath, flag) {
  try {
    return readFileSync(filePath, 'utf8')
  } catch (error) {
    fail(`${flag} cannot read ${filePath}: ${error.message}`)
  }
}

function stateRoot(explicitDir) {
  if (explicitDir) return explicitDir
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  return join(base, 'wt-command-repeat-check')
}

function safeSessionId(sessionId) {
  return String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '-')
}

function projectSlug(cwd) {
  const normalized = normalizeCommandShape({ cwd: path.resolve(String(cwd || '.')) }).normalizedCwd
  return normalized.replace(/[^A-Za-z0-9-]/g, '-')
}

function statePath(root, sessionId, cwd) {
  // Key by session AND project. A bare session id is enough for one run, but if
  // two repos ever share that id, the third identical result in repo A must not
  // suppress or arm repo B.
  return join(root, `${projectSlug(cwd)}--${safeSessionId(sessionId)}.json`)
}

function readState(filePath) {
  try {
    return pruneState(JSON.parse(readFileSync(filePath, 'utf8')))
  } catch {
    return pruneState({})
  }
}

function writeStateAtomic(filePath, state) {
  const dir = dirname(filePath)
  const tmpPath = join(dir, `.tmp-${process.pid}-${randomUUID()}.json`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(tmpPath, JSON.stringify(state), 'utf8')
  renameSync(tmpPath, filePath)
}

function printReport(report, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  if (report.degraded) {
    process.stdout.write(
      `[workflow-toolbox command-repeat] silent (${report.degraded}); ` +
        `shapeCount=${report.count}, classCount=${report.classCount}, ` +
        `shape=${report.shapeHash.slice(0, 12)}, class=${report.classKey.slice(0, 12)}\n`,
    )
    return
  }
  const verdict = report.flagged ? 'FLAGGED' : 'silent'
  process.stdout.write(
    `[workflow-toolbox command-repeat] ${verdict}: axis=${report.flaggedAxis || 'none'}, ` +
      `shapeCount=${report.count}, classCount=${report.classCount}, ` +
      `shape=${report.shapeHash.slice(0, 12)}, class=${report.classKey.slice(0, 12)}, ` +
      `result=${report.resultFingerprint.slice(0, 12)}, verdict=${report.verdictBucket}\n`,
  )
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = stateRoot(args.stateDir)
  const filePath = statePath(root, args.session, args.cwd)
  const priorState = readState(filePath)
  const observed = observeCommandRepeat({
    state: priorState,
    command: args.command,
    cwd: args.cwd,
    exitCode: args.exitCode,
    stdout: args.stdout,
    stderr: args.stderr,
    signal: args.signal,
    nowMs: args.at,
    threshold: args.threshold,
    classThreshold: args.classThreshold,
    maxClassShapes: args.maxClassShapes,
    ttlMs: args.ttlMs,
    maxPairs: args.maxPairs,
  })

  let degraded = ''
  try {
    writeStateAtomic(filePath, observed.state)
  } catch {
    degraded = 'state-unwritable-fail-open'
  }

  const report = {
    session: args.session,
    statePath: filePath,
    shapeHash: observed.shapeHash,
    classSignature: observed.classSignature,
    classKey: observed.classKey,
    verdictBucket: observed.verdictBucket,
    resultFingerprint: observed.resultFingerprint,
    normalizedCommand: observed.normalizedCommand,
    normalizedCwd: observed.normalizedCwd,
    count: observed.count,
    classCount: observed.classCount,
    shapeFlagged: degraded ? false : observed.shapeFlagged,
    shapeNewlyFlagged: degraded ? false : observed.shapeNewlyFlagged,
    classFlagged: degraded ? false : observed.classFlagged,
    classNewlyFlagged: degraded ? false : observed.classNewlyFlagged,
    flagged: degraded ? false : observed.flagged,
    newlyFlagged: degraded ? false : observed.newlyFlagged,
    flaggedAxis: degraded ? null : observed.flaggedAxis,
    degraded,
  }

  printReport(report, args.json)
  if (degraded) process.exit(0)
  process.exit(report.flagged ? 1 : 0)
}

main()
