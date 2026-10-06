#!/usr/bin/env node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runFailOpenHookAsync } from './lib/fail-open-trace.mjs'
import { recordGuardEvent } from './lib/guard-journal.mjs'
import { isInvokedDirectly } from './lib/host/entry-guard.mjs'
import { readCurrentRuleText, writeRuleDecision } from './lib/host/rule-narrative-process.mjs'
import { addedLines, detectNarrative } from './lib/rule-narrative-detect.mjs'
import { renderNarrativeMessage, splitNarrative, splitTimeoutMs } from './lib/rule-narrative-split.mjs'

const SELF = 'wt-rule-convention-guard-hook.mjs'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
// Added-line multiset subtraction ignores reordering and fence/comment removal.
// HISTORY retains original replacement line numbers; the model is advisory only.

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

// Accept BOTH slash styles for the leading `~` regardless of host platform: a payload's
// file_path is produced by the tool call, not typed at a platform-native shell, so a
// forward-slash tilde path can legitimately reach us even on Windows.
function normalizeFile(file, cwd) {
  const expanded = expandHome(file)
  if (path.isAbsolute(expanded)) return path.normalize(expanded)
  if (typeof cwd === 'string' && cwd) return path.resolve(cwd, expanded)
  return null
}

function expandHome(file) {
  if (file === '~') return os.homedir()
  if (file.startsWith('~/') || file.startsWith('~\\')) return path.join(os.homedir(), file.slice(2))
  return file
}

function fileFromPayload(payload) {
  if (payload?.hook_event_name !== 'PreToolUse' || !EDIT_TOOLS.has(payload?.tool_name)) return null
  const input = payload?.tool_input
  if (typeof input?.file_path === 'string' && input.file_path) return input.file_path
  return firstEditFile(input)
}

function firstEditFile(input) {
  const firstEdit = Array.isArray(input?.edits) ? input.edits[0] : null
  return typeof firstEdit?.file_path === 'string' && firstEdit.file_path
    ? firstEdit.file_path
    : null
}

function isRuleFile(file) {
  if (!file.endsWith('.md')) return false
  const segments = file.split(/[\\/]+/).filter(Boolean)
  const rulesIndex = segments.lastIndexOf('rules')
  if (rulesIndex === -1) return false
  const tailLength = segments.length - rulesIndex - 1
  return tailLength === 1 || tailLength === 2
}

function isAgentDefinition(file) {
  if (!file.endsWith('.md')) return false
  const segments = file.split(/[\\/]+/).filter(Boolean)
  const parent = segments.at(-2)
  return parent === 'agents' || parent === 'agent-templates'
}

function emitDecision(payload, findings, lines, result, deny) {
  const reason = renderNarrativeMessage({ findings, lines, result, file: fileFromPayload(payload), deny })
  recordGuardEvent({ guard: SELF, decision: deny ? 'blocked' : 'warned',
    class: [...new Set(findings.map((finding) => finding.detector))].sort().join(','),
    session: payload.session_id, agent: payload.agent_id, cwd: payload.cwd, reason })
  const output = { hookEventName: 'PreToolUse', ...(deny
    ? { permissionDecision: 'deny', permissionDecisionReason: reason }
    : { additionalContext: reason }) }
  writeRuleDecision(output)
}

// The injected split is a callable seam for tests/importers, never an environment
// switch: direct production invocation always uses splitNarrative.
export async function enrichDecision(payload, findings, lines, split = splitNarrative) {
  const deny = findings.some((finding) => finding.tier === 'deny')
  const timeoutMs = splitTimeoutMs(process.env.WT_RULE_NARRATIVE_SPLIT_TIMEOUT_MS)
  const controller = new AbortController()
  let emitted = false
  const emit = (result) => {
    if (emitted) return
    emitted = true
    emitDecision(payload, findings, lines, result, deny)
  }
  const watchdog = setTimeout(() => {
    controller.abort()
    emit({ ok: false, reason: 'split deadline exceeded' })
    process.exit(0)
  }, timeoutMs)
  try { emit(await split({ lines, findings, timeoutMs, signal: controller.signal })) }
  finally { clearTimeout(watchdog) }
}

async function main() {
  if (process.env.WT_RULE_NARRATIVE_SPLIT_CHILD === '1') return
  const payload = readInput()
  if (!payload) return

  const sourceFile = fileFromPayload(payload)
  if (!sourceFile) return
  const file = normalizeFile(sourceFile, payload.cwd)
  if (!file || (!isRuleFile(file) && !isAgentDefinition(file))) return
  const lines = addedLines({ tool: payload.tool_name, input: payload.tool_input,
    currentText: readCurrentRuleText(file, payload.tool_name) })
  const findings = detectNarrative(lines)
  if (findings.length) await enrichDecision(payload, findings, lines)
}

if (isInvokedDirectly(import.meta.url)) await runFailOpenHookAsync(SELF, main)
