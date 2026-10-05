#!/usr/bin/env node
import fs from 'node:fs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { recordGuardEvent } from './lib/guard-journal.mjs'

const SELF_VERIFICATION = /\b(?:verify|review|double-check|second\s+opinion\s+(?:on|of|about))\s+(?:[\w-]+\s+){0,3}my\s+(?:[\w-]+\s+){0,2}(?:work|code|changes|implementation|patch|diff|fix|claims|results|plan|design|proposal|analysis|report|tests?|draft|PRs?|pull\s+requests?|commits?|branch(?:es)?)\b/i
function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  if (input.tool_name !== 'Agent' || !input.agent_id) return
  const prompt = typeof input.tool_input?.prompt === 'string' ? input.tool_input.prompt.replace(/```[\s\S]*?```|["'][^"'\n]*["']/g, ' ') : ''
  if (!SELF_VERIFICATION.test(prompt)) return
  recordGuardEvent({ guard: 'wt-nested-spawn-guard-hook.mjs', decision: 'warned', class: 'nested-self-verify', reason: 'subagent spawned verifier for own work', session: input.session_id, agent: input.agent_id })
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '[workflow-toolbox nested-spawn] A delegate is spawning verification of its own work. Route verification to the owning session to preserve independence.' } }))
}
runFailOpenHook('wt-nested-spawn-guard-hook.mjs', main)
