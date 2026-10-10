#!/usr/bin/env node
// PreToolUse Skill guard: WARNING ONLY, never denies. Main-session invoked skill
// bodies are re-injected after every compaction; subagents do not incur that cost.
// Probation is counted from warning text in session transcripts, not a journal.
// Exit condition: 20 clean real-session firings (no false positives),
// then review for promotion. No automatic promotion; warning-only until reviewed.
// Unresolved/custom skill layouts and internal failures pass silently, exit 0.
// Character count means Unicode code points in the complete UTF-8 SKILL.md,
// including frontmatter (not byte count, token count or supplementary references).
// Above 4 × threshold bytes, report a no-read lower bound: floor(bytes / 4).
// For other plugins the hook cannot see their loaded --plugin-dir: an installed
// copy may win over that loaded copy. This limitation remains warning-only.
// No managed skills directory is specified in the available documentation evidence;
// enterprise skill resolution is unknown and is not guessed.
// Stalled network filesystem calls rely on the harness's 5 s fail-open timeout.
// Windows per-directory case sensitivity may cause a missed or extra warning.
import { readFileSync } from 'node:fs'
import { isInvokedDirectly } from './lib/host/entry-guard.mjs'
import { resolveSkillPath } from './lib/skill-path.mjs'
import { emitGuardNotice } from './lib/guard-journal.mjs'
import { readBoundedText, withSkillFile } from './lib/skill-file.mjs'

const DEFAULT_SKILL_SIZE_WARN_CHARS = 8000

function warningThreshold() {
  const raw = process.env.WT_SKILL_SIZE_WARN_CHARS?.trim() ?? ''
  const parsed = /^\d+$/.test(raw) ? Number(raw) : NaN
  return Number.isSafeInteger(parsed) ? parsed : DEFAULT_SKILL_SIZE_WARN_CHARS
}

function eligible(input) {
  return input?.hook_event_name === 'PreToolUse' && input.tool_name === 'Skill' && !Object.hasOwn(input, 'agent_id')
}
function characterCount(fd, stat, threshold) {
  if (stat.size <= threshold) return null
  if (stat.size > 4 * threshold) return { size: Math.floor(stat.size / 4), lowerBound: true }
  let size = 0
  for (const _character of readBoundedText(fd, stat.size)) size++
  return size > threshold ? { size, lowerBound: false } : null
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  if (!eligible(input)) return
  const skill = input.tool_input?.skill
  const threshold = warningThreshold()
  const inspect = (fd, stat) => characterCount(fd, stat, threshold)
  const source = resolveSkillPath(skill, { cwd: input.cwd, inspect })
  if (!source) return
  const count = Object.hasOwn(source, 'measurement') ? source.measurement : withSkillFile(source, inspect)
  if (!count) return
  const file = source.file
  const size = `${count.lowerBound ? 'at least ' : ''}${count.size}`
  const additionalContext = `WARNING [workflow-toolbox skill-size]: "${skill}" has ${size} characters in ${file} ` +
    `(threshold: ${threshold}). The harness re-injects every invoked skill's body after each compaction. ` +
    `In the main session, use Read on the needed section of ${file}, or delegate the work to a sub-agent.`
  emitGuardNotice({ payload: input, stdoutJson: { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } } })
}

// Intentionally no crash trace/output: this hook's internal errors must be silent.
if (isInvokedDirectly(import.meta.url)) {
  try { main() } catch { /* fail open */ }
}
