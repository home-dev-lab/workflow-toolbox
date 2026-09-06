#!/usr/bin/env node
import fs from 'node:fs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { recordGuardEvent } from './lib/guard-journal.mjs'
import { resolveAgentTypeTools } from './lib/agent-type-tools.mjs'

function textWithoutQuotes(text) { return text.replace(/```[\s\S]*?```|["'][^"'\n]*["']/g, ' ') }
function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  if (input.tool_name !== 'Agent') return
  const type = input.tool_input?.subagent_type?.trim()
  const prompt = typeof input.tool_input?.prompt === 'string' ? textWithoutQuotes(input.tool_input.prompt) : ''
  if (!type || !/\b(report|reply|send|message me|when done)\b/i.test(prompt)) return
  const resolved = resolveAgentTypeTools(type, input.cwd || '')
  if (!resolved.resolved) return recordGuardEvent({ guard: 'wt-spawn-channel-guard-hook.mjs', decision: 'silent', class: 'type-unresolved', reason: type, session: input.session_id, agent: input.agent_id })
  if (resolved.tools?.some((tool) => tool === 'SendMessage' || tool === '*')) return
  recordGuardEvent({ guard: 'wt-spawn-channel-guard-hook.mjs', decision: 'warned', class: 'spawn-channel-missing', reason: `${type} has no SendMessage`, session: input.session_id, agent: input.agent_id })
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `[workflow-toolbox spawn-channel] ${type} has no SendMessage tool, but this brief asks it to report back. Add SendMessage or make its final response the deliverable.` } }))
}
runFailOpenHook('wt-spawn-channel-guard-hook.mjs', main)
