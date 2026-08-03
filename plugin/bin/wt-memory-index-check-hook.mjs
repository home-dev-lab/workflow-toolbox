#!/usr/bin/env node
// wt-memory-index-check-hook.mjs — a SessionStart hook that runs wt-memory-index-check.mjs once
// per session against this project's knowledge-base store, so a silently-truncated index or an
// unreachable fiche is surfaced to the session that is about to RELY on it.
//
// WHY SessionStart and not PostToolUse-on-write. The probe costs ~130ms on a ~190-fiche store —
// negligible once, expensive on every write during a checkpoint that writes many fiches. More
// importantly the trigger matches the damage: an orphaned fiche hurts the NEXT session, the one
// that cannot see the fact. Checking as that session starts is the earliest moment the finding is
// actionable, not a compromise for cost.
//
// WHAT IT CATCHES, and both halves are silent failures by construction:
//   - an index over the harness's truncation threshold: entries past it stop existing for every
//     session, with no error and no visible truncation;
//   - a fiche on disk that no path reaches — neither a direct index line nor a link inside a note
//     the index points at. An unindexed fact does not exist, and nothing else reports it.
//
// SCOPE, deliberately narrow — this hook SELF-DISABLES rather than guessing:
//   - no derivable store path, or the directory does not exist  ⇒ exit 0, no output. A project
//     with no knowledge base must never inherit a check it cannot satisfy.
//   - the probe missing, unrunnable, or erroring                ⇒ exit 0, no output.
//   - the probe reporting clean (exit 0)                        ⇒ NO OUTPUT AT ALL.
// A check that speaks on the healthy case gets switched off, and takes the case it was built for
// with it. Silence here is the normal state; if this ever becomes chatty, that is a defect in IT.
//
// ⚠ It never blocks. SessionStart output is context, not a gate: the finding is for a human or a
// session to act on, and a memory-shape problem is never a reason to refuse to start.
//
// SHIPPED (plugin/bin/): registered on SessionStart in plugin/.claude-plugin/plugin.json,
// alongside the CLI it wraps (wt-memory-index-check.mjs).

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROBE = path.join(HERE, 'wt-memory-index-check.mjs')

/** Read the hook's JSON payload from stdin; tolerate empty/malformed input. */
function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

// The store lives under the ACTIVE config dir, keyed by a slug of the project root: every
// character outside [A-Za-z0-9-] becomes '-'. Derived, never hard-coded — a hard-coded path would
// silently check one project's store from inside another's session.
function storeDir(cwd) {
  if (!cwd) return null
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  const slug = String(cwd).replace(/[^A-Za-z0-9-]/g, '-')
  return path.join(configDir, 'projects', slug, 'memory')
}

function main() {
  const input = readInput()
  if (input.hook_event_name && input.hook_event_name !== 'SessionStart') return

  const store = storeDir(input.cwd || process.cwd())
  if (!store || !fs.existsSync(store)) return // no knowledge base here — nothing to say, ever
  if (!fs.existsSync(PROBE)) return // never fail a session start over a missing sibling script

  let res
  try {
    res = spawnSync(process.execPath, [PROBE, '--store', store], { encoding: 'utf8', timeout: 15_000 })
  } catch {
    return
  }
  if (!res || res.error) return
  // Exit 0 = clean. Exit 2 = usage error (bad path) — stay silent rather than emit an
  // internal-error line at the start of every future session on this project.
  if (res.status !== 1) return

  const stdout = (res.stdout || '').trim()
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext:
          `KNOWLEDGE-BASE INDEX PROBLEM — facts in this project's store are unreachable from its ` +
          `index, or the index is past the size at which the harness silently truncates it. ` +
          `Either way some recorded facts do not exist for this session, with nothing else to ` +
          `report it. Fix before relying on recall:\n${stdout}`,
      },
    }),
  )
}

try {
  main()
} catch {
  // A hook that can break a session start is not worth its output.
}
