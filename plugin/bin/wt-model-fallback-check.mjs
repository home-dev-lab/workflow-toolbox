#!/usr/bin/env node
import path from 'node:path'
import { analyseSession, analyseTranscript, modelWarnings } from './lib/model-fallback-core.mjs'
import { entries } from './lib/host/model-fallback-files.mjs'

const usage = 'Usage: node wt-model-fallback-check.mjs (--session <file> | --transcript <file> [--requested <model>] | --root <dir>) [--json] [--help]'

function sessionsUnder(dir) {
  const files = []
  for (const entry of entries(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory() && entry.name !== 'subagents') files.push(...sessionsUnder(file))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file)
  }
  return files.sort()
}

function main(args) {
  if (['--help', '-h'].includes(args[0]) && args.length === 1) { process.stdout.write(`${usage}\n`); return 0 }
  const options = {}
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--json') options.json = true
    else if (['--session', '--transcript', '--root', '--requested'].includes(flag) && args[i + 1] && !args[i + 1].startsWith('--')) options[flag.slice(2)] = args[++i]
    else { process.stderr.write(`${usage}\n`); return 2 }
  }
  if (['session', 'transcript', 'root'].filter((key) => options[key]).length !== 1 || options.requested && !options.transcript) {
    process.stderr.write(`${usage}\n`); return 2
  }
  let files
  try { files = options.root ? sessionsUnder(options.root) : [options.session ?? options.transcript] } catch { files = [] }
  if (!files.length) { process.stderr.write('No transcripts found\n'); return 2 }
  const entries = []; let agents = 0; let sessions = 0
  for (const file of files) {
    if (options.transcript) entries.push({ name: file, result: analyseTranscript(file, { requested: options.requested }) })
    else {
      const session = analyseSession(file); sessions++
       entries.push({ name: file, result: session.parent })
       for (const agent of session.agents) { agents++; entries.push({ ...agent, fallbacks: [...agent.result.fallbacks, ...session.parent.fallbacks] }) }
    }
  }
  let unknown = 0; let warnings = 0
  const output = entries.map(({ name, result, fallbacks }) => {
    const lines = modelWarnings(result, { name, fallbacks }); warnings += lines.length
    if (result.unknown) unknown++
    return { name, models: result.runs.map((run) => run.model), unknown: result.unknown, warnings: lines }
  })
  const summary = { sessions: sessions || 1, agents, warnings, unknown }
  if (options.json) process.stdout.write(`${JSON.stringify({ entries: output, summary }, null, 2)}\n`)
  else {
    for (const entry of output) {
      process.stdout.write(`${entry.name}: served=${entry.models.join(',') || 'unknown'}${entry.unknown ? ' UNKNOWN' : ''}\n`)
      for (const warning of entry.warnings) process.stdout.write(`${warning}\n`)
    }
    process.stdout.write(`SUMMARY: sessions=${summary.sessions} agents=${agents} warnings=${warnings} unknown=${unknown}\n`)
  }
  if (warnings) return 1
  return unknown ? 3 : 0
}

process.exitCode = main(process.argv.slice(2))
