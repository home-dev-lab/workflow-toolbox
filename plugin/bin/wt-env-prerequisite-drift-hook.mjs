#!/usr/bin/env node
// wt-env-prerequisite-drift-hook.mjs — SessionStart warning light for an environment
// prerequisite that drifted AFTER adoption.
//
// `adopt` is the wrench: it names a missing prerequisite and writes it on an
// explicit flag. This is the warning light. Someone who adopted months ago, whose
// settings have since been edited — by them, by another tool, by a machine restore —
// gets a plugin that behaves worse with nothing anywhere saying so:
//
//   depth key gone     → the nested-spawn ceiling can sit below the pilot suite's three
//                        levels, and an executor lane dies mid-wave
//   observer flag gone → adopted pilots run without their watchdog, and their reports
//                        then honestly say "no observer findings"
//
// Both are silent by construction, which is why a periodic re-check is the fix rather
// than better documentation.
//
// ⚠ THE CONSTRAINT THAT DECIDES WHETHER THIS SURVIVES ITS FIRST WEEK: silent when
// everything is fine. It runs at every session start — the noisiest surface there is.
// One false positive per session and it gets switched off, taking its real case with
// it. So it is silent on the happy path, silent on a project that adopted nothing, and
// it says UNKNOWN rather than "absent" when it cannot read the file.
//
// ⚠ NO ENVIRONMENT VALUE EVER REACHES OUTPUT. The `env` block carries real credentials;
// this prints key NAMES only. The shared module it delegates to discards values at the
// read boundary, so there is no path by which one could arrive here.
//
// Exit code is ALWAYS 0. This is a warning light, not a gate: a SessionStart hook that
// can fail a session start is a hook that gets removed the first morning it is wrong.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readEnvKeys, evaluateEnvDrift } from './lib/env-prerequisites.mjs'

const BANNER_TOOL = 'workflow-toolbox'
const BANNER_RE = new RegExp(`installed from ${BANNER_TOOL} v\\d+\\.\\d+\\.\\d+`)

/** A set counts as ADOPTED when at least one file in its project dir carries the
 *  installer's banner. Deliberately not "the directory exists": a project can have a
 *  `.claude/agents/` full of its own hand-written agents and have adopted nothing, and
 *  warning it about the observer flag would be firing on a correct state — the single
 *  case the card names as deciding survival. */
function setIsAdopted(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return false
  }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue
    let head
    try {
      // The banner sits at the top (line 1 for a rule, just after the frontmatter for
      // an agent), so a bounded read is enough and keeps this off the session-start
      // critical path even in a directory with many files.
      head = fs.readFileSync(path.join(dir, name), 'utf8').slice(0, 2048)
    } catch {
      continue
    }
    if (BANNER_RE.test(head)) return true
  }
  return false
}

function configRoot() {
  const explicit = process.env['CLAUDE_CONFIG_DIR']
  if (explicit && explicit.trim() !== '') return explicit
  return path.join(os.homedir(), '.claude')
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function main() {
  const payload = readStdinJson()
  const projectRoot =
    typeof payload['cwd'] === 'string' && payload['cwd'].trim() !== '' ? payload['cwd'] : process.cwd()

  const adoptedSets = []
  if (setIsAdopted(path.join(projectRoot, '.claude', 'rules'))) adoptedSets.push('rules')
  if (setIsAdopted(path.join(projectRoot, '.claude', 'agents'))) adoptedSets.push('agents')

  const settingsPath = path.join(configRoot(), 'settings.json')
  const envState = readEnvKeys(settingsPath, (p) => fs.readFileSync(p, 'utf8'))
  const result = evaluateEnvDrift({ adoptedSets, envState })

  if (result.verdict === 'silent') return

  if (result.verdict === 'unknown') {
    // Says what it could not do, never what it concluded. "Could not measure" is not a
    // finding about the settings, and printing it as one is how a check stops being
    // believed.
    console.log(
      `[wt] environment prerequisites NOT CHECKED — ${result.reason} (${settingsPath}). ` +
        `This is not a report that anything is missing; it is a report that nothing was read. ` +
        `To settle it: node <plugin>/skills/adopt/scripts/install.mjs --set all --check`,
    )
    return
  }

  const lines = ['[wt] an environment prerequisite has gone missing since adoption:']
  for (const item of result.missing) {
    lines.push(`  ${item.key} — absent. Consequence: ${item.consequence}.`)
  }
  // A warning with no exit becomes wallpaper, so name the way out in BOTH directions:
  // adopt it, or decide you do not want it. The second half matters — a user who
  // deliberately removed the key needs a way to stop being told about it that is not
  // "disable the hook".
  lines.push(
    `  Ends it: node <plugin>/skills/adopt/scripts/install.mjs --set all --install — which writes ` +
      `the key AND refreshes the adopted copies, so run it when you want both. Or declare the key ` +
      `yourself with any value you prefer: this checks that it is DECLARED, never what it holds, ` +
      `so setting it deliberately to something of your own also ends the warning.`,
  )
  lines.push(`  Checked: ${settingsPath} · adopted sets: ${adoptedSets.join(', ')}`)
  console.log(lines.join('\n'))
}

main()
