#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { inspectProcess, sameIdentity } from './lib/lane-supervisor-core.mjs'

function usage() {
  return 'Usage: node wt-lane-control.mjs --dir <worktree> --decision extend|relaunch|abandon [--extend <seconds>] [--reason <text>]'
}

function parse(argv) {
  const out = { dir: null, decision: null, extendSeconds: null, reason: null }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') out.dir = argv[++i] ?? null
    else if (argv[i] === '--decision') out.decision = argv[++i] ?? null
    else if (argv[i] === '--extend') out.extendSeconds = Number(argv[++i])
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
  const stateFile = path.join(options.dir, '.lane', 'supervision.json')
  if (!existsSync(stateFile)) { process.stderr.write(`wt-lane-control: no supervised lane at ${options.dir}\n`); return 1 }
  let state
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')) } catch { process.stderr.write('wt-lane-control: supervision record is unreadable\n'); return 1 }
  if (!['session', 'pilot'].includes(state.owner)) { process.stderr.write('wt-lane-control: refused: lane owner is unknown\n'); return 1 }
  const worker = inspectProcess(state.workerPid)
  if (!sameIdentity({ pid: state.workerPid, argv: state.workerArgv }, worker)) { process.stderr.write('wt-lane-control: refused: launcher identity changed or is gone\n'); return 1 }
  const child = inspectProcess(state.childPid)
  if (!sameIdentity({ pid: state.childPid, argv: state.childArgv, cwd: state.worktree }, child)) { process.stderr.write('wt-lane-control: refused: lane identity changed or is gone\n'); return 1 }
  writeFileSync(path.join(options.dir, '.lane', 'decision.json'), `${JSON.stringify({ version: 1, runId: state.runId, decision: options.decision, extendSeconds: options.extendSeconds, reason: options.reason, decidedAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(`decision=${options.decision}\nrun=${state.runId}\n`)
  return 0
}

process.exitCode = main()
