#!/usr/bin/env node
// wt-label-intent-producer-hook.mjs — PostToolUse hook that MECHANICALLY
// invokes toolkit/scripts/label-intent-lens.ts on a real, unfiltered board
// read, instead of relying on a skill's prose telling the model to run it.
//
// The detector was correct, tested, and shipped — and invoked by NOTHING
// except a "MANDATORY" line in plugin/skills/what-next/SKILL.md. Measured,
// fresh session, 2026-07-27: the anti-false-verdict half of that line held
// (the session correctly refused to write
// "zero label gap" without having run the lens), but the "run it" half did
// not reliably trigger the actual invocation — a text instruction can refuse
// a false claim, it cannot make an action happen. This hook is the mechanical
// half that text alone cannot be.
//
// WHY A PostToolUse HOOK ON mcp__planka__get_board, SAME SHAPE AS
// wt-actionable-snapshot-producer-hook.mjs: a hook is a plain node process
// with no MCP connection and no model — it cannot read the board itself. It
// reacts to a call the session already made. `/what-next`'s own Input 1 step
// already calls get_board (or an unfiltered find_cards) to read the backlog,
// so wiring here means the lens runs on every real /what-next pass with no
// separate gesture to forget. A project that never reads a Planka board
// never triggers this hook: safe to ship broadly.
//
// WHAT THIS HOOK DELIBERATELY DOES NOT DO:
//   - It never mutates a card, a label, or anything on the board — it only
//     runs a read-only script and relays its OWN printed verdict.
//   - It never reports "clean" on its own authority. A run that could not be
//     trusted (toolkit not vendored, tsx missing, timeout, unparsable
//     output) produces NO additionalContext at all — silence, never a
//     manufactured green. See runLabelIntentLens()'s `ran: false` branch.
//   - It stays SILENT when the lens ran and found nothing — a check that
//     speaks every time is noise, and noise is what got this MANDATORY skill
//     line ignored in the first place. Only actual findings/advisories
//     produce a notice.
//
// FAIL-OPEN: any exception anywhere in main() is caught by runFailOpenHook
// and turns into a traced stderr line, never a broken PostToolUse response —
// this hook must never be the reason the surrounding /what-next flow fails.

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { runLabelIntentLens } from './lib/label-intent-runner.mjs'

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {
    return {}
  }
}

function formatNotice({ boardId, findings, advisories, cards }) {
  return (
    `⚠ [workflow-toolbox label-intent lens] board ${boardId}: ${findings} finding(s), ` +
    `${advisories} advisory/advisories across ${cards} card(s) — a label trio was written in ` +
    'a card\'s own prose but never applied as a real label, or is ambiguous. Report this in ' +
    'your response; do NOT change any label yourself — a mechanical sweep produces candidates, ' +
    `never verdicts. Full detail: \`npx tsx toolkit/scripts/label-intent-lens.ts --board ${boardId}\`.`
  )
}

function main() {
  const input = readInput()
  if (input.hook_event_name && input.hook_event_name !== 'PostToolUse') return
  if (input.tool_name !== 'mcp__planka__get_board') return

  const boardId =
    input.tool_input && typeof input.tool_input === 'object' && typeof input.tool_input.boardId === 'string'
      ? input.tool_input.boardId
      : undefined
  if (!boardId) return

  const cwd = typeof input.cwd === 'string' && input.cwd ? resolve(input.cwd) : ''
  if (!cwd) return

  const toolkitDir = join(cwd, 'toolkit')

  const result = runLabelIntentLens({ toolkitDir, boardId, execFileImpl: execFileSync })
  if (!result.ran) return // toolkit not vendored, tsx missing, timeout, crash — silence, never a guess
  if (result.ok) return // the lens genuinely ran and found nothing — silence, never noise

  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: formatNotice({ boardId, ...result }),
    },
  }
  process.stdout.write(JSON.stringify(payload))
}

runFailOpenHook('wt-label-intent-producer-hook.mjs', main)
