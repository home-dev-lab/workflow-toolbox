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
import { runFailOpenHook } from './lib/fail-open-trace.mjs'

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

// The project-slug directory a session's subagents live under MUST come from the
// SESSION ROOT, never from cwd at check time. cwd is the shell's working directory at
// the moment of the spawn — inside an umbrella project (a root holding several repos,
// e.g. wt-suite/workflow-toolbox) the shell is routinely sitting in a SUBDIRECTORY of
// the session root, and re-deriving the slug from that subdirectory produces a
// directory that has never existed (…-wt-suite-workflow-toolbox instead of …-wt-suite).
// The harness hands every hook a `transcript_path` pointing at
// <configDir>/projects/<slug>/<sessionId>.jsonl — its PARENT directory IS the real
// project-slug directory the session actually lives under, unaffected by cwd drift.
// Prefer it; fall back to the cwd-derived slug only when transcript_path is absent
// (never observed on a real PostToolUse Agent event, but the fallback keeps this
// fail-open rather than fail-silent on an unexpected harness payload shape).
function subagentsDirFor(cwd, sessionId, transcriptPath) {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  if (transcriptPath) {
    const projectDir = path.dirname(path.resolve(transcriptPath))
    return path.join(projectDir, sessionId, 'subagents')
  }
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
  const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : ''
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

  const subagentsDir = subagentsDirFor(cwd, sessionId, transcriptPath)
  const args = [CHECKER, '--subagents-dir', subagentsDir]
  if (agentId) args.push('--agent-id', agentId)
  if (name) args.push('--name', name)
  const verdict = runCheck(args)
  if (!verdict) return

  const status = typeof verdict.json.status === 'string' ? verdict.json.status : 'unknown'
  if (verdict.exitCode === 0 && status === 'pass') return

  const reason = typeof verdict.json.reason === 'string' ? verdict.json.reason : 'no reason reported'
  const subject = name ? `"${name}" (${type})` : `${type} (${agentId})`

  // Two 'unknown' causes read as the SAME sentence to a reader unless distinguished here:
  // a path-resolution failure (the checker could not even find its own directory) is a
  // fact about the CHECKER; a meta-lookup failure (the directory read fine, but the
  // observed agent's own record wasn't in it, or matched more than one) is a fact about
  // the OBSERVED AGENT. Neither is evidence the observer itself is missing — that is
  // exitCode 1 (LOST), handled separately below. Card 1835862067: naming WHOSE state is
  // unknown, plus where to verify by hand, is the actual fix — the checker already
  // distinguishes these via `failureClass` (wt-check-observer-pairing.mjs); this hook
  // only needed to stop collapsing them into one vague phrase.
  let summary
  let lookHere = ''
  if (verdict.exitCode === 1) {
    summary = `appears to have LOST its declared observer '${observerName}'`
  } else {
    const failureClass = typeof verdict.json.failureClass === 'string' ? verdict.json.failureClass : null
    if (failureClass === 'path-resolution') {
      summary = `PAIRING UNKNOWN — the checker could not resolve its own path (${subagentsDir})`
      lookHere =
        ` To verify by hand: check whether that directory exists and is readable, then read its ` +
        `agent-*.meta.json siblings' "agentType" field.`
    } else if (failureClass === 'meta-lookup') {
      summary = `PAIRING UNKNOWN — the observed agent's metadata was not found or was ambiguous`
      lookHere =
        ` To verify by hand: read the sibling agent-*.meta.json files under ${subagentsDir} ` +
        `and check the "agentType" field.`
    } else {
      summary = `could not establish the state of its declared observer '${observerName}'`
    }
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `[workflow-toolbox observer-pairing] ${subject} ${summary}.${lookHere} ` +
          `Delegated to wt-check-observer-pairing.mjs after spawn; checker verdict ${status}: ${reason}`,
      },
    }),
  )
}

runFailOpenHook('wt-observer-pairing-guard-hook.mjs', main)
