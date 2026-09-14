#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { aggregateRunCosts, appendCostReport, computeRunCost, formatAggregate } from './lib/run-cost-core.mjs'

const usage = 'Usage: node wt-run-cost.mjs <archives-directory> [--include-partial]\n       node wt-run-cost.mjs --compute <lane-directory> --output <cost.json> --worktree <directory> [--started-at <ISO>] [--ended-at <ISO>] [--db <opencode.db>] [--route LITE|FULL|HARD]'

function parse(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { help: true }
  if (argv[0] !== '--compute') {
    if (!argv[0] || argv.some((arg, index) => index > 0 && arg !== '--include-partial')) return { error: usage }
    return { archives: path.resolve(argv[0]), includePartial: argv.includes('--include-partial') }
  }
  const options = { laneDir: argv[1], output: null, worktree: null, dbPath: null, route: null, startedAt: null, endedAt: null }
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--output') options.output = argv[++index]
    else if (key === '--worktree') options.worktree = argv[++index]
    else if (key === '--db') options.dbPath = argv[++index]
    else if (key === '--route') options.route = argv[++index]
    else if (key === '--started-at') options.startedAt = Date.parse(argv[++index])
    else if (key === '--ended-at') options.endedAt = Date.parse(argv[++index])
    else return { error: usage }
  }
  if (!options.laneDir || !options.output || !options.worktree) return { error: usage }
  return options
}

try {
  const options = parse(process.argv.slice(2))
  if (options.help) process.stdout.write(`${usage}\n`)
  else if (options.error) { process.stderr.write(`${options.error}\n`); process.exitCode = 2 }
  else if (options.archives) process.stdout.write(formatAggregate(aggregateRunCosts(options.archives, options)))
  else {
    const cost = computeRunCost(options)
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true })
    fs.writeFileSync(options.output, `${JSON.stringify(cost, null, 2)}\n`)
    const report = path.join(options.laneDir, 'pilot-report.md')
    if (fs.existsSync(report)) fs.writeFileSync(path.join(path.dirname(path.resolve(options.output)), 'pilot-report.md'), appendCostReport(fs.readFileSync(report, 'utf8'), cost))
    process.stdout.write(`${JSON.stringify({ output: path.resolve(options.output), route: cost.route, outcome: cost.outcome, unknown: cost.unknown.length })}\n`)
  }
} catch (error) {
  process.stderr.write(`wt-run-cost: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
}
