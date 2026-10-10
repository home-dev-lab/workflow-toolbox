#!/usr/bin/env node
// PreToolUse Skill guard: WARNING ONLY, never denies. Main-session invoked skill
// bodies are re-injected after every compaction; subagents do not incur that cost.
// Probation is counted from warning text in session transcripts, not a journal.
// Exit condition: 20 clean real-session firings (no false positives),
// then review for promotion. No automatic promotion; warning-only until reviewed.
// Unresolved/custom skill layouts and internal failures pass silently, exit 0.
// Character count means Unicode code points in the complete UTF-8 SKILL.md,
// including frontmatter (not byte count, token count or supplementary references).
// For other plugins the hook cannot see their loaded --plugin-dir: an installed
// copy may win over that loaded copy. This limitation remains warning-only.
import { readFileSync, statSync } from 'node:fs'
import { isInvokedDirectly } from './lib/host/entry-guard.mjs'
import { resolveSkillPath } from './lib/skill-path.mjs'
import { emitGuardNotice } from './lib/guard-journal.mjs'

const DEFAULT_SKILL_SIZE_WARN_CHARS = 8000

function warningThreshold() {
  const raw = process.env.WT_SKILL_SIZE_WARN_CHARS?.trim() ?? ''
  const parsed = /^\d+$/.test(raw) ? Number(raw) : NaN
  return Number.isSafeInteger(parsed) ? parsed : DEFAULT_SKILL_SIZE_WARN_CHARS
}

function eligible(input) {
  return input?.hook_event_name === 'PreToolUse' && input.tool_name === 'Skill' && !Object.hasOwn(input, 'agent_id')
}
function characterCount(file, threshold) {
  const stat = statSync(file)
  if (!stat.isFile() || stat.size <= threshold) return 0
  let size = 0
  for (const _character of readFileSync(file, 'utf8')) size++
  return size
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  if (!eligible(input)) return
  const skill = input.tool_input?.skill
  const file = resolveSkillPath(skill, { cwd: input.cwd })
  if (!file) return
  const threshold = warningThreshold()
  const size = characterCount(file, threshold)
  if (size <= threshold) return
  const additionalContext = `WARNING [workflow-toolbox skill-size]: "${skill}" has ${size} characters in ${file} ` +
    `(threshold: ${threshold}). The harness re-injects every invoked skill's body after each compaction. ` +
    `In the main session, use Read on the needed section of ${file}, or delegate the work to a sub-agent.`
  emitGuardNotice({ payload: input, stdoutJson: { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } } })
}

// Intentionally no crash trace/output: this hook's internal errors must be silent.
if (isInvokedDirectly(import.meta.url)) {
  try { main() } catch { /* fail open */ }
}
