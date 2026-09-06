#!/usr/bin/env node
import fs from 'node:fs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { recordGuardEvent } from './lib/guard-journal.mjs'

function hasRouting(value) {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasRouting)
  return Object.entries(value).some(([key, item]) => key === 'models' || key === 'effort' || (key === 'perAgent' && typeof item === 'object' && item !== null && 'model' in item) || hasRouting(item))
}
function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  if (input.tool_name !== 'Workflow') return
  const ti = input.tool_input || {}
  const value = ti.args === undefined ? ti.script ?? ti.workflow ?? ti.text : ti.args
  const routed = typeof value === 'string' ? /\b(?:perAgent\s*\.\s*model|models\s*:|effort\s*:)/.test(value.replace(/```[\s\S]*?```|["'][^"'\n]*["']/g, ' ')) : hasRouting(value)
  if (routed) return
  recordGuardEvent({ guard: 'wt-workflow-model-guard-hook.mjs', decision: 'warned', class: 'workflow-model-inherited', reason: 'Workflow fan-out has no model routing', session: input.session_id, agent: input.agent_id })
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '[workflow-toolbox workflow-model] This Workflow declares no per-agent model, models, or effort routing; its fan-out will inherit the session model.' } }))
}
runFailOpenHook('wt-workflow-model-guard-hook.mjs', main)
