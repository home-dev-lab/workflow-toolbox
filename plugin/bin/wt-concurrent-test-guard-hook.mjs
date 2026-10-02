#!/usr/bin/env node
// Journal before starting a test runner when another live test runner can actually overlap it.
// Warn paths are journal-only pending precision measurement: allow would auto-approve the
// call, and permissionDecisionReason reaches no model. Deny paths still emit refusals.
// Enumeration uses a structured `ps` snapshot, never `pgrep -f`: the hook excludes its entire
// ancestor chain before looking at executable positions, so its process, launcher shell, and the
// command text being inspected cannot manufacture a match.
//
// Lock awareness. The machine suite lock serializes every run that takes it, whatever the command
// head (a Vitest config whose global setup takes the lease, or a package script wrapping it). A
// covered start that will QUEUE next to runners that are all the lock holder, a queued waiter, or
// their descendants is not contention: journalled `silent`, class `lock-queued-start`. Membership is
// positive evidence only (live pids in holder.json and the queue tickets); a runner it cannot place counts
// as outside. A start outside the lock, or running inside an inherited lease, is classified next to any
// runner. A version or help query is not a run; every start in the command is judged, and the least
// covered one decides.
//
// Record. Every inspected start is journalled with evidence {count, start, outside, lock, kind,
// starts} and a `reason` naming the run directory and the Bash call's tool_use_id, never the command
// text, so a firing can be classified from the record alone. `warned` means a journal-only
// detection, not proof of a delivered notice. A sub-agent (not a Workflow worker) whose run
// is `uncovered` on a machine that uses the lock is journalled `uncovered-delegate-start` when no
// runner is alive; `bypassed` is left to the suite-lock bypass guard when solo. Never a permission decision
// except the role-closed refusal when enumeration is unavailable.

import { execFileSync } from 'node:child_process'
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { emitGuardNotice, recordGuardEvent } from './lib/guard-journal.mjs'
import { homeDirectory, lockParticipants, readText } from './lib/host/test-run-lock-host.mjs'
import { resolvedBinary } from './lib/resolved-binary.mjs'
import { isWorkflowSubagentPayload } from './lib/subagent-delivery-shape.mjs'
import { isQueued, lockCoverage, parseTestRunStarts, runnersOutsideLock, worstCoverage } from './lib/test-run-lock-coverage.mjs'

const GUARD = 'wt-concurrent-test-guard-hook.mjs'
const RUNNER_NAMES = new Set(['vitest', 'jest', 'mocha', 'pytest', 'py.test'])
const TAG = '[workflow-toolbox concurrent-test guard]'

function readInput() {
  try { return JSON.parse(readFileSync(0, 'utf8')) || {} } catch { return {} }
}

function basename(value) {
  return String(value || '').split(/[\\/]/).at(-1)?.toLowerCase() || ''
}

function parseSnapshot(stdout) {
  const processes = []
  for (const line of String(stdout).split('\n')) {
    if (!line.trim()) continue
    const [pid, ppid, comm] = line.trim().split(/\s+/, 3)
    if (!/^\d+$/.test(pid) || !/^\d+$/.test(ppid ?? '') || !comm) throw new Error('process enumeration returned an unexpected shape')
    const commAt = line.indexOf(comm, line.indexOf(ppid, line.indexOf(pid) + pid.length) + ppid.length)
    processes.push({ pid: Number(pid), ppid: Number(ppid), comm, args: line.slice(commAt + comm.length).trim() })
  }
  if (!processes.length) throw new Error('process enumeration returned no process records')
  return processes
}

function shellWords(value) {
  const words = []
  let current = ''
  let quote = null
  for (const char of value) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
    } else if (char === "'" || char === '"') quote = char
    else if (/\s/.test(char)) {
      if (current) words.push(current)
      current = ''
    } else current += char
  }
  if (current) words.push(current)
  return words
}

function isRunnerProcess(processRecord) {
  if (RUNNER_NAMES.has(basename(processRecord.comm))) return true
  const words = shellWords(processRecord.args)
  const first = basename(words[0])
  if (RUNNER_NAMES.has(first)) return true
  if (!['node', 'node.exe'].includes(first)) return false
  const script = basename(words[1])
  return /^(?:vitest|jest|mocha)(?:\.(?:mjs|cjs|js))?$/.test(script)
}

function existingRunners() {
  if (process.platform === 'win32') {
    return { available: false, reason: 'process enumeration is not supported on Windows' }
  }
  const pathApi = path
  const ps = resolvedBinary('ps', process.env, {
    accessSyncFn: accessSync,
    constants,
    platform: process.platform,
    realpathSyncFn: realpathSync,
    statSyncFn: statSync,
    pathApi,
  })
  if (ps === null) return { available: false, reason: '`ps` is unavailable' }

  let stdout
  try {
    stdout = execFileSync(ps, ['-eo', 'pid=,ppid=,comm=,args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
    })
  } catch (error) {
    return {
      available: false,
      reason: `process enumeration failed (${error instanceof Error ? error.message : String(error)})`,
    }
  }

  let processes
  try { processes = parseSnapshot(stdout) } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) }
  }
  const byPid = new Map(processes.map((record) => [record.pid, record]))
  const excluded = new Set([process.pid])
  let parent = process.ppid
  while (parent > 0 && !excluded.has(parent)) {
    excluded.add(parent)
    parent = byPid.get(parent)?.ppid || 0
  }
  return {
    available: true,
    runners: processes.filter((record) => !excluded.has(record.pid) && isRunnerProcess(record)),
    parentOf: (pid) => byPid.get(pid)?.ppid ?? 0,
  }
}

function deny(input, message) {
  return emitGuardNotice({
    payload: input,
    stdoutJson: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${TAG} Refused: ${message}`,
      },
    },
  })
}

function startReason(starts, input) {
  const dirs = [...new Set(starts.map((start) => start.dir ?? 'unresolved'))].join(',')
  const tool = typeof input.tool_use_id === 'string' && input.tool_use_id ? input.tool_use_id : 'none'
  return `dir=${dirs} tool=${tool}`
}

function startKind(starts) {
  const kinds = [...new Set(starts.map((start) => start.kind))]
  return kinds.length === 1 ? kinds[0] : 'mixed'
}

function enumerationUnavailable(input, starts, reason) {
  const closed = process.env.WT_SDK_ROLE_GUARD_FAILURE === 'closed'
  const message = `could not enumerate existing test-runner processes: ${reason}. This is unknown, not a zero count.`
  const spoke = closed && deny(input, message)
  recordGuardEvent({
    guard: GUARD,
    decision: closed ? (spoke ? 'blocked' : 'silent') : 'warned',
    class: 'enumeration-unavailable',
    reason: startReason(starts, input),
    session: input.session_id,
    agent: input.agent_id,
    evidence: { status: 'unavailable', kind: startKind(starts), starts: starts.length },
  })
}

function startClass(concurrent, delegateOutside, count) {
  if (concurrent) return 'concurrent-test-start'
  if (delegateOutside) return 'uncovered-delegate-start'
  return count > 0 ? 'lock-queued-start' : 'solo-test-start'
}

function main() {
  const input = readInput()
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') return
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd()
  const starts = parseTestRunStarts(input.tool_input?.command, cwd, homeDirectory())
  if (starts.length === 0) return

  const result = existingRunners()
  if (!result.available) {
    enumerationUnavailable(input, starts, result.reason)
    return
  }

  const coverage = worstCoverage(starts.map((start) => lockCoverage({ ...start, readText, env: process.env })))
  const lock = lockParticipants(process.env)
  const count = result.runners.length
  const outside = runnersOutsideLock(result.runners, lock.participants, result.parentOf)
  const concurrent = count > 0 && (!isQueued(coverage) || outside > 0)
  const delegate = typeof input.agent_id === 'string' && input.agent_id !== '' && !isWorkflowSubagentPayload(input)
  const delegateOutside = !concurrent && delegate && lock.inUse && coverage === 'uncovered'

  const cls = startClass(concurrent, delegateOutside, count)
  recordGuardEvent({
    guard: GUARD,
    decision: concurrent || delegateOutside ? 'warned' : 'silent',
    class: cls,
    reason: startReason(starts, input),
    session: input.session_id,
    agent: input.agent_id,
    evidence: { count, start: coverage, outside, lock: lock.state, kind: startKind(starts), starts: starts.length },
  })
}

runFailOpenHook(GUARD, main)
