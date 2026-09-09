#!/usr/bin/env node
// wt-escalation-journal-hook — records authorization requests and warns when one was already granted.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { recordGuardEvent } from './lib/guard-journal.mjs'
import { findAuthorization, parseAuthorizations } from './lib/standing-authorizations.mjs'

const ESCALATION = /```[^\n]*\n\s*((?:J'autorise|I authorize)\b[^\n]*)\n```/i

function readInput() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}') } catch { return {} }
}

function outgoingText(input) {
  if (typeof input.last_assistant_message === 'string') return input.last_assistant_message
  if (typeof input.transcript_path !== 'string' || !existsSync(input.transcript_path)) return ''
  try { return readFileSync(input.transcript_path, 'utf8').slice(-262_144) } catch { return '' }
}

function main() {
  const input = readInput()
  if (input.hook_event_name && input.hook_event_name !== 'Stop') return
  const match = ESCALATION.exec(outgoingText(input))
  if (!match) return

  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd()
  let authorization = null
  try {
    const path = join(cwd, '.claude', 'AUTHORIZATIONS.md')
    if (existsSync(path)) authorization = findAuthorization(parseAuthorizations(readFileSync(path, 'utf8')), match[1])
  } catch {
    // An unreadable project file is an uncovered escalation, never a reason to interrupt a stop.
  }

  recordGuardEvent({
    guard: 'wt-escalation-journal-hook.mjs',
    decision: 'warned',
    class: authorization ? 'escalation:covered' : 'escalation:uncovered',
    reason: authorization ? authorization.act : 'no-standing-authorization',
    cwd,
    session: input.session_id,
    agent: input.agent_id,
  })

  if (authorization) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: `[for Claude, not the user] This escalation was already authorized: ${authorization.raw}`,
      },
    }))
  }
}

runFailOpenHook('wt-escalation-journal-hook.mjs', main)
