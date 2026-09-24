#!/usr/bin/env node
// Warn before starting a test runner when another test-runner process is already alive.
// Enumeration uses a structured `ps` snapshot, never `pgrep -f`: the hook excludes its entire
// ancestor chain before looking at executable positions, so its process, launcher shell, and the
// command text being inspected cannot manufacture a match.

import { execFileSync } from 'node:child_process'
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { commandHeads } from './lib/command-invocation.mjs'
import { emitGuardNotice, recordGuardEvent } from './lib/guard-journal.mjs'
import { resolvedBinary } from './lib/resolved-binary.mjs'

const GUARD = 'wt-concurrent-test-guard-hook.mjs'
const RUNNER_NAMES = new Set(['vitest', 'jest', 'mocha', 'pytest', 'py.test'])

function readInput() {
  try { return JSON.parse(readFileSync(0, 'utf8')) || {} } catch { return {} }
}

function basename(value) {
  return String(value || '').split(/[\\/]/).at(-1)?.toLowerCase() || ''
}

function startsTestRunner(command) {
  if (typeof command !== 'string' || !command) return false
  return commandHeads(command).some((head) => {
    const direct = head.match(/^(\S+)(?:\s+(.+))?$/)
    if (!direct) return false
    const executable = basename(direct[1])
    const rest = direct[2] || ''
    if (executable === 'vitest') return /^run(?:\s|$)/.test(rest)
    if (executable !== 'pnpm') return false
    return /^(?:test(?:\s|$)|-r\s+test(?:\s|$)|--recursive\s+test(?:\s|$)|vitest(?:\s|$)|exec\s+vitest(?:\s|$))/.test(rest)
  })
}

function parseSnapshot(stdout) {
  const processes = []
  for (const line of String(stdout).split('\n')) {
    if (!line.trim()) continue
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/)
    if (!match) throw new Error('process enumeration returned an unexpected shape')
    processes.push({ pid: Number(match[1]), ppid: Number(match[2]), comm: match[3], args: match[4] })
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

function existingRunnerCount() {
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
    count: processes.filter((record) => !excluded.has(record.pid) && isRunnerProcess(record)).length,
  }
}

function warning(input, message) {
  emitGuardNotice({
    payload: input,
    stdoutJson: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: `[workflow-toolbox concurrent-test guard] WARNING (not blocked): ${message}`,
      },
    },
  })
}

function deny(input, message) {
  emitGuardNotice({
    payload: input,
    stdoutJson: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `[workflow-toolbox concurrent-test guard] Refused: ${message}`,
      },
    },
  })
}

function main() {
  const input = readInput()
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') return
  if (!startsTestRunner(input.tool_input?.command)) return

  const result = existingRunnerCount()
  if (!result.available) {
    const closed = process.env.WT_SDK_ROLE_GUARD_FAILURE === 'closed'
    recordGuardEvent({
      guard: GUARD,
      decision: closed ? 'blocked' : 'warned',
      class: 'enumeration-unavailable',
      session: input.session_id,
      agent: input.agent_id,
      evidence: { status: 'unavailable' },
    })
    const message = `could not enumerate existing test-runner processes: ${result.reason}. This is unknown, not a zero count.`
    if (closed) deny(input, message)
    else warning(input, message)
    return
  }

  recordGuardEvent({
    guard: GUARD,
    decision: result.count > 0 ? 'warned' : 'silent',
    class: result.count > 0 ? 'concurrent-test-start' : 'solo-test-start',
    session: input.session_id,
    agent: input.agent_id,
    evidence: { count: result.count },
  })
  if (result.count === 0) return
  warning(
    input,
    `${result.count} test-runner process(es) are already running. A failure from this run may be contention, not the code. ` +
      'If this run is meant to decide whether a failure is real, wait for them to exit.',
  )
}

runFailOpenHook(GUARD, main)
