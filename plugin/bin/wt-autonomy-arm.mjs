#!/usr/bin/env node
// Declares — or withdraws — an autonomous mandate for THIS session.
//
// WHY THIS EXISTS AS A SEPARATE TOOL. `wt-autonomy-watch.mjs` refuses to wake a session that has
// not declared a mandate, deliberately: a watcher that woke every session, including ordinary
// interactive ones, would be noise, and a noisy watcher gets switched off, taking its real case
// with it. That gate needs something to write the marker it reads — and until this file existed,
// nothing shipped did. The watcher could name what was missing and no adopter had any way to
// supply it: a diagnosis with no remedy.
//
// ⚠ IT IS NOT A HOOK, AND THAT IS THE DESIGN. A hook stamping the marker at session start would
// declare a mandate for every session whether or not anyone wanted one — reintroducing exactly the
// noise the watcher's gate exists to prevent. Declaring a mandate is an ACT; this is the act.
//
// ⚠ THE MARKER IS PER SESSION, so it does not survive a restart. That is a real limitation and it
// is stated rather than worked around: a mandate silently inherited by a later session could keep
// waking somebody days after the intent that set it expired. Re-arm after a restart.
//
//   node wt-autonomy-arm.mjs              # declare a mandate for this session
//   node wt-autonomy-arm.mjs --disarm     # withdraw it
//   node wt-autonomy-arm.mjs --status     # report without writing
//
// Every line goes to STDOUT and the exit code carries the verdict: 0 armed/disarmed/armed-status,
// 1 not armed (for --status), 2 for a usage or environment error. A caller can therefore branch on
// the code without parsing prose.

import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

function out(line) {
  process.stdout.write(`${line}\n`)
}

function fail(detail) {
  out(`AUTONOMY ARM FAILED: ${detail}`)
  process.exit(2)
}

const args = process.argv.slice(2)
const disarm = args.includes('--disarm')
const statusOnly = args.includes('--status')
for (const a of args) {
  if (!['--disarm', '--status'].includes(a)) fail(`unknown option: ${a.replace(/[\r\n]+/g, ' ').slice(0, 60)}`)
}
if (disarm && statusOnly) fail('--disarm and --status are mutually exclusive')

// The harness sets this on every process it spawns. Without it there is no session to arm, and
// guessing one would write a marker no watcher will ever look for.
const sessionId = process.env.CLAUDE_CODE_SESSION_ID
if (!sessionId) fail('CLAUDE_CODE_SESSION_ID is not set — run this from inside a Claude Code session')
if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) fail('CLAUDE_CODE_SESSION_ID has an unexpected shape')

// ⚠ SAME RESOLUTION AS THE WATCHER, and the pair is a contract: the watcher reads
// `${XDG_STATE_HOME:-~/.local/state}/wt-queue-gate/engine-<sessionId>.json`, overridable by
// WT_AUTONOMY_WATCH_MANDATE_DIR. A divergence here writes a marker to a path nothing reads, and
// the failure is silent in both directions — the watcher stays quiet and this tool reports success.
const stateHome = process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state')
const stateDir = path.join(stateHome, 'wt-queue-gate')
const mandateDir = process.env.WT_AUTONOMY_WATCH_MANDATE_DIR || stateDir
const mandatePath = path.join(mandateDir, `engine-${sessionId}.json`)

if (statusOnly) {
  if (existsSync(mandatePath)) {
    let declaredAt = 'unknown'
    try {
      declaredAt = JSON.parse(readFileSync(mandatePath, 'utf8'))?.declaredAt ?? 'unknown'
    } catch {
      declaredAt = 'unreadable'
    }
    out(`AUTONOMY MANDATE: armed (declared ${declaredAt}) — ${mandatePath}`)
    process.exit(0)
  }
  out(`AUTONOMY MANDATE: not armed — nothing at ${mandatePath}`)
  process.exit(1)
}

if (disarm) {
  if (!existsSync(mandatePath)) {
    out('AUTONOMY MANDATE: already not armed — nothing to withdraw')
    process.exit(0)
  }
  rmSync(mandatePath, { force: true })
  out('AUTONOMY MANDATE: withdrawn — the autonomy watcher will no longer wake this session')
  process.exit(0)
}

mkdirSync(mandateDir, { recursive: true })
// Rewriting it is the normal case, not an error: re-arming refreshes the declaration, which is
// what a session does after a compaction or a long stretch of inline work.
writeFileSync(mandatePath, `${JSON.stringify({ sessionId, declaredAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
out(`AUTONOMY MANDATE: armed — ${mandatePath}`)
out('The autonomy watcher will wake this session when work remains, nothing is in flight, and no turn has happened for its idle window.')
