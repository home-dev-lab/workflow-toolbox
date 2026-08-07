#!/usr/bin/env node
// wt-main-guard-hook.mjs — a PreToolUse guard for the MAIN session specifically.
//
// Why this exists: `wt-pilot-guard-hook.mjs` guards every SUB-AGENT against a set of
// irreversible Bash actions, but it deliberately no-ops when `agent_id` is absent — i.e. for
// the main session itself, which it treats as the arbiter that holds the gate. That "the
// arbiter holds the gate" is aspirational, not mechanical: nothing actually executes when the
// MAIN session runs `npm publish`, a force-push, a remote branch deletion, or a catastrophic
// `rm -rf` — only prose rules do. This is that mechanism's mirror image, ported from a
// private per-machine copy (`wt-main-guard.mjs`) that carries no machine-specific string.
//
// Scope (fail-OPEN by construction on internal error; fails CLOSED only on the four named
// DENY classes, and only when a target is genuinely dangerous by the criteria below):
// - It acts ONLY on the MAIN session: `agent_id` present ⇒ sub-agent ⇒ no-op (the pilot guard
//   already covers that case; two guards denying the same command would double-message the
//   user for no benefit).
// - It only inspects Bash commands. Every other tool → no-op.
// - DENY (never happens without the user, rare enough that a false positive is
//   near-impossible): npm/pnpm/yarn publish; a force-push; a remote branch deletion; a
//   catastrophic `rm -rf` (root, home, a git repo root, or a target that cannot be statically
//   resolved because it contains an unexpanded variable or a glob).
// - JOURNAL ONLY (legitimate, never denied, but must leave a trace): a `git merge` integrating
//   a branch INTO main/master while main-session is on main/master (the OPPOSITE direction
//   from what the pilot guard blocks); any OTHER `rm -rf` that did not hit the catastrophic
//   criteria (an ordinary build-dir / node_modules / /tmp scratch / worktree purge — routine
//   here, and denying it would get this guard bypassed within a week).
// - Everything else → true no-op: nothing emitted, nothing journalled.
//
// ⚠ MEASURED-POSTURE SPLIT (see docs/public/known-issues.md and the port's own test suite for
// the numbers): unlike the sibling glob guard, this port's DENY classes were measured on real
// unchosen session history and shipped BLOCKING only where that measurement cleared a
// zero-false-positive bar. Any class below that bar ships JOURNAL-ONLY (allowed, logged, never
// denied) until re-measured — see FORCE_PUSH_BLOCKING / DELETE_PUSH_BLOCKING /
// RM_CATASTROPHIC_BLOCKING / PUBLISH_BLOCKING below for the per-class posture and its reason.
//
// Escape hatch: a denial the operator cannot clear turns into a bypass. A ONE-TIME, file-based
// override at ~/.local/state/wt-main-guard/allow-once.json — not an env var, because an env
// var can be set once and forgotten, silently disarming the guard for every future command.
// The file must contain the EXACT command string being run; it is deleted on use (single-use),
// and the override itself is journalled with its stated reason.
//
// Allow path is SILENT exit 0 (no JSON): emitting permissionDecision:"allow" would AUTO-APPROVE
// the call and bypass the user's normal permission prompts — the guard must never widen
// permissions, only refuse. Deny path = exit 0 + stdout JSON with
// hookSpecificOutput.permissionDecision:"deny" and, critically, permissionDecisionReason (NOT
// `reason` — a field named `reason` is accepted by the harness and then SILENTLY DISCARDED,
// leaving the user with an unexplained denial).
//
// Any internal error is swallowed via runFailOpenHook → exit 0 (never block a tool call because
// the guard itself has a bug). This is the accepted trade, written down here on purpose: a bug
// in this guard silently disables it. That is judged safer than a guard that can freeze the
// main session on its own defect.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'

const STATE_DIR = path.join(os.homedir(), '.local', 'state', 'wt-main-guard')
const JOURNAL_PATH = path.join(STATE_DIR, 'journal.jsonl')
const ALLOW_ONCE_PATH = path.join(STATE_DIR, 'allow-once.json')

// Per-class blocking posture, decided by measurement (see the report this port shipped with,
// and docs/public/known-issues.md).
// true  = ships DENY (blocking) for this class.
// false = ships JOURNAL-ONLY (allowed, logged, never denied) — the class is still DETECTED and
//         recorded, so the gap is visible in the journal rather than silent, but it does not
//         refuse the command until re-measured past the zero-false-positive bar.
//
// Measured 2026-08-07 against 2,788 real unchosen Bash commands drawn from every session
// transcript on this machine (both config dirs), fed one at a time to this guard's own
// executable:
//   publish            16/16 true positives, 0 false positives  -> BLOCKING
//   force-push         13/13 true positives, 0 false positives  -> BLOCKING
//   delete-push          4/4 true positives, 0 false positives  -> BLOCKING
//   rm root/home         0 occurrences (unmeasured; kept BLOCKING structurally: there is no
//                        legitimate `rm -rf /` or `rm -rf ~`, so a false positive here would
//                        itself have to be a typo worth catching)
//   rm git-root         10/10 FALSE positives — every one was a disposable /tmp clone or a
//                        `git worktree` purge about to be recreated, exactly the "routine"
//                        case the header comment above already named as something denying
//                        would get this guard bypassed for. Ships JOURNAL-ONLY.
//   rm unresolvable    319/319 sampled FALSE positives — overwhelmingly `rm -rf "$VAR"` where
//                        $VAR was bound earlier in the SAME multi-line command to a scratch/tmp
//                        path (`$(mktemp -d)`, a scratchpad dir) that this segment-local
//                        classifier cannot see. Ships JOURNAL-ONLY.
const PUBLISH_BLOCKING = true
const FORCE_PUSH_BLOCKING = true
const DELETE_PUSH_BLOCKING = true
const RM_ROOT_HOME_BLOCKING = true
const RM_GITROOT_UNRESOLVABLE_BLOCKING = false

// ---------------------------------------------------------------------------------------
// Code vs data — a command line mixes both, and a textual guard that reads the raw string
// can't tell them apart. Mirrors `wt-pilot-guard-hook.mjs`'s stripHeredocs()/stripQuotedSpans()
// — same approach, reused rather than reinvented.
//
// Applied SELECTIVELY, not blanket, because stripping quotes has an opposite failure mode: an
// rm target is routinely and legitimately quoted (`rm -rf "$HOME/tmp"`, a path with a space) —
// replacing that quoted span with an empty string would make a genuinely catastrophic target
// invisible to classifyRmTarget(), trading a false-positive fix for a false-negative one in the
// exact rule where a false negative matters most. See the per-rule call at each use site below.
// ---------------------------------------------------------------------------------------

/** Strip heredoc BODIES (never real shell in the segment they sit in — pure data) before any
 *  pattern matching. A heredoc body line can otherwise become its own pseudo-segment (segments()
 *  splits on bare newlines too) and look like a standalone command starting with the matched word. */
function stripHeredocs(cmd) {
  return cmd.replace(
    /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm,
    '<<HEREDOC-BODY-STRIPPED',
  )
}

/** Strip quoted SPANS (single- and double-quoted) to empty quotes, so text merely mentioned,
 *  echoed, or destined for a commit message stops looking like an instruction. Only applied to
 *  the rules below where the anchor word (npm/publish, git/push/--force/--delete, git/merge) is
 *  never itself legitimately quoted in a real invocation — never to rm target parsing (see
 *  header comment above). */
function stripQuotedSpans(cmd) {
  return cmd.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
}

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/** Split a shell command into rough segments on the sequencing operators, so each
 *  `git push` / `rm` / etc. is evaluated on its own. Mirrors wt-pilot-guard-hook.mjs. */
function segments(command) {
  return command.split(/\n|;|&&|\|\||\|/).map((s) => s.trim()).filter(Boolean)
}

// ---------------------------------------------------------------------------------------
// Class 1 — publish
// ---------------------------------------------------------------------------------------

function publishViolation(seg) {
  if (/\b(npm|pnpm|yarn)\s+publish\b/.test(seg)) return 'npm/pnpm/yarn publish is a release action'
  return null
}

// ---------------------------------------------------------------------------------------
// Classes 2 & 3 — git push (force / remote branch deletion)
// ---------------------------------------------------------------------------------------

/** Tokens after `push` in a `git … push …` segment, or null if this segment isn't one. */
function parseGitPushArgs(seg) {
  const tokens = seg.split(/\s+/).filter(Boolean)
  const pi = tokens.indexOf('push')
  if (pi === -1) return null
  if (tokens.slice(0, pi).indexOf('git') === -1) return null
  return tokens.slice(pi + 1)
}

function gitPushForceViolation(seg) {
  const after = parseGitPushArgs(seg)
  if (!after) return null
  const forced = after.some(
    (t) => /^--force(-with-lease)?$/.test(t) || (/^-[A-Za-z]+$/.test(t) && /f/.test(t)),
  )
  return forced ? 'a force-push overwrites remote history without the user' : null
}

function gitPushDeleteViolation(seg) {
  const after = parseGitPushArgs(seg)
  if (!after) return null
  const deleted = after.some((t) => t === '--delete' || /^:\S+$/.test(t))
  return deleted ? 'a remote branch deletion is remote-destructive' : null
}

// ---------------------------------------------------------------------------------------
// Class 4 & 6 — rm -rf (catastrophic vs ordinary)
// ---------------------------------------------------------------------------------------

/** Tokens after `rm` in an `rm …` segment, or null if this segment isn't one. */
function parseRmArgs(seg) {
  const tokens = seg.split(/\s+/).filter(Boolean)
  if (tokens[0] !== 'rm') return null
  return tokens.slice(1)
}

function hasRecursiveAndForce(args) {
  const recursive = args.some(
    (t) => t === '-r' || t === '-R' || t === '--recursive' || (/^-[A-Za-z]+$/.test(t) && /[rR]/.test(t)),
  )
  const force = args.some(
    (t) => t === '-f' || t === '--force' || (/^-[A-Za-z]+$/.test(t) && /f/.test(t)),
  )
  return recursive && force
}

function rmTargets(args) {
  return args.filter((t) => !t.startsWith('-'))
}

/** Classify a single rm target token: 'root' | 'home' | 'unresolvable' | 'git-root' | null (safe). */
function classifyRmTarget(token, cwd) {
  const home = os.homedir().replace(/\/+$/, '')
  if (token === '/' || token === '/*') return 'root'
  if (token === '~' || token === '$HOME' || token === '${HOME}') return 'home'
  if (/[$*?[]/.test(token)) return 'unresolvable'

  let resolved = token
  if (resolved.startsWith('~/')) resolved = path.join(home, resolved.slice(2))
  if (!path.isAbsolute(resolved)) resolved = path.resolve(cwd, resolved)
  resolved = resolved.replace(/\/+$/, '') || '/'

  if (resolved === home) return 'home'
  try {
    if (fs.existsSync(path.join(resolved, '.git'))) return 'git-root'
  } catch {
    // Filesystem errors resolving the target are not evidence of danger — treat as safe
    // rather than guessing; a genuinely dangerous target already matched above.
  }
  return null
}

/** { blocking: boolean, reason: string } | null (no catastrophic target in this segment). */
function rmCatastrophicViolation(seg, cwd) {
  const args = parseRmArgs(seg)
  if (!args || !hasRecursiveAndForce(args)) return null
  for (const t of rmTargets(args)) {
    const kind = classifyRmTarget(t, cwd)
    if (kind === 'root') {
      return { blocking: RM_ROOT_HOME_BLOCKING, reason: `rm -rf targeting the filesystem root ('${t}') is catastrophic` }
    }
    if (kind === 'home') {
      return { blocking: RM_ROOT_HOME_BLOCKING, reason: `rm -rf targeting the home directory ('${t}') is catastrophic` }
    }
    if (kind === 'unresolvable') {
      return {
        blocking: RM_GITROOT_UNRESOLVABLE_BLOCKING,
        reason: `rm -rf target '${t}' cannot be statically resolved (unexpanded variable or glob) — an unresolvable destructive target is treated as dangerous`,
      }
    }
    if (kind === 'git-root') {
      return { blocking: RM_GITROOT_UNRESOLVABLE_BLOCKING, reason: `rm -rf targeting a git repository root ('${t}') is catastrophic` }
    }
  }
  return null
}

/** Class 6 — any other rm -rf. Only meaningful for a segment that rmCatastrophicViolation
 *  already cleared (checked in that order by classify()). */
function rmOtherViolation(seg) {
  const args = parseRmArgs(seg)
  if (!args || !hasRecursiveAndForce(args)) return null
  const targets = rmTargets(args)
  if (targets.length === 0) return null
  return `rm -rf (recursive+force delete), target(s): ${targets.join(', ')}`
}

// ---------------------------------------------------------------------------------------
// Class 5 — git merge INTO main/master (opposite direction from the pilot guard)
// ---------------------------------------------------------------------------------------

function parseGitMergeArgs(seg) {
  const tokens = seg.split(/\s+/).filter(Boolean)
  const mi = tokens.indexOf('merge')
  if (mi === -1) return null
  if (tokens.slice(0, mi).indexOf('git') === -1) return null
  return tokens.slice(mi + 1).filter((t) => !t.startsWith('-'))
}

function isMainMasterRef(r) {
  return /^(?:[A-Za-z0-9._-]+\/)?(?:main|master)$/.test(r)
}

function currentBranch(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
  } catch {
    // Not a git repo, git unavailable, or the cwd doesn't exist — we cannot determine the
    // current branch, so we cannot classify this as "on main/master". Skip, don't guess.
    return null
  }
}

function gitMergeIntoMainViolation(seg, cwd) {
  const refs = parseGitMergeArgs(seg)
  if (!refs || refs.length === 0) return null
  if (refs.every(isMainMasterRef)) return null // merging main/master IN — the reverse direction
  const branch = currentBranch(cwd)
  if (branch !== 'main' && branch !== 'master') return null
  return `merging '${refs.join(' ')}' into ${branch} while on ${branch} — the direction that matters for a release, journaled for traceability`
}

// ---------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------

/** { kind: 'deny'|'journal', class: string, reason: string } | null (true no-op). */
function classify(command, cwd) {
  // heredocStripped: safe for EVERY rule (a heredoc body is never shell in this segment).
  // fullyStripped: additionally quote-stripped — safe for publish/push/merge, whose anchor
  // words are never legitimately quoted in a real invocation, but NOT for rm (see header
  // comment): a quoted rm target must stay visible to classifyRmTarget().
  const heredocStripped = stripHeredocs(command)
  const fullyStripped = stripQuotedSpans(heredocStripped)

  for (const seg of segments(fullyStripped)) {
    const pub = publishViolation(seg)
    if (pub) return { kind: PUBLISH_BLOCKING ? 'deny' : 'journal', class: 'publish', reason: pub }
    const force = gitPushForceViolation(seg)
    if (force) return { kind: FORCE_PUSH_BLOCKING ? 'deny' : 'journal', class: 'force-push', reason: force }
    const del = gitPushDeleteViolation(seg)
    if (del) return { kind: DELETE_PUSH_BLOCKING ? 'deny' : 'journal', class: 'delete-push', reason: del }
  }
  for (const seg of segments(heredocStripped)) {
    const rmCat = rmCatastrophicViolation(seg, cwd)
    if (rmCat) return { kind: rmCat.blocking ? 'deny' : 'journal', class: 'rm-catastrophic', reason: rmCat.reason }
  }
  for (const seg of segments(fullyStripped)) {
    const merge = gitMergeIntoMainViolation(seg, cwd)
    if (merge) return { kind: 'journal', class: 'merge-into-main', reason: merge }
  }
  for (const seg of segments(heredocStripped)) {
    const rmOther = rmOtherViolation(seg)
    if (rmOther) return { kind: 'journal', class: 'rm-other', reason: rmOther }
  }
  return null
}

// ---------------------------------------------------------------------------------------
// Journal + escape hatch
// ---------------------------------------------------------------------------------------

function journal(entry) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n'
    fs.appendFileSync(JOURNAL_PATH, line)
  } catch {
    // Journalling failure must never block the tool call or crash the guard.
  }
}

/** If the allow-once file names THIS exact command, consume it (single use) and return its
 *  reason; else null. Byte-for-byte match only — no prefix/pattern matching, deliberately, so
 *  the escape hatch cannot be pre-armed for a class of commands. */
function checkAllowOnce(command) {
  try {
    if (!fs.existsSync(ALLOW_ONCE_PATH)) return null
    const obj = JSON.parse(fs.readFileSync(ALLOW_ONCE_PATH, 'utf8'))
    if (obj && obj.command === command) {
      fs.unlinkSync(ALLOW_ONCE_PATH)
      return obj.reason || '(no reason given)'
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------

function main() {
  const input = readInput()
  // Any SUBAGENT carries agent_id ⇒ the pilot guard already covers it ⇒ no-op here to avoid a
  // double denial message. Absence of agent_id ⇒ the main session itself ⇒ our territory.
  if (input.agent_id) return
  if (input.tool_name !== 'Bash') return
  const command =
    input.tool_input && typeof input.tool_input.command === 'string' ? input.tool_input.command : ''
  if (!command) return
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd()

  const result = classify(command, cwd)
  if (!result) return // true no-op: nothing matched, nothing journalled

  const truncated = command.length > 400 ? command.slice(0, 400) : command

  if (result.kind === 'journal') {
    journal({ class: result.class, command: truncated, cwd, decision: 'allowed-journaled', reason: result.reason })
    return // legitimate action, or an unmeasured-blocking class: allow silently, but recorded
  }

  // result.kind === 'deny'
  const overrideReason = checkAllowOnce(command)
  if (overrideReason) {
    journal({
      class: result.class,
      command: truncated,
      cwd,
      decision: 'override-allow',
      reason: overrideReason,
    })
    return // consumed the single-use override: allow silently
  }

  journal({ class: result.class, command: truncated, cwd, decision: 'denied', reason: result.reason })
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `[workflow-toolbox main guard] Refused: ${result.reason}. This is an irreversible ` +
          'action with no undo — if it is genuinely intended, write {"command": "<exact ' +
          'command>", "reason": "<why>"} to ~/.local/state/wt-main-guard/allow-once.json and ' +
          'retry (single use).',
      },
    }),
  )
}

runFailOpenHook('wt-main-guard-hook.mjs', main)
