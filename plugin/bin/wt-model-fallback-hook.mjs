#!/usr/bin/env node
import path from 'node:path'
import { analyseTranscript, modelWarnings, requestedFromMeta } from './lib/model-fallback-core.mjs'
import { expandHome, readStdin } from './lib/host/model-fallback-files.mjs'

function fallbackTargets(file) {
  return file ? analyseTranscript(file, { targetsOnly: true }).fallbacks : []
}

function run(payload) {
  const parent = expandHome(payload.transcript_path)
  if (payload.hook_event_name === 'SubagentStop') {
    const file = expandHome(payload.agent_transcript_path)
    if (!file || !/^agent-[A-Za-z0-9_-]+\.jsonl$/.test(path.basename(file))) return
    const requested = requestedFromMeta(file)
    const result = analyseTranscript(file, { requested })
    if (result.unknown) return
    const warnings = modelWarnings(result, { name: `agent ${payload.agent_id ?? path.basename(file, '.jsonl')}`, fallbacks: [...result.fallbacks, ...fallbackTargets(parent)] })
    if (warnings.length) process.stdout.write(`${JSON.stringify({ systemMessage: warnings.join(' ') })}\n`)
  } else if (payload.hook_event_name === 'PostToolUse' && ['Agent', 'Task'].includes(payload.tool_name)) {
    const served = payload.tool_response?.resolvedModel
    if (!served) return
    const requested = payload.tool_input?.model ?? null
    const tracker = { requested, runs: [{ model: served.replace(/\[\d+m\]$/, ''), calls: 1, time: new Date().toISOString() }], fallbacks: [], refusals: [], unknown: false, env: process.env }
    const warnings = modelWarnings(tracker, { name: `agent ${payload.tool_response?.agentId ?? payload.agent_id ?? 'spawn'}`, fallbacks: fallbackTargets(parent) })
    if (warnings.length) {
      const notice = warnings.join(' ')
      process.stdout.write(`${JSON.stringify({ systemMessage: notice, hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notice } })}\n`)
    }
  }
}

try { run(JSON.parse(readStdin())) } catch { /* fail open: transcripts may lag hook delivery */ }
