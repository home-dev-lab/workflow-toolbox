#!/usr/bin/env node
// PreToolUse Skill guard: WARNING ONLY, never denies. Main-session invoked skill
// bodies are re-injected after every compaction; subagents do not incur that cost.
// Probation exit condition: 20 clean real-session firings (no false positives),
// then review for promotion. No automatic promotion; warning-only until reviewed.
// Unresolved/custom skill layouts and internal failures pass silently, exit 0.
// Character count means Unicode code points in the complete UTF-8 SKILL.md,
// including frontmatter (not byte count, token count or supplementary references).
import { readFileSync } from 'node:fs'
import { isInvokedDirectly } from './lib/host/entry-guard.mjs'
import { resolveSkillPath } from './lib/skill-path.mjs'
import { emitGuardNotice, recordGuardEvent } from './lib/guard-journal.mjs'

const DEFAULT_SKILL_SIZE_WARN_CHARS = 8000
const GUARD = 'wt-skill-size-guard-hook.mjs'

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  if (input?.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Skill') return
  if (Object.hasOwn(input, 'agent_id')) return
  const skill = input.tool_input?.skill
  const file = resolveSkillPath(skill, { cwd: input.cwd })
  if (!file) {
    recordGuardEvent({ guard: GUARD, decision: 'silent', class: 'skill-unresolved', session: input.session_id, cwd: input.cwd }, { quiet: true })
    return
  }
  const raw = process.env.WT_SKILL_SIZE_WARN_CHARS?.trim() ?? ''
  const parsed = /^\d+$/.test(raw) ? Number(raw) : NaN
  const threshold = Number.isSafeInteger(parsed) ? parsed : DEFAULT_SKILL_SIZE_WARN_CHARS
  const size = Array.from(readFileSync(file, 'utf8')).length
  if (size <= threshold) return
  const additionalContext = `WARNING [workflow-toolbox skill-size]: "${skill}" has ${size} characters in ${file} ` +
    `(threshold: ${threshold}). The harness re-injects every invoked skill's body after each compaction. ` +
    `In the main session, use Read on the needed section of ${file}, or delegate the work to a sub-agent.`
  recordGuardEvent({ guard: GUARD, decision: 'warned', class: 'large-main-skill', session: input.session_id,
    cwd: input.cwd, evidence: { characters: size, threshold } }, { quiet: true })
  emitGuardNotice({ payload: input, stdoutJson: { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } } })
}

// Intentionally no crash trace/output: this hook's internal errors must be silent.
if (isInvokedDirectly(import.meta.url)) {
  try { main() } catch { /* fail open */ }
}
