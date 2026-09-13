#!/usr/bin/env node
import fs from 'node:fs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { recordGuardEvent } from './lib/guard-journal.mjs'

const REFUSAL = '[workflow-toolbox workflow-model] Refused: Workflow launch args must include a non-empty string at `args.perAgent.model` so unnamed roles do not inherit the session model. Add `"perAgent":{"model":"<model>"}` under args. For `wt-observe launch` only, pass `--allow-inherited-model` to accept inheritance explicitly.'

function hasPerAgentModel(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    value.perAgent !== null && typeof value.perAgent === 'object' && !Array.isArray(value.perAgent) &&
    typeof value.perAgent.model === 'string' && value.perAgent.model.trim().length > 0
}
function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  if (input.tool_name !== 'Workflow') return
  if (hasPerAgentModel(input.tool_input?.args)) return
  recordGuardEvent({ guard: 'wt-workflow-model-guard-hook.mjs', decision: 'blocked', class: 'workflow-model-inherited', reason: 'Workflow args have no perAgent.model', session: input.session_id, agent: input.agent_id })
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REFUSAL } }))
}
runFailOpenHook('wt-workflow-model-guard-hook.mjs', main)
