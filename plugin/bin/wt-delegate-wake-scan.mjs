#!/usr/bin/env node
// One-shot replay of a single main session's attributable completion notices.
import path from 'node:path'
import { detectRelays, readAgents, readMainTranscript, writeResumed } from './lib/delegate-wake.mjs'
import { defaultRegistryDir } from './lib/host/delegate-wake-files.mjs'
import { handleHelpFlag } from './lib/cli-help.mjs'

const args = process.argv.slice(2)
handleHelpFlag(args, `wt-delegate-wake-scan — replay session-scoped completion notices and optional registry transitions.
Usage: wt-delegate-wake-scan --session <absolute main transcript> [--grace <seconds>] [--at <iso>] [--json] [--write-resumed]
WAKE lines are directly evidenced (the delegate's own end_turn, no later assistant record).
FORWARD lines are printed as "FORWARD (unverified): ..." — a diagnostic candidate list only: whether a
nested delegate's parent received its notice is inferred from missing records, and that inference's
precision is unmeasured. The live watcher (wt-arc-watch) never announces FORWARD.
`)
const allowed = new Set(['--session', '--grace', '--at', '--json', '--write-resumed'])
if (args.some((arg) => arg.startsWith('--') && !allowed.has(arg))) {
  process.stderr.write('wt-delegate-wake-scan: unknown option\n')
  process.exit(2)
}
const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback
const session = value('--session', '')
const grace = Number(value('--grace', '90'))
const at = args.includes('--at') ? Date.parse(value('--at', '')) : Date.now()
if (!session || !path.isAbsolute(session) || !session.endsWith('.jsonl') || !Number.isFinite(grace) || grace < 0 || !Number.isFinite(at)) {
  process.stderr.write('Usage: wt-delegate-wake-scan --session <absolute main transcript> [--grace <seconds>] [--at <iso>] [--json] [--write-resumed]\n')
  process.exit(2)
}
// The relay text names its kind first; FORWARD's inference is unverified, so say so on the line itself.
const shown = (entry) => entry.kind === 'FORWARD' ? entry.line.replace(/^FORWARD:/, 'FORWARD (unverified):') : entry.line
try {
  const sessionDir = session.slice(0, -6)
  const sessionId = path.basename(session, '.jsonl')
  const { agents, meta } = readAgents(sessionDir)
  if (args.includes('--write-resumed')) {
    const registryDir = defaultRegistryDir()
    writeResumed(path.join(registryDir, `${sessionId}.jsonl`), path.join(sessionDir, 'subagents'), at)
  }
  const result = detectRelays({ sessionId, main: readMainTranscript(session), agents, meta,
    now: at, grace: grace * 1000 })
  result.lines = result.lines.map((entry) => ({ ...entry, line: shown(entry), actionable: entry.kind === 'WAKE',
    ...(entry.kind === 'FORWARD' ? { verification: 'unverified' } : {}) }))
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else {
    for (const line of [...result.degraded.map((s) => `ARC WATCH DEGRADED: ${s}`), ...result.lines.map((l) => shown(l))]) process.stdout.write(`${line}\n`)
    // Too old to relay: a days-late wake would point the agent at stale work. Listed, never actionable.
    if (result.stale.length) process.stdout.write(`STALE (not relayed, completion older than 24 h): ${result.stale.length} — ` +
      `${result.stale.slice(0, 10).map((s) => `${s.owner} task ${s.taskId} at ${s.at}`).join('; ')}${result.stale.length > 10 ? '; …' : ''}\n`)
  }
} catch (error) {
  process.stdout.write(`ARC WATCH DEGRADED: ${error.code ?? 'session transcript or meta unreadable'}\n`)
  process.exitCode = 1
}
