#!/usr/bin/env node
// wt-adopt-check-hook.mjs — a SessionStart check that tells the session the TRUTH
// about its rule-adoption state, instead of leaving it to find out the hard way.
//
// Rules shipped inside the plugin are INERT: they never load into a session on their
// own — only a copy written by the adopt skill into a real config dir does. A
// session that never adopted gets none of the shipped methodology and no signal that
// anything is missing. This hook is the signal.
//
// It does NOT install anything, ever. It is read-only, by design (the owner's decision):
// a hook cannot ask for consent — it only emits text one-way — so writing into someone's
// project on plugin enable would install without consent, which the adopt skill's
// own contract forbids. This hook only ever SUGGESTS the skill/command; it never runs it.
//
// It REUSES install.mjs's own classification (absent / clean / stale / edited /
// symlink / hand-authored) by spawning the real script in --check mode and parsing its
// stdout — never a second, hand-rolled copy of that logic, which would drift from the
// first and then the two could disagree about the same file.
//
// Two locations are checked, unioned per file — the PROJECT rules dir (<cwd>/.claude/rules,
// where adopt writes by default) and the GLOBAL config rules dir
// (CLAUDE_CONFIG_DIR/rules, e.g. ~/.claude/rules) — because adopting globally is a real,
// supported pattern (this machine's own config does exactly that), and checking only the
// project dir would falsely cry "absent" for a rule that IS in force via the global copy.
//
// Behaviour:
//   - everything adopted & current everywhere it's checked → SILENT (no output at all).
//   - some rule file absent everywhere → say so, name the file(s), name the consequence
//     (the methodology's directives are not in force), give the exact fix.
//   - some rule file behind the shipped content everywhere it's found → say which location, and
//     that installing won't touch a locally-edited file.
//   - some rule file locally edited (and not clean/current elsewhere) → say which, and
//     that this is a SUPPORTED state, never framed as a problem.
//   - ANY internal error → exit 0 silently. A session-start hook that can break session
//     start is not worth its output.
//
// SHIPPED (plugin/bin/): registered on SessionStart in plugin/.claude-plugin/plugin.json,
// alongside the other two SessionStart hooks (same file, same array shape).

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { invokes } from './lib/command-invocation.mjs'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INSTALL_RULES = path.join(HERE, '..', 'skills', 'adopt', 'scripts', 'install.mjs')
const SKILL_NAME = 'workflow-toolbox:adopt'
const VERSION_RE = /installed from workflow-toolbox v(\d+\.\d+\.\d+)/

/** Read the hook's JSON payload from stdin; tolerate empty/malformed input. */
function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/** Run the REAL install.mjs in --check mode against one target dir and parse its
 *  per-file status lines (`  <file>: <status>`) into a Map<file, {status, location}>. Never throws —
 *  a missing/failed child (broken install, no such dir handled fine by install-rules
 *  itself) just yields an empty map, which contributes nothing to the merge. */
function checkDir(dir, set = 'rules') {
  const map = new Map()
  if (!fs.existsSync(INSTALL_RULES)) return map
  let res
  try {
    res = spawnSync(process.execPath, [INSTALL_RULES, '--check', '--set', set, '--dir', dir], {
      encoding: 'utf8',
      timeout: 5_000,
    })
  } catch {
    return map
  }
  const stdout = res && res.stdout ? res.stdout : ''
  for (const line of stdout.split('\n')) {
    const m = /^ {2}(\S+\.md): (.+)$/.exec(line)
    if (m) map.set(m[1], { status: m[2], location: dir })
  }
  return map
}

/** Classify one install.mjs status string into the bucket this hook cares about.
 *  Unknown/unexpected text is treated as 'ok' — fail toward silence, never a false alarm.
 *
 *  MIGRATION-PENDING (card 1835727457) is the ONE deliberate exception to that fail-open
 *  default: it means "absent at THIS candidate location, but present un-migrated at the
 *  legacy one" — install.mjs's own legacy-fallback only ever fires when checking a `wt/`
 *  dir specifically. Reading it as 'ok' here would let the wt/ check's finding silently
 *  win over a genuinely stale/edited status the SAME file gets from the flat-dir check run
 *  right alongside it (mergeAll treats 'ok' as an unconditional win) — measured: it
 *  swallowed a real STALE finding in this suite's own fixtures before this line existed.
 *  Treating it as 'absent' instead lets the OTHER checked location's real classification
 *  through the merge undisturbed. */
function bucket(status) {
  if (/^ABSENT/.test(status)) return 'absent'
  if (/^MIGRATION-PENDING/.test(status)) return 'absent'
  if (/^STALE/.test(status)) return 'stale'
  if (/^AHEAD(?:\/FORKED)?/.test(status)) return 'ahead'
  if (/^EDITED/.test(status)) return 'edited'
  return 'ok' // UP-TO-DATE, SYMLINK, PRESENT (hand-authored), or anything unrecognized
}

// Best-to-worst: a file counts 'ok' if EITHER checked location says so (it IS in force,
// current, somewhere) — an edited/stale copy in the OTHER location doesn't undo that.
// Otherwise take the least-concerning bucket found: edited (supported, not a problem)
// beats ahead/forked, which beats stale (needs a refresh), then absent.
const RANK = { ok: 0, edited: 1, ahead: 2, stale: 3, absent: 4 }

/** "A file counts ok if ANY checked location says so" — folded across N maps rather than
 *  just two, since the rules set now has a second candidate LOCATION on top of the
 *  pre-existing project-vs-global axis (the pre-migration flat dir AND the new rules/wt/
 *  subfolder, card 1835727457). Four maps in the common case (project flat, project wt,
 *  global flat, global wt). */
function mergeAll(maps, file) {
  let best = { bucket: 'absent', location: null, status: 'ABSENT' }
  for (const map of maps) {
    const finding = map.get(file)
    const b = finding ? bucket(finding.status) : 'absent'
    if (b === 'ok') return { bucket: 'ok', location: finding.location, status: finding.status }
    if (RANK[b] < RANK[best.bucket]) {
      best = { bucket: b, location: finding?.location ?? null, status: finding?.status ?? 'ABSENT' }
    }
  }
  return best
}

function versionFromStatus(status) {
  const match = /installed v(\d+\.\d+\.\d+)/.exec(status)
  return match ? match[1] : null
}

function compareVersions(a, b) {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  }
  return 0
}

// Banners are installer-owned metadata. Drop only the recognized banner line and its
// separator before comparing the editable body to the shipped source.
function stripBanner(text) {
  const lines = text.split('\n')
  const bannerIndex = lines.findIndex((line) => VERSION_RE.test(line))
  if (bannerIndex === -1) return text
  lines.splice(bannerIndex, 1)
  if (lines[bannerIndex] === '') lines.splice(bannerIndex, 1)
  return lines.join('\n').replace(/[ \t\r\n]+$/u, '')
}

function contentDirection(file, finding, set) {
  const installedVersion = versionFromStatus(finding.status)
  let currentVersion
  try {
    currentVersion = JSON.parse(fs.readFileSync(path.join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version
  } catch {
    return 'differs (direction unknown: content-only comparison)'
  }
  if (installedVersion && typeof currentVersion === 'string') {
    const compared = compareVersions(installedVersion, currentVersion)
    if (compared < 0) return `behind v${currentVersion}`
    if (compared > 0) return `ahead of v${currentVersion}`
  }

  const sourceDir = set === 'agents' ? 'agent-templates' : 'rules'
  try {
    const copy = stripBanner(fs.readFileSync(path.join(finding.location, file), 'utf8'))
    const shipped = fs.readFileSync(path.join(HERE, '..', sourceDir, file), 'utf8').replace(/[ \t\r\n]+$/u, '')
    const copyLines = new Set(copy.split(/\r?\n/))
    const shippedLines = new Set(shipped.split(/\r?\n/))
    const onlyCopy = [...copyLines].some((line) => !shippedLines.has(line))
    const onlyShipped = [...shippedLines].some((line) => !copyLines.has(line))
    if (onlyCopy && !onlyShipped) return `ahead of v${currentVersion}`
    if (onlyShipped && !onlyCopy) return `behind v${currentVersion}`
  } catch {
    // A vanished/unreadable copy is not grounds for a direction claim.
  }
  return `differs from v${currentVersion} (direction unknown: content-only comparison)`
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

function installRemedy(installCmd, set, dir) {
  return `node ${shellQuote(installCmd)} --set ${set} --install --dir ${shellQuote(dir)}`
}

function buildMessage(perFile, installCmd, remedyDir, set = 'rules', event = 'SessionStart') {
  const buckets = { absent: [], stale: [], ahead: [], edited: [] }
  for (const [file, finding] of perFile) {
    if (finding.bucket !== 'ok') buckets[finding.bucket].push({ file, ...finding })
  }
  // ABSENT means opposite things for the two sets. Rules carry the methodology: not having
  // them is a gap worth naming. Agent copies are OPT-IN — a project that never adopted the
  // pilot suite made a choice, and nagging it on every session would be a guard that is
  // always red, which is a guard that gets ignored. For agents, only STALE is a finding.
  if (set !== 'rules') buckets.absent = []
  if (!buckets.absent.length && !buckets.stale.length && !buckets.ahead.length && !buckets.edited.length) return null

  const named = (items) =>
    items
      .sort((a, b) => a.file.localeCompare(b.file))
      .map(({ file, location }) => `${file}${location ? ` (${location})` : ''}`)
      .join(', ')

  const lines = []
  if (buckets.absent.length) {
    lines.push(
      `workflow-toolbox rules NOT installed here: ${named(buckets.absent)}. ` +
        `Plugin ${set} never load into a session on their own, so what they carry is ` +
        `NOT in force for these. Fix: run the ${SKILL_NAME} skill ` +
        `(or \`${installRemedy(installCmd, set, remedyDir)}\`).`,
    )
  }
  for (const finding of [...buckets.stale, ...buckets.ahead].sort((a, b) => a.file.localeCompare(b.file))) {
    const target = `${finding.file}${finding.location ? ` (${finding.location})` : ''}`
    lines.push(
      `${target}: ${contentDirection(finding.file, finding, set)}. Owner / single writer: run ` +
        `\`${installRemedy(installCmd, set, finding.location)}\`; this read-only hook will not run it.`,
    )
  }
  // "Locally modified" is a SUPPORTED steady state, not an event. Reporting it at session
  // start is informative; reporting it after every push would fire forever on the same
  // unchanged files — and a guard that is always red is a guard that gets ignored, which
  // manufactures the blind spot it exists to close.
  if (buckets.edited.length && event !== 'PostToolUse') {
    lines.push(
      `Locally modified (supported, left untouched by any refresh): ${named(buckets.edited)}.`,
    )
  }
  // ⚠ NAME THE ACTION, AND NAME WHOSE IT IS. Everything above is a measurement, and a
  // measurement nobody acts on is worse than none — it costs attention and buys nothing.
  //
  // But the action is NOT the model's to take alone. This hook refuses to install precisely
  // because it cannot ask for consent; a model that reads "Fix: run the adopt skill" and
  // silently runs it launders that same missing consent one layer down — the install still
  // happens without anyone being asked, only now it looks deliberate.
  //
  // So the instruction is to SURFACE it. The reader here is the model; the decider is the
  // human. Without this line the message had numbers, a command, and no addressee for the
  // decision — which is how a correct finding ends as a line nobody ever acted on.
  if (lines.length) {
    lines.push(
      `TELL THE USER about this in your next reply — name the files and what is not in force, ` +
        `and let them decide. Do NOT run the install on your own: this hook stays read-only ` +
        `because adopting writes into their config, and that is their call, not yours.`,
    )
  }
  return lines.join('\n')
}

// This hook fires on a `git push`-shaped COMMAND, not a confirmed push outcome; for Bash
// PostToolUse does not tell us whether the push landed or was refused. Narrow on purpose:
// every OTHER Bash command must cost nothing, or a guard that runs on each call becomes
// a guard someone turns off.
/** True when `command` INVOKES git push — not when the words merely appear in a heredoc body
 *  or a quoted string (a card description written with `cat <<'EOF'` that mentions "git push"
 *  is not a push; measured 2026-09-05, three firings on one afternoon of card writing). Only
 *  text at a command position counts: the start, or right after `&&`, `||`, `;`, `|`, `(`,
 *  `{`, `$(`, a newline, or `sudo`/`env VAR=…` prefixes. Exported for the selftest. */
export function looksLikePush(command) {
  return invokes(command, /^git\s+(?:-C\s+\S+\s+)?push\b/)
}

/** Which event are we serving, and should we do anything at all? Returns the event name
 *  to echo back, or null to stay silent. */
function resolveEvent(input) {
  const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : 'SessionStart'
  if (event !== 'PostToolUse') return event
  // PostToolUse fires for every Bash call; only a push can have created the drift.
  if (input.tool_name !== 'Bash') return null
  const command = input?.tool_input?.command
  return looksLikePush(command) ? event : null
}

export function main() {
  const input = readInput()
  if (typeof input?.agent_id === 'string' && input.agent_id) return
  const event = resolveEvent(input)
  if (!event) return

  const root = typeof input.cwd === 'string' && input.cwd ? input.cwd : null
  if (!root) return // no cwd in payload → can't locate the project; stay silent

  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')

  // BOTH managed sets, not just rules. An agent definition goes stale exactly the same way a
  // rule does — a shipped fix lands, the adopted copy keeps the old text — and the project
  // copies are the ones that WIN over the plugin's own types, so a stale agent copy keeps
  // winning silently. Checking only rules left that half unguarded, which was noticed the day
  // this hook shipped, by a commit that changed agent definitions and drew no warning at all.
  //
  // `subdirs` (plural) for the rules set: TWO candidate locations during the flat-root →
  // rules/wt/ migration (card 1835727457) — the pre-migration flat dir AND the new default.
  // Checking only the new location would read a perfectly healthy, simply-not-yet-migrated
  // project as "rules NOT installed here" — a false alarm on a project that adopted correctly
  // and just hasn't run the migration. Checking only the flat dir would miss a project that
  // HAS migrated. Union of both, same "ok wins" rule already used for project-vs-global.
  const SETS = [
    { set: 'rules', subdirs: ['rules', path.join('rules', 'wt')] },
    { set: 'agents', subdirs: ['agents'] },
  ]

  const sections = []
  for (const { set, subdirs } of SETS) {
    const maps = []
    for (const subdir of subdirs) {
      maps.push(checkDir(path.join(root, '.claude', subdir), set))
      maps.push(checkDir(path.join(configDir, subdir), set))
    }
    if (maps.every((m) => m.size === 0)) continue // couldn't check any location → skip this set

    const files = new Set(maps.flatMap((m) => [...m.keys()]))
    const perFile = new Map()
    for (const file of files) perFile.set(file, mergeAll(maps, file))

    const remedyDir = path.join(root, '.claude', subdirs[subdirs.length - 1])
    const built = buildMessage(perFile, INSTALL_RULES, remedyDir, set, event)
    if (built) sections.push(built)
  }

  const message = sections.length ? sections.join('\n') : null
  if (!message) return // everything adopted & current somewhere → silent

  // After a push attempt, the reader needs to know WHY they are being told now: a
  // `git push`-shaped command just ran, but this Bash PostToolUse hook cannot confirm
  // whether it landed. Without that line the same text reads as a stale session-start
  // notice and gets skipped.
  const preface =
    event === 'PostToolUse'
      ? 'A `git push` command just ran; this Bash PostToolUse hook cannot tell whether it ' +
        'landed. If the adopted rule copies are behind, that gap is real either way. A ' +
        'shipped rule that is not adopted is INERT — it is on disk, it can be read and ' +
        'quoted, and it governs nothing. Refresh before relying on it:\n'
      : ''

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: preface + message,
      },
    }),
  )
}

// Run only when executed as a hook, not when imported by the selftest.
import { pathToFileURL } from 'node:url'
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFailOpenHook('wt-adopt-check-hook.mjs', main)
}
