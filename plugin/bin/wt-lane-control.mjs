#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { inspectProcess, readCurrentSupervision, sameIdentity, supervisionPaths, writeJsonAtomic } from './lib/lane-supervisor-core.mjs'

function usage() {
  return 'Usage: node wt-lane-control.mjs --dir <worktree> --decision extend|relaunch|abandon [--extend <seconds>] [--owner-token <token>] [--reason <text>]'
}

function parse(argv) {
  const out = { dir: null, decision: null, extendSeconds: null, ownerToken: null, reason: null }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') out.dir = argv[++i] ?? null
    else if (argv[i] === '--decision') out.decision = argv[++i] ?? null
    else if (argv[i] === '--extend') out.extendSeconds = Number(argv[++i])
    else if (argv[i] === '--owner-token') out.ownerToken = argv[++i] ?? null
    else if (argv[i] === '--reason') out.reason = argv[++i] ?? null
    else if (argv[i] === '--help' || argv[i] === '-h') return { help: true }
    else return { error: `unknown argument: ${argv[i]}` }
  }
  if (!out.dir || !['extend', 'relaunch', 'abandon'].includes(out.decision)) return { error: 'required --dir and --decision extend|relaunch|abandon' }
  if (out.extendSeconds !== null && (!Number.isFinite(out.extendSeconds) || out.extendSeconds <= 0)) return { error: '--extend must be positive seconds' }
  out.dir = path.resolve(out.dir)
  return out
}

function main() {
  const options = parse(process.argv.slice(2))
  if (options.help) { process.stdout.write(`${usage()}\n`); return 0 }
  if (options.error) { process.stderr.write(`wt-lane-control: ${options.error}\n${usage()}\n`); return 2 }
  if (process.platform !== 'linux') { process.stderr.write(`wt-lane-control: refused: lane supervision control is unavailable on ${process.platform}\n`); return 1 }
  const state = readCurrentSupervision(options.dir)
  if (!state) { process.stderr.write(`wt-lane-control: no readable supervised lane at ${options.dir}\n`); return 1 }
  const stateFile = supervisionPaths(options.dir, state.runId).record
  if (!['session', 'pilot'].includes(state.owner)) { process.stderr.write('wt-lane-control: refused: lane owner is unknown\n'); return 1 }
  const ownsLane = state.owner === 'session'
    ? Boolean(state.ownerSessionId && process.env.CLAUDE_CODE_SESSION_ID === state.ownerSessionId)
    : Boolean(state.ownerToken && options.ownerToken === state.ownerToken)
  if (!ownsLane) { process.stderr.write('wt-lane-control: refused: caller is not the recorded owner\n'); return 1 }
  if (state.state !== 'decision-needed' || !state.timeoutAt) { process.stderr.write('wt-lane-control: refused: no current decision point\n'); return 1 }
  if (state.owner === 'pilot' && options.decision === 'relaunch') { process.stderr.write('wt-lane-control: refused: pilot-owned lanes do not offer relaunch because the completed lifecycle call cannot consume a replacement receipt; use extend or abandon\n'); return 1 }
  const worker = inspectProcess(state.workerPid)
  if (!sameIdentity({ pid: state.workerPid, argv: state.workerArgv }, worker)) { process.stderr.write('wt-lane-control: refused: launcher identity changed or is gone\n'); return 1 }
  const child = inspectProcess(state.childPid)
  if (!sameIdentity({ pid: state.childPid, argv: state.childArgv, cwd: state.worktree }, child)) { process.stderr.write('wt-lane-control: refused: lane identity changed or is gone\n'); return 1 }
  writeJsonAtomic(supervisionPaths(options.dir, state.runId).decision, { version: 1, runId: state.runId, timeoutAt: state.timeoutAt, decision: options.decision, extendSeconds: options.extendSeconds, reason: options.reason, decidedAt: new Date().toISOString() })
  process.stdout.write(`decision=${options.decision}\nrun=${state.runId}\n`)
  if (options.decision === 'relaunch') {
    let replacementRunId = null
    while (true) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
      try {
        const current = JSON.parse(readFileSync(stateFile, 'utf8'))
        if (current.runId !== state.runId) continue
        if (current.replacementRunId && current.relaunchDecisionAt === state.timeoutAt) replacementRunId = current.replacementRunId
        if (replacementRunId && current.replacementRunId === replacementRunId && current.relaunchDecisionAt === state.timeoutAt && current.relaunchOutcome === 'started') {
          process.stdout.write(`replacement=${replacementRunId}\n`)
          return 0
        }
        if (replacementRunId && current.replacementRunId === replacementRunId && current.relaunchDecisionAt === state.timeoutAt && current.relaunchOutcome === 'failed') {
          process.stderr.write(`wt-lane-control: relaunch-failed for replacement ${replacementRunId}: ${current.relaunchFailure ?? 'unknown reason'}; the old lane remains running and requires a new owner decision\n`)
          return 1
        }
      } catch {}
    }
  }
  return 0
}

process.exitCode = main()
