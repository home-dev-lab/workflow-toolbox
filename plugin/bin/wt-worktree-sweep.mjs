#!/usr/bin/env node
import { isInvokedDirectly } from './lib/host/entry-guard.mjs'
import { resolveSweepProject } from './lib/worktree-sweep/git.mjs'
import { scanProject } from './lib/worktree-sweep/scan.mjs'
import { reportMode, summaryLine, writeReport } from './lib/worktree-sweep/report.mjs'

const HELP = 'Usage: wt-worktree-sweep run [--mode report|auto] [--project <dir>] [--out <new-file>]\nReport only. apply, purge and restore are unavailable.\n'

function argumentsFor(argv) {
  const args = [...argv]
  const result = { verb: args[0]?.startsWith('-') ? 'run' : args.shift() ?? 'run' }
  while (args.length) {
    const flag = args.shift()
    if (!['--mode', '--project', '--out'].includes(flag) || !args.length || args[0].startsWith('--')) throw new Error(HELP.trim())
    result[flag.slice(2)] = args.shift()
  }
  return result
}

function observationClock(env) {
  const now = env.WT_SWEEP_NOW === undefined ? Date.now() : Number(env.WT_SWEEP_NOW)
  if (!Number.isSafeInteger(now)) throw new Error('worktree sweep: invalid observation clock')
  return now
}

export function sweepMain(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP); return }
  const options = argumentsFor(argv)
  reportMode(options.mode, env)
  if (options.verb !== 'run') throw new Error(`worktree sweep: ${options.verb} is not available in this report-only version`)
  const report = scanProject({ project: resolveSweepProject(options.project, env), env, now: observationClock(env) })
  if (options.out) writeReport(options.out, report)
  process.stdout.write(`${summaryLine(report)}\n`)
  for (const entry of report.entries) process.stdout.write(`${entry.path}: ${entry.verdict} (${entry.reason})\n`)
}

if (isInvokedDirectly(import.meta.url)) {
  try { sweepMain() } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
