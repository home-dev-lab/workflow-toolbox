#!/usr/bin/env node
import fs from 'node:fs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { recordGuardEvent } from './lib/guard-journal.mjs'

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  if (input.tool_name !== 'Agent' || !input.agent_id) return
  const prompt = typeof input.tool_input?.prompt === 'string' ? input.tool_input.prompt.replace(/```[\s\S]*?```|["'][^"'\n]*["']/g, ' ') : ''
  if (!/\b(verify|review my|double-check|second opinion)\b/i.test(prompt) || !/\b(my|own)\b/i.test(prompt)) return
  recordGuardEvent({ guard: 'wt-nested-spawn-guard-hook.mjs', decision: 'warned', class: 'nested-self-verify', reason: 'subagent spawned verifier for own work', session: input.session_id, agent: input.agent_id })
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '[workflow-toolbox nested-spawn] A delegate is spawning verification of its own work. Route verification to the owning session to preserve independence.' } }))
}
runFailOpenHook('wt-nested-spawn-guard-hook.mjs', main)
