#!/usr/bin/env node
// wt-stale-date-guard-hook.mjs — a PostToolUse hook that runs wt-stale-date-guard.mjs on the
// ONE file a Write/Edit just touched, so a stale operational deadline in a rule or a memory
// fiche is caught the moment it is written instead of being rediscovered later by a sweep
// nobody remembered to run.
//
// SCOPE, deliberately narrow. Only two kinds of surface carry OPERATIONAL deadlines that a
// stale-date guard has anything useful to say about: a rules dir (.claude/rules/) and a memory
// fiche (memory/*.md). Everything else — source code, docs, task-tracker exports, MEMORY.md
// itself (an INDEX, not a fiche, and indexes don't carry deadlines) — exits 0 immediately with
// no output. This is the same "self-disabling on files where the check has nothing to say"
// shape as this repo's other advisory PostToolUse guards (see wt-adopt-check-hook.mjs):
// a guard that talks on every write becomes a guard nobody reads.
//
// A hook cannot un-write a file that already landed — Write/Edit already happened by the time
// PostToolUse fires. So this NEVER tries to block (unlike wt-outbound-guard-hook.mjs's
// SubagentStop exit-2 path): it only surfaces the guard's own finding lines, advisory-only,
// modeled on wt-adopt-check-hook.mjs's PostToolUse contract (JSON hookSpecificOutput /
// additionalContext on a finding, nothing at all when clean).
//
// SHIPPED (plugin/bin/): registered on PostToolUse (matcher "Write|Edit") in
// plugin/.claude-plugin/plugin.json, alongside the file's own wt-stale-date-guard.mjs (the CLI
// this wraps) and plugin/bin/lib/stale-date-guard-core.mjs (the classification heuristic).

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { recordGuardEvent } from './lib/guard-journal.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GUARD = path.join(HERE, 'wt-stale-date-guard.mjs')

/** Read the hook's JSON payload from stdin; tolerate empty/malformed input. */
function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

// Operational-deadline-bearing surfaces only. `memory/MEMORY.md` is excluded explicitly: it is
// an index (one line per fact), never a fiche body, so it carries no deadline text of its own.
function isInScope(filePath) {
  if (typeof filePath !== 'string' || !filePath) return false
  const normalized = filePath.replace(/\\/g, '/') // Windows path separators, read on this platform too
  if (/\.claude\/rules\//.test(normalized)) return true
  if (/\/memory\/.+\.md$/.test(normalized) && !normalized.endsWith('/memory/MEMORY.md')) return true
  return false
}

function main() {
  const input = readInput()
  if (input.hook_event_name && input.hook_event_name !== 'PostToolUse') return
  if (input.tool_name && !/^(Write|Edit)$/.test(input.tool_name)) return

  const filePath = input?.tool_input?.file_path
  if (!isInScope(filePath)) return // self-disable: nothing to say about this file
  if (!fs.existsSync(GUARD)) return // never break a Write/Edit over a missing sibling script

  let res
  try {
    res = spawnSync(process.execPath, [GUARD, '--path', filePath], { encoding: 'utf8', timeout: 5_000 })
  } catch {
    return // a guard that breaks the edit it's advising on is worse than the finding it misses
  }
  if (!res || res.error) return
  // Exit 0 = clean (unknowns may exist but are not this hook's concern — the guard's own
  // --fail-on-unknown flag governs that, deliberately not passed here). Exit 2 = usage error
  // (should not happen on a single real file we just confirmed exists) — stay silent rather
  // than surface an internal-error line on every future write to the same surface.
  if (res.status !== 1) return

  const stdout = res.stdout || ''
  recordGuardEvent({
    guard: 'wt-stale-date-guard-hook.mjs',
    decision: 'warned',
    class: 'stale-date',
    reason: filePath,
  })
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `STALE OPERATIONAL DEADLINE in ${filePath} — a date-bearing directive has already ` +
          `expired. Fix the deadline or drop the clause before relying on this file:\n${stdout}`,
      },
    }),
  )
}

runFailOpenHook('wt-stale-date-guard-hook.mjs', main)
