#!/usr/bin/env node
import path from 'node:path'
import { appendSupervisorJournal, classifyLane, readCurrentSupervision, supervisionPaths, terminateLane, writeJsonAtomic } from './lib/lane-supervisor-core.mjs'
import { resolvePluginDataDir } from './lib/plugin-data-dir.mjs'

function usage() {
  return 'Usage: node wt-lane-control.mjs --dir <worktree> --decision extend|abandon [--extend <seconds>] [--owner-token <token>] [--reason <text>]'
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
  if (!out.dir || !['extend', 'abandon'].includes(out.decision)) return { error: 'required --dir and --decision extend|abandon' }
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
  if (!['session', 'pilot'].includes(state.owner)) { process.stderr.write('wt-lane-control: refused: lane owner is unknown\n'); return 1 }
  const ownsLane = state.owner === 'session'
    ? Boolean(state.ownerSessionId && process.env.CLAUDE_CODE_SESSION_ID === state.ownerSessionId)
    : Boolean(state.ownerToken && options.ownerToken === state.ownerToken)
  if (!ownsLane) { process.stderr.write('wt-lane-control: refused: caller is not the recorded owner\n'); return 1 }
  const verdict = classifyLane(state)
  if (!['decision-needed', 'worker-gone-child-alive'].includes(verdict.status) || (verdict.status === 'decision-needed' && !state.timeoutAt)) { process.stderr.write(`wt-lane-control: refused: no current decision point (${verdict.status})\n`); return 1 }
  if (options.decision === 'abandon') {
    const stateFile = supervisionPaths(options.dir, state.runId).record
    const abandoned = { ...state, state: 'abandoned', decision: 'abandon', decisionSource: 'owner', decidedAt: new Date().toISOString() }
    const dataDir = path.join(resolvePluginDataDir({ env: process.env }).dir, 'lane-supervisor')
    const journal = (event) => { try { appendSupervisorJournal(dataDir, event) } catch {} }
    journal({ event: 'decision', runId: state.runId, decision: 'abandon', source: 'owner', pid: state.childPid, worktree: state.worktree, owner: state.owner, reason: options.reason ?? null })
    const result = terminateLane(state, { source: 'control', journal, recordWorktree: options.dir, markTerminal: (stage) => writeJsonAtomic(stateFile, stage === 'terminal' ? abandoned : { ...state, state: 'terminating', decision: 'abandon', decisionSource: 'owner', decidedAt: abandoned.decidedAt }) })
    if (!result.killed && result.reason !== 'already-gone') { process.stderr.write(`wt-lane-control: refused: ${result.reason}\n`); return 1 }
    process.stdout.write(`decision=abandon\nrun=${state.runId}\n`)
    return 0
  }
  if (verdict.status !== 'decision-needed') { process.stderr.write('wt-lane-control: refused: launcher is gone; only abandon is available\n'); return 1 }
  writeJsonAtomic(supervisionPaths(options.dir, state.runId).decision, { version: 1, runId: state.runId, timeoutAt: state.timeoutAt, decision: options.decision, extendSeconds: options.extendSeconds, reason: options.reason, decidedAt: new Date().toISOString() })
  process.stdout.write(`decision=${options.decision}\nrun=${state.runId}\n`)
  return 0
}

process.exitCode = main()
