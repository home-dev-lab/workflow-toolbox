#!/usr/bin/env node
// wt-propagation-reminder-hook.mjs — a PostToolUse reminder on Write/Edit/MultiEdit: when a
// file that OTHER sessions or OTHER PEOPLE depend on is edited, ask the propagation question at
// the moment of the edit.
//
// WHY. A rule, a script, or a plugin file changing does not, by itself, tell anyone who is
// affected, when they get the change, or whether a shipped twin needs the same fix. Left
// unasked, that question tends to surface only when someone else notices the drift.
//
// ⚠ WHAT THIS DOES AND DOES NOT DO. The TRIGGER is mechanical: a path under a tooling or shipped
// directory was written. The REPORT is judgment and cannot be mechanised — no hook can know what
// changed for whom. So this fires the question; it never answers it, and its silence means
// "nothing matched the paths", never "nothing to propagate".
//
// ⚠ DELIBERATELY DOES NOT COVER `<config-dir>/rules/*.md`. The shipped `wt-rule-edit-horizon-
// hook.mjs` already speaks on ambient rule edits, and two reminders on one edit is how a
// reminder gets switched off. Its own path test matches only `rules` as a direct child of a
// `.claude`-named segment — so scripts and plugin files fall through it entirely, which is the
// gap this fills.
//
// ⚠ DEDUP, PER SESSION PER FILE — WHY. Measured 2026-08-16: 198 firings in one week from this
// hook alone, over only 72 distinct files (one file fired 11 times). Every individual firing was
// a legitimate answer to a legitimate trigger — the defect is the REPETITION, which is exactly
// the failure `mechanise-on-sight.md` names: a guard that fires identically on every edit becomes
// indistinguishable from tool chatter and stops being read, taking its real case with it. So the
// question is asked at most ONCE per (session, file) — the SAME sibling shape already used by
// `wt-shipped-twin-check-hook.mjs` (session-scoped seen-set on disk), narrowed to per-file here
// because two DIFFERENT shipped files raise two genuinely different questions.
//
// ⚠ FAILS OPEN, NEVER SILENTLY SUPPRESSES. Three boundaries, each load-bearing:
//   1. per FILE, never per session/directory — editing a second shipped file in the same session
//      still fires.
//   2. a NEW session (a different `session_id`) fires again — the dedup key is the session id,
//      never a wall-clock window and never a global store.
//   3. an UNRESOLVABLE session (no `session_id` in the payload, or state read/write fails) skips
//      dedup entirely and ALWAYS fires — a dedup mechanism that fails closed would turn a noisy
//      guard into a silent one, which is strictly worse than the problem it exists to fix.

import crypto from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { recordGuardEvent } from './lib/guard-journal.mjs'

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])

function readInput() {
  try {
    const raw = readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function editedPath(payload) {
  if (payload?.hook_event_name !== 'PostToolUse') return null
  if (!EDIT_TOOLS.has(payload?.tool_name)) return null
  const input = payload?.tool_input
  if (typeof input?.file_path === 'string' && input.file_path) return input.file_path
  return null
}

// Returns {audience, why} for a path we care about, or null.
function classify(file) {
  const segs = file.split(/[\\/]+/)

  // Ambient rules: owned by the shipped horizon hook. Stay silent so the two never double up.
  const rulesIdx = segs.lastIndexOf('rules')
  if (rulesIdx > 0 && /^\.claude(-.+)?$/.test(segs[rulesIdx - 1]) && file.endsWith('.md')) {
    return null
  }

  // Anything inside a `plugin/` directory is a SHIPPED artifact: it reaches other people.
  if (segs.includes('plugin')) {
    return {
      audience: 'ADOPTERS of the plugin, plus every session here that adopted it',
      why: 'a shipped artifact changed',
    }
  }

  // Machine tooling under a config dir: reaches every session on this machine.
  const scriptsIdx = segs.lastIndexOf('scripts')
  if (scriptsIdx > 0 && /^\.claude(-.+)?$/.test(segs[scriptsIdx - 1])) {
    return {
      audience: 'every session on this machine, including the ones running right now',
      why: 'machine tooling changed',
    }
  }

  // Agent definitions and skills: adopted copies, per project.
  if (segs.includes('agents') || segs.includes('skills')) {
    const cIdx = segs.findIndex((s) => /^\.claude(-.+)?$/.test(s))
    if (cIdx >= 0) {
      return {
        audience: 'sessions using this config dir or this project',
        why: 'an agent definition or skill changed',
      }
    }
  }

  return null
}

// Mirrors wt-shipped-twin-check-hook.mjs's safeTmpDir(): a project cwd can (rarely) coincide
// with os.tmpdir() on some setups; never let the dedup state land inside the repo being edited.
function looksLikeProjectDir(candidate, cwd = process.cwd()) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false
  try {
    if (candidate === cwd) return true
    const withSep = candidate.endsWith(path.sep) ? candidate : candidate + path.sep
    return cwd.startsWith(withSep)
  } catch {
    return false
  }
}

function safeTmpDir() {
  const candidate = os.tmpdir()
  if (looksLikeProjectDir(candidate)) {
    return process.platform === 'win32'
      ? (process.env['SystemRoot'] ? path.join(process.env['SystemRoot'], 'Temp') : 'C:\\Windows\\Temp')
      : '/tmp'
  }
  return candidate
}

function stateDir() {
  return process.env['WT_PROPAGATION_REMINDER_DIR'] || safeTmpDir()
}

// null when the session cannot be identified — the caller then skips dedup entirely (fires
// always) rather than guessing a fallback key that could dedup ACROSS unrelated sessions.
function sessionId(payload) {
  return typeof payload?.session_id === 'string' && payload.session_id ? payload.session_id : null
}

function stateFileFor(session) {
  const hash = crypto.createHash('sha1').update(session).digest('hex')
  return path.join(stateDir(), `propagation-seen-${hash}.json`)
}

function readSeen(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    return Array.isArray(parsed?.seen) ? parsed.seen.filter((v) => typeof v === 'string') : []
  } catch {
    return []
  }
}

function markSeen(filePath, seen) {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify({ seen }), 'utf8')
    return true
  } catch {
    // Best effort only — never break Write/Edit over dedup bookkeeping. Returning false tells
    // the caller the write did not stick, so it fires now instead of silently swallowing the
    // question: a dedup that can neither read nor persist its seen-set must fail OPEN.
    return false
  }
}

function alreadyWarned(payload, file) {
  const session = sessionId(payload)
  if (!session) return false // unresolvable session: never dedup, always fire

  const stateFile = stateFileFor(session)
  const seen = readSeen(stateFile)
  if (seen.includes(file)) return true

  // markSeen()'s own return value decides nothing here: whether or not the write stuck, THIS
  // firing has not yet been reported, so this call always returns false. A failed write simply
  // means readSeen() will come back empty again next time too — fires every time, fails open.
  markSeen(stateFile, [...seen, file])
  return false
}

function main() {
  const payload = readInput()
  const file = payload ? editedPath(payload) : null
  const hit = file ? classify(file) : null
  if (!hit) return
  if (alreadyWarned(payload, file)) return

  const lines = [
    `⚠ PROPAGATION — ${hit.why}: ${file}`,
    `  Reaching: ${hit.audience}.`,
    `  Before reporting this as done, state four things, because none of them is guessable:`,
    `    1. WHO gets it — this session, new sessions here, other config dirs, plugin adopters.`,
    `    2. WHEN — immediately (a script), at the next session start (a hook), at a restart OR a`,
    `       compaction (rule text), or only after an explicit adopt step (shipped rules/agents).`,
    `    3. WHAT CHANGES, before vs after, in one line each.`,
    `    4. WHETHER A SHIPPED TWIN needs the same fix now — and, on the same look, what that`,
    `       copy already has that this one lacks. Drift runs both ways.`,
    `  If a running session must restart to get it, say so plainly — nobody can infer it.`,
  ]
  recordGuardEvent({
    guard: 'wt-propagation-reminder-hook.mjs',
    decision: 'warned',
    class: 'propagation',
    reason: `${hit.why}: ${file}`,
  })
  // writeSync, not stdout.write: this process may exit before an async pipe write flushes.
  writeSync(1, lines.join('\n') + '\n')
}

runFailOpenHook('wt-propagation-reminder-hook.mjs', main)
