#!/usr/bin/env node
// The hook process is the writer. Done admits subagents; other default recorders admit main only.
// A fleet worker cannot be reliably distinguished from main by hook stdin; no provenance claim
// stronger than that signal is made. HTTP/script board mutations outside tools are not observable.
// Stop is WARN-ONLY probation: the owner labels the first 20 live firings true/false from the
// transcript and outcomes before promoting the check or correcting its matcher. No hook networks.
import path from 'node:path'
import * as io from './lib/host/work-journal-io.mjs'
import { isInvokedDirectly } from './lib/host/entry-guard.mjs'
import { resolveJournal } from './lib/work-journal.mjs'
import { hasRecorderCandidate, loadRecorders, matchedRecorders, observableTool } from './lib/work-journal-recorders.mjs'
import { preTool, postTool } from './lib/work-journal-hook-core.mjs'
import { sessionStart, stopCheck } from './lib/work-journal-lifecycle.mjs'

const isToolEvent = (event) => event === 'PreToolUse' || event === 'PostToolUse'
const journalRoot = (input, env) => env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()
function dispatchJournalHook(ctx, input, config, event) {
  if (event === 'SessionStart') return sessionStart(ctx, input, config)
  if (event === 'Stop') return stopCheck(ctx, input, config)
  const matches = matchedRecorders(config, input, ctx)
  if (!matches.length) return ''
  if (event === 'PreToolUse') { preTool(ctx, input, matches); return '' }
  return postTool(ctx, input, matches).map((message) => `LOUD: work journal: ${message}`).join('\n')
}
export function runJournalHook(input, env = process.env) {
  const event = input.hook_event_name
  if (!['PreToolUse', 'PostToolUse', 'SessionStart', 'Stop'].includes(event)) return ''
  if (isToolEvent(event) && !observableTool(input)) return ''
  const root = journalRoot(input, env)
  if (isToolEvent(event) && !hasRecorderCandidate(input, root)) return ''
  const config = loadRecorders(path.resolve(root))
  const matches = matchedRecorders(config, input)
  if (isToolEvent(event) && !matches.length) return config.warnings.map((warning) => `LOUD: ${warning}`).join('\n')
  const ctx = resolveJournal(input, env)
  return dispatchJournalHook(ctx, input, config, event)
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    const raw = io.read(0)
    const input = raw ? JSON.parse(raw) : {}
    const context = runJournalHook(input)
    if (context) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: context } }))
  } catch (error) { console.error(`[wt] LOUD: work journal: ${error.message}`) }
}
