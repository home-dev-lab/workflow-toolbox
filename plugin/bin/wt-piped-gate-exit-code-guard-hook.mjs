#!/usr/bin/env node
// wt-piped-gate-exit-code-guard-hook.mjs — a PreToolUse Bash guard that warns when a control gate
// is piped and the pipeline's `$?` is then read. Without `pipefail`, `$?` belongs to the final
// pipeline element, so `pnpm test | tail -5; echo $?` can report tail's success as a green suite.
//
// This deliberately reasons about a bounded shell string, not a shell AST. It therefore does not
// cover separate Bash calls, gate status read from a file the gate writes itself, `--record`
// wrappers, multi-line arguments split at newlines, or pipelines hidden in command substitutions.
// It intentionally stays silent for `set -o pipefail`, zsh's `$pipestatus`, and any pipeline
// whose status is not read. It may warn on quoted prose that happens to contain this exact shape;
// warn-only is the safe posture for that raw-string limitation.

import { readFileSync } from 'node:fs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { emitGuardNotice, recordGuardEvent } from './lib/guard-journal.mjs'

const GUARD = 'wt-piped-gate-exit-code-guard-hook.mjs'
const PLAIN_PIPE = /(?<!\|)\|(?!\||&)/
const STATUS_READ = /\$\?/
const GATE_COMMAND =
  /\b(?:npm|pnpm|yarn|bun|bunx)\s+(?:run\s+)?(?:test|build|lint|typecheck|check|tsc|install|audit)\b|\btsc\b|\bpytest\b|\bjest\b|\bvitest\b|\beslint\b|\bruff\b|\bmypy\b|\bpyright\b|\bcargo\s+(?:test|build|clippy|check)\b|\bgo\s+(?:test|build|vet)\b|\bmake\s+(?:test|build|check|lint)\b|\bgradlew?\b|\bmvn\b|\bgit\s+(?:merge|rebase|push|cherry-pick|apply|am|revert)\b|\bdocker\s+build\b|\bterraform\s+(?:plan|apply)\b/

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8')) || {}
  } catch {
    return {}
  }
}

// A nested `$(...)` can contain a pipe used only to build an argument, never a pipeline whose
// status is read by the surrounding command. Depth counting avoids exposing nested substitutions.
function maskSubstitutions(command) {
  let output = ''
  let depth = 0
  for (let i = 0; i < command.length; i++) {
    if (command[i] === '$' && command[i + 1] === '(') {
      depth++
      output += '$('
      i++
      continue
    }
    if (depth > 0) {
      if (command[i] === '(') depth++
      else if (command[i] === ')') {
        depth--
        if (depth === 0) output += ')'
      }
      continue
    }
    output += command[i]
  }
  return output
}

function readsPipedGateStatus(command) {
  if (/pipefail/.test(command) || /PIPESTATUS|\$pipestatus/i.test(command)) return false
  const statements = maskSubstitutions(command).split(/[;\n]|&&|\|\|/)
  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i]
    if (!PLAIN_PIPE.test(statement) || !GATE_COMMAND.test(statement)) continue
    const pipeIndex = statement.search(PLAIN_PIPE)
    if (STATUS_READ.test(statement.slice(pipeIndex))) return true
    if (i + 1 < statements.length && STATUS_READ.test(statements[i + 1])) return true
  }
  return false
}

function main() {
  const input = readInput()
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') return
  const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : ''
  if (!command || !readsPipedGateStatus(command)) return

  recordGuardEvent({
    guard: GUARD,
    decision: 'warned',
    class: 'piped-gate-exit-code',
    session: input.session_id,
    agent: input.agent_id,
    evidence: { status: 'dollar-question' },
  })
  emitGuardNotice({
    payload: input,
    stdoutJson: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext:
          '[workflow-toolbox piped-gate guard] WARNING (not blocked): this control gate is piped, then `$?` is read. Without `set -o pipefail`, that is the LAST pipeline element\'s status, so a failing gate can report success. Capture the gate directly instead: `command > file; echo EXIT=$? >> file`, then read `file`. On zsh, use `${pipestatus[1]}` when you genuinely need the first pipeline stage\'s status.',
      },
    },
  })
}

runFailOpenHook(GUARD, main)
