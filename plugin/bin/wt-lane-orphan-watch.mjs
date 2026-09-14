#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { appendSupervisorJournal, argvSummary, classifyLane, inspectProcess, latestWorktreeWrite, processAlive, readLogTail, supervisionPaths, supervisionUnavailableMessage, terminateVerified } from './lib/lane-supervisor-core.mjs'
import { registeredWorktrees, suiteUmbrellaWorktrees } from './lib/lane-live-scan.mjs'
import { listBrokers, listProcessTable } from './lib/second-opinion-core.mjs'
import { resolvePluginDataDir } from './lib/plugin-data-dir.mjs'
import { resolveWorkflowToolboxOption } from './lib/plugin-options.mjs'

function parse(argv) {
  const out = { once: false, poll: 60, project: process.cwd() }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--once') out.once = true
    else if (argv[i] === '--poll') out.poll = Number(argv[++i])
    else if (argv[i] === '--project') out.project = path.resolve(argv[++i] ?? '')
    else if (argv[i] === '--help' || argv[i] === '-h') return { help: true }
    else return { error: `unknown argument: ${argv[i]}` }
  }
  if (!Number.isFinite(out.poll) || out.poll <= 0) return { error: '--poll must be positive seconds' }
  return out
}

function records(project) {
  const git = registeredWorktrees(project)
  const umbrella = suiteUmbrellaWorktrees(project)
  const worktrees = new Set([project, ...(git.status === 'known' ? git.worktrees : []), ...(umbrella.status === 'known' ? umbrella.worktrees : [])])
  const out = []
  for (const worktree of worktrees) {
    const dir = supervisionPaths(worktree).dir
    let currentRunId = null
    try { currentRunId = JSON.parse(readFileSync(supervisionPaths(worktree).pointer, 'utf8')).runId } catch {}
    let names = []
    try { names = readdirSync(dir).filter((name) => /^\d+-\d+\.json$/.test(name)) } catch {}
    if (currentRunId) names.sort((a, b) => Number(b === `${currentRunId}.json`) - Number(a === `${currentRunId}.json`))
    for (const name of names) {
      try { out.push(JSON.parse(readFileSync(path.join(dir, name), 'utf8'))) } catch {}
    }
  }
  return out
}

async function main() {
  const options = parse(process.argv.slice(2))
  if (options.help) { process.stdout.write('Usage: node wt-lane-orphan-watch.mjs [--project <dir>] [--poll 60] [--once]\n'); return 0 }
  if (options.error) { process.stderr.write(`wt-lane-orphan-watch: ${options.error}\n`); return 2 }
  const stallMinutes = resolveWorkflowToolboxOption('lane_stall_minutes').value
  const cleanupMode = resolveWorkflowToolboxOption('lane_orphan_cleanup').value
  if (!Number.isFinite(stallMinutes) || stallMinutes < 1) { process.stderr.write('wt-lane-orphan-watch: lane stall threshold must be at least one minute\n'); return 2 }
  if (!['observe', 'enforce'].includes(cleanupMode)) { process.stderr.write('wt-lane-orphan-watch: lane_orphan_cleanup must be observe or enforce\n'); return 2 }
  const dataDir = path.join(resolvePluginDataDir({ env: process.env }).dir, 'lane-supervisor')
  const notified = new Set()
  let journalFailureReported = false
  const journal = (event, { killed = false } = {}) => {
    try {
      appendSupervisorJournal(dataDir, event)
      journalFailureReported = false
      return true
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (killed) process.stdout.write(`LANE kill journal failed: pid=${event.pid} event=${event.event}; process outcome=${event.reason}; audit error=${detail}\n`)
      else if (!journalFailureReported) process.stderr.write(`wt-lane-orphan-watch: journal write failed; will retry: ${detail}\n`)
      journalFailureReported = true
      return false
    }
  }
  if (process.platform !== 'linux') process.stdout.write(`${supervisionUnavailableMessage()}\n`)
  const sweep = () => {
    const known = records(options.project)
    for (const record of known) {
      const processRecord = inspectProcess(record.childPid)
      if (!processRecord) continue
      const verdict = classifyLane({ process: processRecord, record, launcherAlive: processAlive(record.workerPid) })
      const ownsNotice = record.owner === 'session' && Boolean(record.ownerSessionId) && record.ownerSessionId === process.env.CLAUDE_CODE_SESSION_ID
      if (ownsNotice && record.state === 'decision-needed' && !notified.has(`${record.runId}:${record.timeoutAt}`)) {
        notified.add(`${record.runId}:${record.timeoutAt}`)
        const e = record.evidence ?? {}
        process.stdout.write(`LANE ${record.state}: owner=${record.owner} worktree=${record.worktree} pid=${record.childPid} last-write=${e.lastWriteAt ?? 'unknown'} process=${e.process ?? 'unknown'} log-tail=${JSON.stringify(e.logTail ?? '')}; decide with wt-lane-control extend|relaunch|abandon before ${record.decisionDueAt}; default=${record.defaultDecision}\n`)
      }
      if (record.state === 'running' && !notified.has(`${record.runId}:stalled`)) {
        const activity = latestWorktreeWrite(record.worktree)
        if (activity.status === 'known' && activity.at && Date.now() - activity.at >= stallMinutes * 60_000) {
          const evidence = { lastWriteAt: new Date(activity.at).toISOString(), activityBounded: activity.bounded, logTail: readLogTail(record.log), process: 'running' }
          if (journal({ event: 'stalled', pid: record.childPid, argv: argvSummary(processRecord.argv), worktree: record.worktree, owner: record.owner, reason: `no worktree write for ${stallMinutes} minutes`, evidence })) {
            notified.add(`${record.runId}:stalled`)
            if (ownsNotice) process.stdout.write(`LANE stalled: owner=${record.owner} worktree=${record.worktree} pid=${record.childPid} last-write=${evidence.lastWriteAt} process=running log-tail=${JSON.stringify(evidence.logTail)}; inspect, nudge, extend, relaunch, or abandon; no process was killed\n`)
          }
        }
      }
      if (verdict.action !== 'clean') continue
      const evidence = { recordState: record.state, launcherAlive: false, childPid: record.childPid, childArgv: record.childArgv, childCwd: processRecord.cwd, workerPid: record.workerPid }
      if (cleanupMode === 'observe') {
        const key = `${record.runId}:would-clean`
        if (!notified.has(key) && journal({ event: 'would-clean', pid: processRecord.pid, argv: argvSummary(processRecord.argv), worktree: record.worktree, owner: record.owner, reason: verdict.reason, evidence })) {
          notified.add(key)
          if (ownsNotice) process.stdout.write(`LANE would-clean: worktree=${record.worktree} pid=${record.childPid} reason=${verdict.reason}; lane_orphan_cleanup=observe, no process was killed\n`)
        }
        continue
      }
      const result = terminateVerified(processRecord)
      journal({ event: result.killed ? 'cleaned' : 'cleanup-refused', pid: processRecord.pid, argv: argvSummary(processRecord.argv), worktree: record.worktree, owner: record.owner, reason: result.killed ? verdict.reason : result.reason, evidence }, { killed: result.killed })
    }
    const table = listProcessTable()
    const attributed = new Set(known.map((record) => record.childPid))
    if (table.supported) for (const item of table.processes) {
      if (!/(?:^|[\\/\s])opencode(?:\s|$)/i.test(item.command) || attributed.has(item.pid) || notified.has(`unknown:${item.pid}`)) continue
      const unknown = inspectProcess(item.pid)
      if (!unknown?.cwd || (unknown.cwd !== options.project && !unknown.cwd.startsWith(`${options.project}${path.sep}`))) continue
      if (journal({ event: 'unattributed', pid: item.pid, argv: item.command.slice(0, 300), worktree: unknown.cwd, owner: null, reason: 'unknown-owner' })) {
        notified.add(`unknown:${item.pid}`)
        process.stdout.write(`WARNING: unattributed opencode pid=${item.pid} argv=${JSON.stringify(item.command.slice(0, 300))}; it was not killed\n`)
      }
    }
    const brokers = listBrokers()
    if (brokers.supported) for (const pid of brokers.pids) {
      if (notified.has(`broker:${pid}`)) continue
      const broker = inspectProcess(pid)
      if (journal({ event: 'broker-observed', pid, argv: broker ? argvSummary(broker.argv) : '', worktree: null, owner: 'broker', reason: 'broker idleness detection is not implemented' })) notified.add(`broker:${pid}`)
    }
  }
  let failureReported = false
  const safeSweep = () => {
    try { sweep(); failureReported = false } catch (error) {
      if (!failureReported) process.stderr.write(`wt-lane-orphan-watch: sweep failed; will retry: ${error instanceof Error ? error.message : String(error)}\n`)
      failureReported = true
    }
  }
  safeSweep()
  if (options.once) return 0
  setInterval(safeSweep, options.poll * 1000)
  await new Promise(() => {})
}

main().then((code) => { process.exitCode = code })
