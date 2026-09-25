#!/usr/bin/env node
import { applicableGroundingSources, boundedFamilyNames, humanPromptText, loadGroundingRegistry, readGroundingState, readHookPayload, transcriptContextKey, writeGroundingState } from './lib/grounding-sources.mjs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { recordGuardEvent } from './lib/guard-journal.mjs'
import { resolveWorkflowToolboxOption } from './lib/plugin-options.mjs'

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? Math.max(2, parsed) : fallback
}

function main() {
  const payload = readHookPayload()
  if (payload?.hook_event_name !== 'UserPromptSubmit') return
  if (!humanPromptText({ type: 'user', message: { role: 'user', content: String(payload.prompt || '') } })) return
  const session = payload.session_id || 'unknown'
  const contextKey = payload.transcript_path ? transcriptContextKey(payload.transcript_path) : 'initial'
  const prior = readGroundingState(session, 'prompt')
  const state = prior.contextKey === contextKey ? prior : { contextKey }
  const promptNumber = Number(state.promptNumber || 0) + 1
  const configured = process.env.CLAUDE_PLUGIN_OPTION_GROUNDING_PROMPT_COOLDOWN
    ?? resolveWorkflowToolboxOption('grounding_prompt_cooldown').value
  const cooldown = positiveInteger(configured, 5)
  const shouldFire = !state.lastPromptFired || promptNumber - state.lastPromptFired >= cooldown
  writeGroundingState(session, 'prompt', { ...state, promptNumber, ...(shouldFire ? { lastPromptFired: promptNumber } : {}) })
  if (!shouldFire) return

  const sources = applicableGroundingSources(loadGroundingRegistry({ cwd: payload.cwd }), String(payload.prompt || ''))
  const families = boundedFamilyNames(sources.map((entry) => ({ ...entry, family: entry.layer === 'project' ? `[project] ${entry.family}` : entry.family }))) || 'none registered; use judgment'
  const first = promptNumber === 1
  const text = first
    ? `Before settling checkable facts: state your prediction; ask which sources could confirm or refute it; treat any departure in either direction as a finding to explain. Applicable source families: ${families}.`
    : 'Grounding reminder: state the prediction, check sources that could confirm or refute it, and explain every departure.'
  recordGuardEvent({ guard: 'wt-grounding-prompt-hook.mjs', decision: 'silent', class: first ? 'first-context' : 'cooldown-reminder', cwd: payload.cwd, session })
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } })}\n`)
}

runFailOpenHook('wt-grounding-prompt-hook.mjs', main)
