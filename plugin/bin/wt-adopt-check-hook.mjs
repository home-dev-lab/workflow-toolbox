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
//   - some rule file behind the shipped version everywhere it's found → say which, and
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
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INSTALL_RULES = path.join(HERE, '..', 'skills', 'adopt', 'scripts', 'install.mjs')
const SKILL_NAME = 'workflow-toolbox:adopt'

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
 *  per-file status lines (`  <file>: <status>`) into a Map<file, status>. Never throws —
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
    if (m) map.set(m[1], m[2])
  }
  return map
}

/** Classify one install.mjs status string into the bucket this hook cares about.
 *  Unknown/unexpected text is treated as 'ok' — fail toward silence, never a false alarm. */
function bucket(status) {
  if (/^ABSENT/.test(status)) return 'absent'
  if (/^STALE/.test(status)) return 'stale'
  if (/^EDITED/.test(status)) return 'edited'
  return 'ok' // UP-TO-DATE, AHEAD, SYMLINK, PRESENT (hand-authored), or anything unrecognized
}

// Best-to-worst: a file counts 'ok' if EITHER checked location says so (it IS in force,
// current, somewhere) — an edited/stale copy in the OTHER location doesn't undo that.
// Otherwise take the least-concerning bucket found: edited (supported, not a problem)
// beats stale (needs a refresh) beats absent (nothing installed at all).
const RANK = { ok: 0, edited: 1, stale: 2, absent: 3 }

function mergeFile(a, b) {
  const ba = a ? bucket(a) : 'absent'
  const bb = b ? bucket(b) : 'absent'
  if (ba === 'ok' || bb === 'ok') return 'ok'
  return RANK[ba] <= RANK[bb] ? ba : bb
}

function buildMessage(perFile, installCmd, set = 'rules', event = 'SessionStart') {
  const buckets = { absent: [], stale: [], edited: [] }
  for (const [file, b] of perFile) {
    if (b !== 'ok') buckets[b].push(file)
  }
  // ABSENT means opposite things for the two sets. Rules carry the methodology: not having
  // them is a gap worth naming. Agent copies are OPT-IN — a project that never adopted the
  // pilot suite made a choice, and nagging it on every session would be a guard that is
  // always red, which is a guard that gets ignored. For agents, only STALE is a finding.
  if (set !== 'rules') buckets.absent = []
  if (!buckets.absent.length && !buckets.stale.length && !buckets.edited.length) return null

  const lines = []
  if (buckets.absent.length) {
    lines.push(
      `workflow-toolbox rules NOT installed here: ${buckets.absent.sort().join(', ')}. ` +
        `Plugin ${set} never load into a session on their own, so what they carry is ` +
        `NOT in force for these. Fix: run the ${SKILL_NAME} skill ` +
        `(or \`node ${installCmd} --set ${set} --install\`).`,
    )
  }
  if (buckets.stale.length) {
    lines.push(
      `Behind the shipped version: ${buckets.stale.sort().join(', ')}. Refresh via ` +
        `${SKILL_NAME} (\`--set ${set} --install\`) — it will not touch a file you've locally edited.`,
    )
  }
  // "Locally modified" is a SUPPORTED steady state, not an event. Reporting it at session
  // start is informative; reporting it after every push would fire forever on the same
  // unchanged files — and a guard that is always red is a guard that gets ignored, which
  // manufactures the blind spot it exists to close.
  if (buckets.edited.length && event !== 'PostToolUse') {
    lines.push(
      `Locally modified (supported, left untouched by any refresh): ${buckets.edited.sort().join(', ')}.`,
    )
  }
  return lines.join('\n')
}

// A `git push` is the moment the shipped rules move ahead of the adopted copies. Narrow
// on purpose: every OTHER Bash command must cost nothing, or a guard that runs on each
// call becomes a guard someone turns off.
const PUSH = /\bgit\s+(?:-C\s+\S+\s+)?push\b/

/** Which event are we serving, and should we do anything at all? Returns the event name
 *  to echo back, or null to stay silent. */
function resolveEvent(input) {
  const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : 'SessionStart'
  if (event !== 'PostToolUse') return event
  // PostToolUse fires for every Bash call; only a push can have created the drift.
  if (input.tool_name !== 'Bash') return null
  const command = input?.tool_input?.command
  return typeof command === 'string' && PUSH.test(command) ? event : null
}

function main() {
  const input = readInput()
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
  const SETS = [
    { set: 'rules', subdir: 'rules' },
    { set: 'agents', subdir: 'agents' },
  ]

  const sections = []
  for (const { set, subdir } of SETS) {
    const projectMap = checkDir(path.join(root, '.claude', subdir), set)
    const globalMap = checkDir(path.join(configDir, subdir), set)
    if (projectMap.size === 0 && globalMap.size === 0) continue // couldn't check → skip this set

    const files = new Set([...projectMap.keys(), ...globalMap.keys()])
    const perFile = new Map()
    for (const file of files) perFile.set(file, mergeFile(projectMap.get(file), globalMap.get(file)))

    const built = buildMessage(perFile, INSTALL_RULES, set, event)
    if (built) sections.push(built)
  }

  const message = sections.length ? sections.join('\n') : null
  if (!message) return // everything adopted & current somewhere → silent

  // After a push, the reader needs to know WHY they are being told now: they just moved
  // the shipped rules ahead of the copies that are actually in force. Without that line
  // the same text reads as a stale session-start notice and gets skipped.
  const preface =
    event === 'PostToolUse'
      ? 'A push just landed and the adopted rule copies are now behind it. A shipped rule ' +
        'that is not adopted is INERT — it is on disk, it can be read and quoted, and it ' +
        'governs nothing. Refresh before relying on it:\n'
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

runFailOpenHook('wt-adopt-check-hook.mjs', main)
