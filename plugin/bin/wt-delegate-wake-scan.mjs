#!/usr/bin/env node
// One-shot replay of a single main session's attributable completion notices.
import path from 'node:path'
import { classifyRelays, readAgents, readMainTranscript, writeResumed } from './lib/delegate-wake.mjs'
import { defaultRegistryDir } from './lib/host/delegate-wake-files.mjs'
import { handleHelpFlag } from './lib/cli-help.mjs'
import { restartEvidence } from './lib/host/delegate-wake-restart.mjs'
import { acknowledgementCommand, claimDecision, decisionPaths, unsettled } from './lib/host/delegate-wake-decisions.mjs'

const args = process.argv.slice(2)
handleHelpFlag(args, `wt-delegate-wake-scan — replay session-scoped completion notices and optional registry transitions.
Usage: wt-delegate-wake-scan --session <absolute main transcript> [--grace <seconds>] [--at <iso>] [--json] [--write-resumed]
  --ack <raw-agent-id> silence this agent in this session for at least 7 days and exit (a name or task id is refused:
    "not a raw agent id").
  --boot-at <iso|unknown> override platform boot time for replay/testing.
  --session-started-at <iso|unknown> measured session process start (default: unknown;
    the scanner's shell parent is not the monitored session).
Pre-restart notices are ORPHANED BY RESTART, never relay requests. Default replay reads
acknowledgements but does not consume once-only watcher announcements. Unknown boot evidence
is explicitly diagnosed. WAKE and ORPHANED lines print the exact --ack command.
WAKE lines are directly evidenced (the delegate's own end_turn, no later assistant record).
FORWARD lines are printed as "FORWARD (unverified): ..." — a diagnostic candidate list only: whether a
nested delegate's parent received its notice is inferred from missing records, and that inference's
precision is unmeasured. The live watcher (wt-arc-watch) never announces FORWARD.
`, {
  valueFlags: ['--session', '--grace', '--at', '--ack', '--boot-at', '--session-started-at'],
  booleanFlags: ['--json', '--write-resumed'],
})
const allowed = new Set(['--session', '--grace', '--at', '--json', '--write-resumed', '--ack', '--boot-at', '--session-started-at'])
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
const RAW_AGENT_ID = /^a[a-z0-9-]{6,80}$/
// An orphan past the 24 h ceiling is listed as stale, as before: never a line, never actionable.
function listAgedAsStale(result) {
  const aged = result.lines.filter((entry) => entry.aged)
  result.lines = result.lines.filter((entry) => !entry.aged)
  result.stale.push(...aged.map((entry) => ({ owner: entry.target, taskId: entry.taskId, at: new Date(entry.at).toISOString() })))
}
// The relay text names its kind first; FORWARD's inference is unverified, so say so on the line itself.
const shown = (entry) => entry.kind === 'FORWARD' ? entry.line.replace(/^FORWARD:/, 'FORWARD (unverified):') : entry.line
try {
  const sessionDir = session.slice(0, -6)
  const sessionId = path.basename(session, '.jsonl')
  const { decisions } = decisionPaths(sessionId)
  if (args.includes('--ack')) {
    const target = String(value('--ack', '') ?? '')
    if (!RAW_AGENT_ID.test(target)) {
      process.stderr.write(`wt-delegate-wake-scan: not a raw agent id: ${target.slice(0, 80).replace(/[^ -~]/g, '?')}\n`)
      process.exit(2)
    }
    claimDecision(decisions, `ack:${target}`)
    process.stdout.write(`Acknowledged: ${target}\n`)
    process.exit(0)
  }
  const { agents, meta } = readAgents(sessionDir)
  if (args.includes('--write-resumed')) {
    const registryDir = defaultRegistryDir()
    writeResumed(path.join(registryDir, `${sessionId}.jsonl`), path.join(sessionDir, 'subagents'), at)
  }
  const result = classifyRelays({ sessionId, main: readMainTranscript(session), agents, meta,
    restart: restartEvidence(value('--boot-at', undefined), value('--session-started-at', 'unknown')),
    ackCommand: (target) => acknowledgementCommand(session, target), now: at, grace: grace * 1000 })
  listAgedAsStale(result)
  result.lines = unsettled(result.lines, decisions)
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
  process.stdout.write(`ARC WATCH DEGRADED: ${error.code ?? 'session transcript, restart evidence or terminal decisions unavailable'}\n`)
  process.exitCode = 1
}
