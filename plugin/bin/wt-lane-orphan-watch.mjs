#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendSupervisorJournal, argvSummary, classifyLane, inspectProcess, latestWorktreeWrite, readLogTail, shellQuote, supervisionPaths, terminateLane } from './lib/lane-supervisor-core.mjs'
import { posixCommandArgs, registeredWorktrees, reportableOpencodeArgv, stagingLaneDirs, suiteUmbrellaWorktrees } from './lib/lane-live-scan.mjs'
import { terminateOrphanWatchers } from './lib/lane-watcher-orphans.mjs'
import { listBrokers, listProcessRelationships, listProcessTable } from './lib/second-opinion-core.mjs'
import { idleHelperEvents } from './lib/resolved-binary.mjs'
import { resolvePluginDataDir } from './lib/plugin-data-dir.mjs'
import { resolveWorkflowToolboxOption } from './lib/plugin-options.mjs'

const CONTROL = fileURLToPath(new URL('./wt-lane-control.mjs', import.meta.url))
const LAUNCHER = fileURLToPath(new URL('./wt-lane.mjs', import.meta.url))
const TEST_SEAMS_ACTIVE = new Set([
  ...(process.env.WT_LANE_WATCH_TEST_SWEEP_LOG ? ['WT_LANE_WATCH_TEST_SWEEP_LOG'] : []),
  ...(process.env.WT_LANE_WATCH_TEST_HELPERS ? ['WT_LANE_WATCH_TEST_HELPERS'] : []),
])
const argvValue = (argv, flag) => {
  const index = Array.isArray(argv) ? argv.indexOf(flag) : -1
  return index >= 0 ? argv[index + 1] ?? null : null
}

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

function records(project, staging = stagingLaneDirs(project)) {
  const git = registeredWorktrees(project)
  const umbrella = suiteUmbrellaWorktrees(project)
  const worktrees = new Set([project, ...(git.status === 'known' ? git.worktrees : []), ...(umbrella.status === 'known' ? umbrella.worktrees : []), ...staging])
  const out = []
  for (const worktree of worktrees) {
    const dir = supervisionPaths(worktree).dir
    let currentRunId = null
    try { currentRunId = JSON.parse(readFileSync(supervisionPaths(worktree).pointer, 'utf8')).runId } catch {}
    let names = []
    try { names = readdirSync(dir).filter((name) => /^\d+-\d+\.json$/.test(name)) } catch {}
    if (currentRunId) names.sort((a, b) => Number(b === `${currentRunId}.json`) - Number(a === `${currentRunId}.json`))
    for (const name of names) {
      try {
        const record = JSON.parse(readFileSync(path.join(dir, name), 'utf8'))
        Object.defineProperty(record, '__recordWorktree', { value: worktree })
        out.push(record)
      } catch {}
    }
  }
  return out
}

const canonicalPath = (value) => {
  let probe = path.resolve(value)
  const suffix = []
  while (true) {
    try { return path.resolve(realpathSync(probe), ...suffix) } catch {
      const parent = path.dirname(probe)
      if (parent === probe) return path.resolve(value)
      suffix.unshift(path.basename(probe))
      probe = parent
    }
  }
}

const containsPath = (root, candidate) => {
  const canonicalRoot = canonicalPath(root)
  const canonicalCandidate = canonicalPath(candidate)
  return canonicalCandidate === canonicalRoot || canonicalCandidate.startsWith(`${canonicalRoot}${path.sep}`)
}

const processDir = (argv, cwd) => {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--dir' && argv[index + 1]) return path.resolve(cwd, argv[index + 1])
    if (argv[index].startsWith('--dir=') && argv[index].slice('--dir='.length)) return path.resolve(cwd, argv[index].slice('--dir='.length))
  }
  return null
}

const isOpencodeCommand = (command) => /(?:^|[\\/\s])opencode(?:\.exe|\.cmd)?(?:\s|$)/i.test(command)

function processRecordDirs(project, table) {
  if (!table.supported) return []
  const dirs = []
  for (const item of table.processes) {
    if (!isOpencodeCommand(item.command)) continue
    const candidate = inspectProcess(item.pid)
    if (!candidate?.cwd || (candidate.cwd !== project && !candidate.cwd.startsWith(`${project}${path.sep}`))) continue
    const argv = Array.isArray(candidate.argv) && candidate.argv.length > 0 ? candidate.argv : posixCommandArgs(item.command)
    if (reportableOpencodeArgv(argv)) dirs.push(processDir(argv, candidate.cwd) ?? candidate.cwd)
  }
  return dirs
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
  const journaled = new Set()
  const episodeStarts = new Map()
  const testSweepLog = (line) => {
    if (!process.env.WT_LANE_WATCH_TEST_SWEEP_LOG) return
    try {
      appendFileSync(process.env.WT_LANE_WATCH_TEST_SWEEP_LOG, `${line}\n`)
    } catch (error) {
      // Test receipt logging must never throw past safeSweep or mask the real sweep error.
      process.stderr.write(`wt-lane-orphan-watch: test sweep log write failed; watcher behavior unchanged: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  const notice = (key, message) => {
    process.stdout.write(`${message}\n`)
    notified.add(key)
  }
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
  if (TEST_SEAMS_ACTIVE.size > 0) {
    const controls = [...TEST_SEAMS_ACTIVE].map((name) => `${name}=${process.env[name]}`).join(' ')
    process.stderr.write(`⚠ LANE ORPHAN WATCH TEST MODE — ${controls} — sweep receipts are test-only and logging failures cannot alter watcher behavior. This must NEVER be set outside the test suite.\n`)
  }
  const sweep = () => {
    const watcherOrphans = terminateOrphanWatchers()
    if (watcherOrphans.status === 'unavailable') {
      const key = 'watcher-orphans:unavailable'
      if (!notified.has(key)) notice(key, watcherOrphans.reason)
    } else {
      for (const item of watcherOrphans.orphans) {
        const key = `watcher-orphan:${item.pid}:${item.startTime}`
        if (watcherOrphans.killed.includes(item.pid) && !notified.has(key)) {
          journal({ event: 'watcher-orphan-signaled', pid: item.pid, argv: argvSummary(item.argv), worktree: item.cwd.slice(0, -' (deleted)'.length), owner: null, reason: 'deleted cwd and ppid=1; SIGTERM sent by exact PID' })
          notice(key, `LANE watcher-orphan signaled: pid=${item.pid} cwd=${JSON.stringify(item.cwd)} ppid=1; SIGTERM sent by exact PID`)
        }
      }
      for (const item of watcherOrphans.reports) {
        const key = `watcher-orphan-report:${item.pid}:${item.startTime ?? 'unknown'}:${item.reason}`
        if (!notified.has(key)) notice(key, `WARNING: wt-lane-orphan-watch pid=${item.pid} requires review: ${item.reason}`)
      }
    }
    const staging = stagingLaneDirs(options.project)
    const table = listProcessTable()
    let helperRows = table.supported ? table.processes : []
    let helperAges = new Map()
    if (process.env.WT_LANE_WATCH_TEST_HELPERS) {
      try { helperRows = JSON.parse(readFileSync(process.env.WT_LANE_WATCH_TEST_HELPERS, 'utf8')) } catch { helperRows = [] }
    } else {
      const relationships = listProcessRelationships()
      if (relationships.status === 'known') helperAges = new Map(relationships.processes.map((item) => [item.pid, item.elapsedSeconds]))
    }
    for (const event of idleHelperEvents(helperRows, { ageByPid: helperAges, inspect: inspectProcess })) if (!notified.has(event.key)) notice(event.key, event.message)
    const known = records(options.project, [...staging, ...processRecordDirs(options.project, table)])
    for (const record of known) {
      const verdict = classifyLane(record)
      const processRecord = verdict.child === 'running' ? inspectProcess(record.childPid) : null
      const ownsNotice = record.owner === 'session' && Boolean(record.ownerSessionId) && record.ownerSessionId === process.env.CLAUDE_CODE_SESSION_ID
      const decisionKey = `${record.runId}:${record.timeoutAt}`
      if (ownsNotice && record.state === 'decision-needed' && !notified.has(decisionKey)) {
        const e = record.evidence ?? {}
        const model = argvValue(record.workerArgv, '--model')
        const brief = argvValue(record.workerArgv, '--brief')
        const control = `node ${shellQuote(CONTROL)} --dir ${shellQuote(record.worktree)}`
        const restart = model && brief && path.isAbsolute(brief) && existsSync(brief)
          ? `; to relaunch from the worktree's current state, abandon, then run node ${shellQuote(LAUNCHER)} --dir ${shellQuote(record.worktree)} --model ${shellQuote(model)} --brief ${shellQuote(brief)}`
          : ''
        notice(decisionKey, `LANE ${record.state}: owner=${record.owner} worktree=${record.worktree} pid=${record.childPid} last-write=${e.lastWriteAt ?? 'unknown'} process=${e.process ?? 'unknown'} log-tail=${JSON.stringify(e.logTail ?? '')}; extend with ${control} --decision extend, or abandon with ${control} --decision abandon before ${record.decisionDueAt}${restart}; default=${record.defaultDecision}`)
      }
      const stalledKey = `${record.runId}:stalled`
      if (verdict.status === 'running' && processRecord) {
        const activity = latestWorktreeWrite(record.worktree)
        if (activity.status === 'known' && activity.at && Date.now() - activity.at >= stallMinutes * 60_000) {
          const evidence = { lastWriteAt: new Date(activity.at).toISOString(), activityBounded: activity.bounded, logTail: readLogTail(record.log), process: 'running' }
          const episodeStartedAt = episodeStarts.get(stalledKey) ?? new Date().toISOString(); episodeStarts.set(stalledKey, episodeStartedAt)
          if (!journaled.has(stalledKey) && journal({ event: 'stalled', runId: record.runId, episodeStartedAt, pid: record.childPid, argv: argvSummary(processRecord.argv), worktree: record.worktree, owner: record.owner, reason: `no worktree write for ${stallMinutes} minutes`, evidence })) journaled.add(stalledKey)
          if (ownsNotice && !notified.has(stalledKey)) notice(stalledKey, `LANE stalled: owner=${record.owner} worktree=${record.worktree} pid=${record.childPid} last-write=${evidence.lastWriteAt} process=running log-tail=${JSON.stringify(evidence.logTail)}; inspect or nudge; timeout decisions are extend or abandon; no process was killed`)
        } else {
          journaled.delete(stalledKey)
          notified.delete(stalledKey)
          episodeStarts.delete(stalledKey)
          testSweepLog(`${stalledKey}:cleared`)
        }
      } else {
        journaled.delete(stalledKey)
        notified.delete(stalledKey)
        episodeStarts.delete(stalledKey)
      }
      const cleanKey = `${record.runId}:would-clean`
      const cleanupCandidate = verdict.status === 'worker-gone-child-alive' && ['exited', 'abandoned'].includes(record.state) && processRecord
      if (!cleanupCandidate) {
        journaled.delete(cleanKey)
        notified.delete(cleanKey)
        episodeStarts.delete(cleanKey)
        if (verdict.status === 'worker-gone-child-alive') {
          const orphanKey = `${record.runId}:worker-gone-child-alive`
          if (!journaled.has(orphanKey) && journal({ event: 'worker-gone-child-alive', runId: record.runId, pid: record.childPid, argv: argvSummary(processRecord?.argv ?? record.childArgv ?? []), worktree: record.worktree, owner: record.owner, reason: verdict.reason })) journaled.add(orphanKey)
          if (ownsNotice && !notified.has(orphanKey)) notice(orphanKey, `LANE worker-gone-child-alive: worktree=${record.worktree} child pid=${record.childPid}; abandon with node ${shellQuote(CONTROL)} --dir ${shellQuote(record.worktree)} --decision abandon`)
        }
        continue
      }
      const evidence = { recordState: record.state, launcherAlive: false, childPid: record.childPid, childArgv: record.childArgv, childCwd: processRecord.cwd, workerPid: record.workerPid }
      const episodeStartedAt = episodeStarts.get(cleanKey) ?? new Date().toISOString(); episodeStarts.set(cleanKey, episodeStartedAt)
      if (cleanupMode === 'observe') {
        if (!journaled.has(cleanKey) && journal({ event: 'would-clean', runId: record.runId, episodeStartedAt, pid: processRecord.pid, argv: argvSummary(processRecord.argv), worktree: record.worktree, owner: record.owner, reason: verdict.reason, evidence })) journaled.add(cleanKey)
        if (ownsNotice && !notified.has(cleanKey)) notice(cleanKey, `LANE would-clean: worktree=${record.worktree} pid=${record.childPid} reason=${verdict.reason}; lane_orphan_cleanup=observe, no process was killed`)
        continue
      }
      const result = terminateLane(record, { journal, source: 'watcher', recordWorktree: record.__recordWorktree })
      journal({ event: result.killed ? 'cleaned' : 'cleanup-refused', runId: record.runId, pid: processRecord.pid, argv: argvSummary(processRecord.argv), worktree: record.worktree, owner: record.owner, reason: result.killed ? verdict.reason : result.reason, evidence }, { killed: result.killed })
    }
    const attributed = new Set(known.map((record) => record.childPid))
    if (table.supported) for (const item of table.processes) {
      if (!isOpencodeCommand(item.command) || attributed.has(item.pid) || notified.has(`unknown:${item.pid}`)) continue
      const unknown = inspectProcess(item.pid)
      if (!unknown?.cwd || (unknown.cwd !== options.project && !unknown.cwd.startsWith(`${options.project}${path.sep}`))) continue
      const argv = Array.isArray(unknown.argv) && unknown.argv.length > 0 ? unknown.argv : posixCommandArgs(item.command)
      if (!reportableOpencodeArgv(argv)) continue
      if (String(argv[1] ?? '').replaceAll('\\', '/').includes('/test/fixtures/')) continue
      const dir = processDir(argv, unknown.cwd)
      if (staging.some((lane) => containsPath(lane, unknown.cwd) || (dir && containsPath(lane, dir)))) continue
      journal({ event: 'unattributed', pid: item.pid, argv: item.command.slice(0, 300), worktree: unknown.cwd, owner: null, reason: 'unknown-owner' })
      notice(`unknown:${item.pid}`, `WARNING: unattributed opencode pid=${item.pid} argv=${JSON.stringify(item.command.slice(0, 300))}; it was not killed`)
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
    } finally {
      testSweepLog('sweep')
    }
  }
  safeSweep()
  if (options.once) return 0
  setInterval(safeSweep, options.poll * 1000)
  await new Promise(() => {})
}

main().then((code) => { process.exitCode = code })
