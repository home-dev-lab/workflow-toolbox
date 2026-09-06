#!/usr/bin/env node
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { invokes } from './lib/command-invocation.mjs'
import { checkPluginVersionAlignment } from './lib/plugin-version-alignment.mjs'
import { emitGuardNotice, recordGuardEvent } from './lib/guard-journal.mjs'

const GIT_COMMIT = /^git\s+(?:-C\s+\S+\s+)?commit\b(?!-)/

function repoRoot(cwd) {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash' || input.agent_id) return
  if (!invokes(input.tool_input?.command, GIT_COMMIT)) return
  const root = repoRoot(input.cwd || process.cwd())
  const result = checkPluginVersionAlignment(root)
  if (result.status !== 'diverged') return
  recordGuardEvent({ guard: 'wt-version-guard-hook.mjs', decision: 'blocked', class: 'plugin-version-diverged', reason: result.remedy, cwd: root, session: input.session_id, agent: input.agent_id })
  emitGuardNotice({ payload: input, stdoutJson: { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: result.remedy } } })
}

runFailOpenHook('wt-version-guard-hook.mjs', main)
