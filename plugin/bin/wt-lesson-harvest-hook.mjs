#!/usr/bin/env node
// Stop hook: surfaces the reusable lessons a closure report carries, at the moment the report
// appears, without anyone having to remember to look.
//
// WHY A HOOK AND NOT THE SKILL. The extraction already exists as
// `skills/lesson-harvest/scripts/harvest-lessons.mjs`, and a rule already names it and says when to
// run it. Neither fires. Measured on this machine: 0 skill invocations out of 37 came from
// description matching alone, and the rule that names the script records its own failure rate —
// eight reports carrying three to six lessons each, three harvested by hand, the rest never read
// again. A must-happen-every-time behaviour was sitting at the rung reserved for facts you look up
// when you already suspect them.
//
// The trigger is what makes this hook-shaped rather than another instruction: a report file exists
// and it is newer than the last time this ran. No judgment, so no guard that fires on correct work.
//
// ⚠ IT ONLY SURFACES. It never writes to a knowledge base — that stays with the single session
// that integrates the card, which is the constraint the harvester itself was built around. This
// hook moves the lessons in front of a reader; deciding what becomes a durable note, under what
// name, deduplicated against what already exists, is judgment it must not simulate.
//
// ⚠ HONEST SCOPE, and the uncovered half is the larger one. This covers lessons that reached a
// REPORT. A correction that arrives mid-conversation has no report to harvest, and three of the
// most useful facts of one measured night belonged to no card at all. The existence of this hook
// must not be read as full coverage of self-improvement.
//
// Configuration, all optional:
//   WT_LESSON_HARVEST_DIRS   colon-separated report directories (default: the conventional ones)
//   WT_LESSON_HARVEST_STATE  state file path (default: under the shared wt state root)
//   WT_LESSON_HARVEST_OFF    any non-empty value disables it entirely

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HARVESTER = path.join(HERE, '..', 'skills', 'lesson-harvest', 'scripts', 'harvest-lessons.mjs')

// A hook that throws is a hook that breaks the turn it was meant to help. Every failure below
// exits 0 in silence: this is an advisory, and an advisory that can break a session is not worth
// having. The cost of that choice is stated rather than hidden — a broken harvester goes unnoticed
// here, which is why the skill remains invocable by hand.
function quit() {
  process.exit(0)
}

if (process.env.WT_LESSON_HARVEST_OFF) quit()

let input = {}
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}')
} catch {
  quit()
}

const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd()

// ⚠ The default list is a CONVENTION, not a discovery. A project whose reports live elsewhere gets
// silence — which is indistinguishable from "no lessons", the exact ambiguity this file exists to
// remove one level up. So the banner on first run names where it looked; see below.
const defaultDirs = [
  path.join(cwd, '.claude', 'reports'),
  path.join(cwd, '.claude', 'pilots'),
]
const dirs = (process.env.WT_LESSON_HARVEST_DIRS || '').split(':').filter(Boolean)
const searchDirs = dirs.length ? dirs : defaultDirs

const stateRoot = process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state')
const slug = `${cwd.replace(/[^A-Za-z0-9]/g, '-').slice(0, 120)}`
const statePath = process.env.WT_LESSON_HARVEST_STATE || path.join(stateRoot, 'wt-lesson-harvest', `${slug}.json`)

function loadSeen() {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function saveSeen(seen) {
  try {
    mkdirSync(path.dirname(statePath), { recursive: true })
    writeFileSync(statePath, `${JSON.stringify(seen, null, 2)}\n`, 'utf8')
  } catch {
    // A state file that cannot be written means the same report is offered again next turn.
    // Repeating is a far better failure than losing the only chance to surface it.
  }
}

// Bounded: a report tree grows without limit, and a hook that walks an unbounded tree at every turn
// end pays that cost forever. Depth 3 covers <dir>/<wave>/<report>.md, which is the shape in use.
function collectReports(dir, depth = 0, out = []) {
  if (depth > 3 || out.length > 400) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) collectReports(full, depth + 1, out)
    else if (e.isFile() && e.name.endsWith('.md')) out.push(full)
  }
  return out
}

function harvest(file) {
  try {
    const raw = execFileSync(process.execPath, [HARVESTER, file, '--json'], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return JSON.parse(raw)
  } catch {
    // Exit 2 (no section at all) and exit 1 (unreadable) both land here. Both stay SILENT by
    // design: a markdown file with no lessons section is the overwhelming majority of what this
    // walk sees, and a hook that spoke about each one would be switched off within a day, taking
    // its real case with it.
    return null
  }
}

const seen = loadSeen()
const fresh = []

for (const dir of searchDirs) {
  for (const file of collectReports(dir)) {
    let mtime
    try {
      mtime = statSync(file).mtimeMs
    } catch {
      continue
    }
    if (seen[file] === mtime) continue
    const result = harvest(file)
    // Record every file examined, not only the ones that yielded lessons — otherwise a report
    // without lessons is re-harvested at every single turn end, forever.
    seen[file] = mtime
    if (result?.hasLessons && Array.isArray(result.items) && result.items.length) {
      fresh.push({ file, count: result.items.length })
    }
  }
}

saveSeen(seen)

if (!fresh.length) quit()

// ⚠ It names the reports and their counts, NOT the lessons themselves. A Stop hook's output is
// visible to the human as well as the model, and injecting several verbatim lessons at every turn
// end would be heavy enough to become the thing people want silenced. The path is the actionable
// part: whoever integrates the card opens it.
const lines = fresh.map((f) => `  ${f.count} lesson(s) — ${f.file}`).join('\n')
const context =
  `[for Claude, not the user] Unharvested lessons in ${fresh.length} closure report(s):\n${lines}\n` +
  'Read them and decide what becomes a durable note — this hook only surfaces; it never writes to the knowledge base.'

process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: context } })}\n`)
process.exit(0)
