#!/usr/bin/env node
import { boundedFamilyNames, detectedMcpServerNames, groundingConfigDir, loadGroundingRegistry, outboundClaimTool, readGroundingState, readHookPayload, retryKey, transcriptGroundingStatus, writeGroundingState } from './lib/grounding-sources.mjs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { recordGuardEvent } from './lib/guard-journal.mjs'
import { resolveWorkflowToolboxOption } from './lib/plugin-options.mjs'

const GUARD = 'wt-grounding-pre-send-hook.mjs'

function configured(key, envKey) {
  return process.env[envKey] ?? resolveWorkflowToolboxOption(key).value
}

function mode(value) {
  if (value === true || ['1', 'true', 'refuse'].includes(String(value).trim().toLowerCase())) return 'refuse'
  if (value === false || ['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase())) return 'off'
  return 'observe'
}

function messageLength(payload) {
  const input = payload?.tool_input
  if (!input || typeof input !== 'object') return 0
  const value = input.message ?? input.text ?? input.body ?? input.comment ?? input.content ?? ''
  return typeof value === 'string' ? value.length : JSON.stringify(value).length
}

function journal(payload, classification, sourceQueried, evidence = [], groundingMode = 'observe') {
  recordGuardEvent({
    guard: GUARD,
    decision: classification === 'refused' ? 'blocked' : 'silent',
    class: classification,
    reason: evidence.length > 0 ? evidence.join(',') : 'none',
    cwd: payload.cwd,
    session: payload.session_id,
    agent: payload.agent_id,
    evidence: { queried: String(sourceQueried), message_len: messageLength(payload), evidence_count: evidence.length, grounding_mode: groundingMode },
  })
}

function main() {
  const payload = readHookPayload()
  const outboundPatterns = configured('grounding_outbound_tools', 'CLAUDE_PLUGIN_OPTION_GROUNDING_OUTBOUND_TOOLS')
  if (payload?.hook_event_name !== 'PreToolUse' || !outboundClaimTool(payload, outboundPatterns)) return
  const checkMode = mode(configured('grounding_pre_send', 'CLAUDE_PLUGIN_OPTION_GROUNDING_PRE_SEND'))
  if (checkMode === 'off') {
    journal(payload, 'off', 'unknown', [], checkMode)
    return
  }
  const entries = loadGroundingRegistry({ cwd: payload.cwd })
  const transcriptPath = payload.agent_id ? payload.agent_transcript_path : payload.transcript_path
  if (!transcriptPath) {
    journal(payload, 'passed-unknown', 'unknown', [], checkMode)
    return
  }
  const installedMcpNames = detectedMcpServerNames(groundingConfigDir(), { cwd: payload.cwd })
  const status = transcriptGroundingStatus(transcriptPath, entries, { installedMcpNames })
  if (status.sourceQueried === true || status.sourceQueried === 'unknown') {
    journal(payload, status.sourceQueried === true ? 'passed-grounded' : 'passed-unknown', status.sourceQueried, status.evidence, checkMode)
    return
  }

  if (checkMode === 'observe') {
    journal(payload, 'would-refuse', false, [], checkMode)
    return
  }

  const session = payload.session_id || 'unknown'
  const agent = payload.agent_id || 'main'
  const state = readGroundingState(session, agent)
  const key = retryKey(payload, status.lastUserKey)
  const refusedKeys = Array.isArray(state.refusedKeys) ? state.refusedKeys : []
  if (refusedKeys.includes(key)) {
    journal(payload, 'passed-retry', false, [], checkMode)
    return
  }
  writeGroundingState(session, agent, { ...state, refusedKeys: [...refusedKeys, key].slice(-32) })
  journal(payload, 'refused', false, [], checkMode)
  const families = boundedFamilyNames(entries) || 'none registered; use built-in reads and judgment'
  const reason = `Ground the outbound claim first: what is your prediction, which sources could confirm or refute it, and what departure in either direction needs explaining? Countable families: built-in Read/Grep/Glob/LSP; registered MCP reads; registered shell recipes; ${families}. No grounding query appears since the last human message. This exact retry will pass.`
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`)
}

runFailOpenHook('wt-grounding-pre-send-hook.mjs', main)
