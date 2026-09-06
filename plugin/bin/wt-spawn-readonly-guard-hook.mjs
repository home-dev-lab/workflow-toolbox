#!/usr/bin/env node
import fs from 'node:fs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { recordGuardEvent } from './lib/guard-journal.mjs'
import { resolveAgentTypeTools } from './lib/agent-type-tools.mjs'

const WRITERS = /^(Bash|Write|Edit)$|^mcp__/i
function textWithoutQuotes(text) { return text.replace(/```[\s\S]*?```|["'][^"'\n]*["']/g, ' ') }
function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  if (input.tool_name !== 'Agent') return
  const type = input.tool_input?.subagent_type?.trim()
  const prompt = typeof input.tool_input?.prompt === 'string' ? textWithoutQuotes(input.tool_input.prompt) : ''
  if (!type || !/\b(read-only|do not modify|investigate only)\b/i.test(prompt)) return
  const resolved = resolveAgentTypeTools(type, input.cwd || '')
  if (!resolved.resolved) return recordGuardEvent({ guard: 'wt-spawn-readonly-guard-hook.mjs', decision: 'silent', class: 'type-unresolved', reason: type, session: input.session_id, agent: input.agent_id })
  const cls = resolved.tools === null ? 'spawn-readonly-no-allowlist' : resolved.tools.includes('*') || resolved.tools.some((tool) => WRITERS.test(tool)) ? 'spawn-readonly-wide' : null
  if (!cls) return
  recordGuardEvent({ guard: 'wt-spawn-readonly-guard-hook.mjs', decision: 'warned', class: cls, reason: `${type} read-only spawn has ${resolved.tools === null ? 'no allowlist' : 'writer tools'}`, session: input.session_id, agent: input.agent_id })
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `[workflow-toolbox spawn-readonly] ${type} is briefed read-only but its tool allow-list is ${cls === 'spawn-readonly-no-allowlist' ? 'missing' : 'wide'}. Use a narrow read-only type if this boundary matters.` } }))
}
runFailOpenHook('wt-spawn-readonly-guard-hook.mjs', main)
