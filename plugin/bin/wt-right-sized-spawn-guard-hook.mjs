#!/usr/bin/env node
// Refuse the expensive ambient general-purpose agent unless the caller records why none of the
// purpose-built plugin agents applies. Hook errors must never prevent a legitimate spawn.

import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { recordGuardEvent } from './lib/guard-journal.mjs'
import { readStdinJson } from './lib/host/read-stdin-json.mjs'

const GUARD = 'wt-right-sized-spawn-guard-hook.mjs'
const GENERAL_PURPOSE_PREFIX = 'general-purpose because:'

function refusal() {
  return '[workflow-toolbox right-sized-spawn] Refused: general-purpose is the expensive session default. ' +
    'Use wt-implementer-sonnet for a well-specified test-first increment; ' +
    'wt-implementer-opus for implementation needing judgment; ' +
    'wt-reviewer for an adversarial read-only plan or diff review; or ' +
    'wt-chores for board/card work, CI-log triage, mechanical reads, and summaries. ' +
    'When none fits, create a dedicated agent, or re-issue this call with a prompt line ' +
    '`general-purpose because: <reason>`.'
}

function generalPurposeReason(prompt) {
  for (const line of prompt.split('\n')) {
    const normalized = line.trim()
    if (!normalized.toLowerCase().startsWith(GENERAL_PURPOSE_PREFIX)) continue
    const reason = normalized.slice(GENERAL_PURPOSE_PREFIX.length).trim()
    if (reason) return reason
  }
  return null
}

function main() {
  const input = readStdinJson()
  if (input.tool_name !== 'Agent') return

  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}
  const type = typeof toolInput.subagent_type === 'string' ? toolInput.subagent_type.trim() : ''
  const isDefault = !type || type === 'general-purpose'
  if (!isDefault) return

  const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : ''
  const reason = generalPurposeReason(prompt)
  if (reason) {
    recordGuardEvent({
      guard: GUARD,
      decision: 'silent',
      session: input.session_id,
      agent: input.agent_id,
      class: 'general-purpose-override',
      reason,
    })
    return
  }

  recordGuardEvent({
    guard: GUARD,
    decision: 'blocked',
    session: input.session_id,
    agent: input.agent_id,
    class: type ? 'general-purpose' : 'subagent-type-absent',
    reason: type ? 'general-purpose without reason' : 'subagent_type absent without reason',
  })
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: refusal(),
    },
  }))
}

runFailOpenHook(GUARD, main)
