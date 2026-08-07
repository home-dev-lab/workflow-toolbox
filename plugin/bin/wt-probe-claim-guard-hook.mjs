#!/usr/bin/env node
// wt-probe-claim-guard-hook.mjs — PreToolUse guard for the one outbound channel this repo can
// actually interpose on: SendMessage.
//
// WHY THIS SHAPE
// The hook sees the outbound message payload, but not the command/probe history that produced it.
// So the only honest mechanical contract here is: if a sender wants to emit a probe-derived fact
// through SendMessage, it carries a small provenance stanza in the message itself. The hook can
// then refuse a hollow stanza BEFORE the message leaves.
//
// WHY A PROPERTY, NOT A LIST
// The guard never tries to recognize every possible probe. It only validates the declared
// provenance block when present, and it asks for properties any probe-derived fact must carry:
// what was claimed, what exact set was scanned, what instrument produced it, and how self-scan
// was excluded (or a concrete explanation if it truly was not applicable).
//
// KNOWN LIMIT, NAMED PLAINLY
// An undeclared probe-derived claim still looks like ordinary text to this hook. That gap is a
// real limitation of this prototype, not hidden coverage.

import fs from 'node:fs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { recordGuardEvent } from './lib/guard-journal.mjs'

const HEADER = 'PROBE-CLAIM'
const REQUIRED_FIELDS = ['claim', 'set', 'instrument', 'self-exclusion']
const HOLLOW_SELF_EXCLUSION = /^(?:none|no|missing|unknown|n\/?a|na)$/i

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function parseProbeClaim(message) {
  if (typeof message !== 'string') return null
  const lines = message.split('\n')
  if ((lines[0] ?? '').trim() !== HEADER) return null

  const fields = {}
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim()) break
    const idx = line.indexOf(':')
    if (idx <= 0) {
      return { invalidLine: line.trim(), fields }
    }
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    fields[key] = value
  }

  return { fields }
}

function deny(reason) {
  recordGuardEvent({
    guard: 'wt-probe-claim-guard-hook.mjs',
    decision: 'blocked',
    reason,
  })
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
}

function main() {
  const input = readInput()
  if (input.tool_name !== 'SendMessage') return

  const parsed = parseProbeClaim(input.tool_input?.message)
  if (!parsed) return

  if (parsed.invalidLine) {
    deny(
      `[workflow-toolbox probe-claim] Refused: malformed ${HEADER} stanza. ` +
      `Each line before the first blank line must be "key: value". Bad line: ${JSON.stringify(parsed.invalidLine)}. ` +
      `Without a parseable provenance block, later readers cannot tell what probe fact is being claimed or how to re-check it, so this message cannot leave through SendMessage. ` +
      `Fix: rewrite the stanza in "key: value" form, then resend it.`
    )
    return
  }

  const missing = REQUIRED_FIELDS.filter((field) => {
    const value = parsed.fields[field]
    return typeof value !== 'string' || !value.trim()
  })
  if (missing.length > 0) {
    deny(
      `[workflow-toolbox probe-claim] Refused: ${HEADER} is missing required field(s): ${missing.join(', ')}. ` +
      `A probe-derived claim must carry the exact scanned set and the probe's self-exclusion before it is emittable; otherwise later readers cannot reconstruct what was scanned or whether the probe counted itself. ` +
      `Fix: add the missing field(s), then resend the message.`
    )
    return
  }

  if (HOLLOW_SELF_EXCLUSION.test(parsed.fields['self-exclusion'])) {
    deny(
      `[workflow-toolbox probe-claim] Refused: ${HEADER} declares a hollow self-exclusion ` +
      `(${JSON.stringify(parsed.fields['self-exclusion'])}). A probe that does not name a real self-exclusion can archive a false count by including its own shell/pid. ` +
      `Fix: state how the probe excluded its own pid/shell, or why self-exclusion was truly not applicable.`
    )
  }
}

runFailOpenHook('wt-probe-claim-guard-hook.mjs', main)
