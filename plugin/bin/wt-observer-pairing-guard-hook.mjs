#!/usr/bin/env node
// wt-observer-pairing-guard-hook.mjs — a PostToolUse guard on the Agent tool: after a spawn that
// SHOULD carry an observer, ask the shipped pairing checker what actually happened and surface only
// the non-pass outcomes. The guard does not re-derive pairing itself: the harness's own
// observerTaskId ownership link, its contradictory/dangling states, the in_process_teammate
// exemption, and the mtime fallback already live in wt-check-observer-pairing.mjs.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CHECKER = path.join(HERE, 'wt-check-observer-pairing.mjs')

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function definitionDirs(cwd) {
  const dirs = []
  if (cwd) {
    let current = path.resolve(cwd)
    for (;;) {
      dirs.push(path.join(current, '.claude', 'agents'))
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  dirs.push(path.join(configDir, 'agents'))
  return dirs
}

function findDefinition(type, cwd) {
  const bare = type.includes(':') ? type.slice(type.lastIndexOf(':') + 1) : type
  for (const dir of definitionDirs(cwd)) {
    const file = path.join(dir, `${bare}.md`)
    try {
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8')
    } catch {
      // unreadable dir or file: keep looking, never block the spawn's report path
    }
  }
  return null
}

function declaredObserver(source) {
  const fm = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return null
  const m = fm[1].match(/^observer:\s*["']?([A-Za-z0-9_-]+)["']?/m)
  return m ? m[1] : null
}

function projectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function subagentsDirFor(cwd, sessionId) {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'projects', projectSlug(cwd), sessionId, 'subagents')
}

function runCheck(args) {
  try {
    const res = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5_000 })
    if (res.error || typeof res.status !== 'number') return null
    const stdout = typeof res.stdout === 'string' ? res.stdout.trim() : ''
    if (!stdout) return null
    const json = JSON.parse(stdout)
    if (!json || typeof json !== 'object') return null
    return { exitCode: res.status, json }
  } catch {
    return null
  }
}

function main() {
  const input = readInput()
  if (input.hook_event_name !== 'PostToolUse' || input.tool_name !== 'Agent') return
  if (!fs.existsSync(CHECKER)) return

  const cwd = typeof input.cwd === 'string' ? input.cwd : ''
  const sessionId = typeof input.session_id === 'string' ? input.session_id : ''
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}
  const tr = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response : {}
  const type = typeof ti.subagent_type === 'string' ? ti.subagent_type.trim() : ''
  const name = typeof ti.name === 'string' && ti.name.trim() ? ti.name.trim() : null
  const agentId =
    typeof tr.agent_id === 'string' && tr.agent_id ? tr.agent_id
      : typeof tr.teammate_id === 'string' && tr.teammate_id ? tr.teammate_id
        : typeof tr.agentId === 'string' && tr.agentId ? tr.agentId
          : null
  if (!cwd || !sessionId || !type || (!agentId && !name)) return

  const source = findDefinition(type, cwd)
  if (!source) return
  const observerName = declaredObserver(source)
  if (!observerName) return

  const args = [CHECKER, '--subagents-dir', subagentsDirFor(cwd, sessionId)]
  if (agentId) args.push('--agent-id', agentId)
  if (name) args.push('--name', name)
  const verdict = runCheck(args)
  if (!verdict) return

  const status = typeof verdict.json.status === 'string' ? verdict.json.status : 'unknown'
  if (verdict.exitCode === 0 && status === 'pass') return

  const reason = typeof verdict.json.reason === 'string' ? verdict.json.reason : 'no reason reported'
  const subject = name ? `"${name}" (${type})` : `${type} (${agentId})`
  const summary =
    verdict.exitCode === 1
      ? `appears to have LOST its declared observer '${observerName}'`
      : `could not establish the state of its declared observer '${observerName}'`

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `[workflow-toolbox observer-pairing] ${subject} ${summary}. ` +
          `Delegated to wt-check-observer-pairing.mjs after spawn; checker verdict ${status}: ${reason}`,
      },
    }),
  )
}

try {
  main()
} catch {
  // A hook that can break the spawn it is auditing is worse than silence.
}
