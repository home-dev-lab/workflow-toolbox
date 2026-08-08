#!/usr/bin/env node
// Declares — or withdraws — an autonomous mandate for THIS PROJECT.
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
// ⚠ THE MARKER IS KEYED ON THE PROJECT, NOT THE SESSION — and that is a fix, not the original
// design. A per-session marker died the instant its session restarted: a restart mints a new
// `CLAUDE_CODE_SESSION_ID`, so the marker the old session wrote became permanently unreachable,
// and the watcher read `mandate=absent` for a session that still believed it held a mandate —
// silently, forever, until someone re-armed by hand. Keying on the project instead means a
// restarted session inherits whatever mandate is still fresh for THIS PROJECT, with no gesture.
//
// That inheritance is bounded by a FRESHNESS WINDOW (default 8h, `--freshness-minutes` /
// `WT_AUTONOMY_WATCH_MANDATE_FRESHNESS_MINUTES`), read by the watcher from the `declaredAtMs`
// this tool stamps, never from the file's mtime — a file can be copied or touched without the
// mandate having been re-declared. Past the window the marker stops counting, on its own,
// nothing to remember: the failure mode this trades into is a STALE mandate that could wake a
// session after the human genuinely stopped caring — loud and killable (the wake is visible,
// `--disarm` clears it), which beats the silent alternative it replaces, where a session simply
// never wakes and nobody notices. See `plugin/autonomy/AUTONOMY.md` for the full trade-off.
//
// One project can only ever have ONE live mandate marker: arming again — from the same session or
// a different one — overwrites it. That is the existing re-arm behaviour, unchanged; it is also
// how a session inherits deliberately (arm once, let every session in the project pick it up)
// rather than by accident.
//
//   node wt-autonomy-arm.mjs                          # declare a mandate for this project
//   node wt-autonomy-arm.mjs --disarm                 # withdraw it
//   node wt-autonomy-arm.mjs --status                 # report without writing
//   node wt-autonomy-arm.mjs --project <dir>           # target a project other than cwd (tests, tooling)
//
// Every line goes to STDOUT and the exit code carries the verdict: 0 armed/disarmed/live-status,
// 1 no marker at all (for --status), 2 for a usage or environment error, 3 a marker exists but is
// EXPIRED — past the freshness window, present on disk, will not fire (for --status). 3 is a
// distinct code from 1 deliberately: "no marker" and "a marker that will not fire" are different
// facts a caller may need to branch on differently, and collapsing them back into one code would
// re-create in the exit status the exact ambiguity this file's `--status` text now refuses to
// carry in prose. A caller can therefore branch on the code without parsing prose.
//
// ⚠ `--status` and the watcher used to each carry their OWN freshness check, and they drifted: the
// watcher correctly refused to fire on an expired mandate while `--status` still reported `armed`,
// because it only checked the marker's EXISTENCE, never its age. Both now call the SAME
// `classifyMandate` in lib/autonomy-mandate.mjs — see that file for why a shared classifier is the
// actual fix, not a second, more careful copy of the same check.

import { writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { classifyMandate } from './lib/autonomy-mandate.mjs'

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
let projectDir = process.cwd()
for (let i = 0; i < args.length; i += 1) {
  const a = args[i]
  if (a === '--disarm' || a === '--status') continue
  if (a === '--project') {
    const value = args[i + 1]
    if (!value || value.startsWith('--')) fail('missing value for --project')
    projectDir = value
    i += 1
    continue
  }
  fail(`unknown option: ${a.replace(/[\r\n]+/g, ' ').slice(0, 60)}`)
}
if (disarm && statusOnly) fail('--disarm and --status are mutually exclusive')

// The harness sets this on every process it spawns. Without it there is no session to attribute
// the declaration to, and guessing one would stamp a marker whose "who declared this" is a lie.
const sessionId = process.env.CLAUDE_CODE_SESSION_ID
if (!sessionId) fail('CLAUDE_CODE_SESSION_ID is not set — run this from inside a Claude Code session')
if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) fail('CLAUDE_CODE_SESSION_ID has an unexpected shape')

// ⚠ SAME RESOLUTION AS THE WATCHER, and the pair is a contract: the watcher reads
// `${XDG_STATE_HOME:-~/.local/state}/wt-queue-gate/engine-<projectSlug>.json`, overridable by
// WT_AUTONOMY_WATCH_MANDATE_DIR. A divergence here writes a marker to a path nothing reads, and
// the failure is silent in both directions — the watcher stays quiet and this tool reports success.
function projectSlug(dir) {
  return path.resolve(dir).replace(/[^A-Za-z0-9-]/g, '-')
}

const stateHome = process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state')
const stateDir = path.join(stateHome, 'wt-queue-gate')
const mandateDir = process.env.WT_AUTONOMY_WATCH_MANDATE_DIR || stateDir
const mandatePath = path.join(mandateDir, `engine-${projectSlug(projectDir)}.json`)
// ⚠ SAME DEFAULT AND SAME ENV VAR AS THE WATCHER — a status readout that used its own default (or
// its own env var name) could report "live" past the instant the watcher would call it expired,
// which is exactly the class of drift this file exists to close.
const mandateFreshnessMs = Number(process.env.WT_AUTONOMY_WATCH_MANDATE_FRESHNESS_MINUTES || 480) * 60_000

if (statusOnly) {
  const mandate = classifyMandate(mandatePath, mandateFreshnessMs, Date.now(), sessionId)
  if (mandate.kind === 'live') {
    const declaredAt = new Date(mandate.declaredAtMs).toISOString()
    out(
      `AUTONOMY MANDATE: armed (declared ${declaredAt} by session ${mandate.declaredBy}` +
        `${mandate.inherited ? ', inherited by this session' : ''}) — ${mandatePath}`,
    )
    process.exit(0)
  }
  if (mandate.kind === 'expired') {
    const declaredAt = new Date(mandate.declaredAtMs).toISOString()
    // ⚠ NEVER "armed". A marker that exists but will not fire is closer to "not armed" than to
    // "armed" for a reader deciding whether to act — the whole defect this replaces was exactly
    // this readout saying `armed` about a mandate the gate had already refused to honour.
    out(
      `AUTONOMY MANDATE: expired (declared ${declaredAt} by session ${mandate.declaredBy}, ` +
        `${mandate.ageMin.toFixed(0)}min ago — past the freshness window, will NOT fire) — ${mandatePath}. ` +
        'Run with no arguments to re-arm.',
    )
    process.exit(3)
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
  out('AUTONOMY MANDATE: withdrawn — the autonomy watcher will no longer wake any session for this project')
  process.exit(0)
}

mkdirSync(mandateDir, { recursive: true })
// Rewriting it is the normal case, not an error: re-arming refreshes the declaration, which is
// what a session does after a compaction or a long stretch of inline work — and it is also how a
// mandate stays alive across a RESTART without anyone re-running this tool: the marker is keyed
// on the project, so the restarted session (new CLAUDE_CODE_SESSION_ID, same project) reads the
// SAME marker the old session wrote, as long as it is still inside the freshness window.
const declaredAtMs = Date.now()
writeFileSync(
  mandatePath,
  `${JSON.stringify({ sessionId, projectDir, declaredAt: new Date(declaredAtMs).toISOString(), declaredAtMs }, null, 2)}\n`,
  'utf8',
)
out(`AUTONOMY MANDATE: armed — ${mandatePath}`)
out(
  'The autonomy watcher will wake this session — and any session that restarts inside this project while the mandate stays fresh — when work remains, nothing is in flight, and no turn has happened for its idle window.',
)
