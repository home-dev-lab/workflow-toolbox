#!/usr/bin/env node
// wt-actionable-snapshot-producer-hook.mjs — PostToolUse producer for the
// actionability snapshot wt-actionable-gate-hook.mjs (the Stop-hook consumer)
// reads. Card 1835531703: the consumer shipped and started firing on public
// main (286e473) with NOTHING ever writing the snapshot it consumes — the
// single file found on disk for this project had been hand-written once,
// 2026-08-04, and gone stale two days later. This hook is the producer that
// EXECUTES instead of relying on someone remembering to run a skill.
//
// WHY THIS SHAPE (a PostToolUse hook, not a SessionStart timer): a hook is a
// plain node process with no MCP connection and no model — it cannot itself
// call the Planka MCP server to read the board. What it CAN do is react to a
// call the session already made, reading the same tool_response the model
// already received. Wiring on mcp__planka__get_board and an UNFILTERED
// mcp__planka__find_cards means the snapshot refreshes automatically every
// time a session reads the whole board — no separate gesture, no new habit to
// forget. A project that never uses Planka never triggers this hook at all:
// it is safe to ship broadly.
//
// WHAT IT DELIBERATELY DOES NOT DO: write a count on a PARTIAL read. A filtered
// find_cards call (list="Next" alone, say) returns real data but not the whole
// board — computing "actionable" from a subset is exactly the plausible-but-
// wrong number the card calls out by name. See extractCards() in
// actionability-planka-producer-core.mjs: a partial/unreadable/unparseable
// response makes this hook skip the snapshot, never a guess. It records why in
// a bounded state-directory journal so that refusal is no longer silent.
//
// DEPENDENCY RESOLUTION REUSES THE PROJECT'S OWN PARSER, NOT A RESTATEMENT OF
// ITS RULES. An adopting project's own what-next skill has already measured
// the failure this guards against: a prose restatement of the Depends-on
// parsing rule, written into that skill's own doc, silently under-covered 7
// of 8 real dependency lines because a line the restated rule could not parse
// read as "no dependency" instead of "unresolved". So this hook
// shells out to <project>/.claude/scripts/lib/depends-on-parser.mjs (stdin
// mode) when that file exists, and writes NOTHING when it does not — a
// project without that convention gets silence, never a wrong count.
//
// TRUST BOUNDARY, NAMED EXPLICITLY (review finding): `execFileSync` is called
// with an argument array, never a shell string, so there is no shell/path
// injection here. But it DOES execute arbitrary project-local code — any
// Planka read in a project carrying a file at that conventional path runs it
// with this process's environment. That is inherent to reusing the project's
// own parser rather than restating its rules (see above), not a bug to patch;
// it is a trust decision an adopter makes the moment they open a project here.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'

import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { stateRoot, snapshotPath } from './lib/actionability-state-paths.mjs'
import { readSpilledFileGuarded } from './lib/spill-containment.mjs'
import { extractCards, computeSnapshot, resolveBoardProjectDir } from './lib/actionability-planka-producer-core.mjs'

const DEPENDS_ON_PARSER_RELATIVE = '.claude/scripts/lib/depends-on-parser.mjs'
const BOARD_POINTER_RELATIVE = '.claude/planka.json'
const DEPENDS_ON_TIMEOUT_MS = Number(process.env.WT_ACTIONABLE_DEPS_TIMEOUT_MS || 5000)
const JOURNAL_MAX_ENTRIES = 100
const JOURNAL_FIELD_MAX_CHARS = 500

function boundedText(value) {
  return String(value ?? '').slice(0, JOURNAL_FIELD_MAX_CHARS)
}

// Keep only the latest 100 one-line attempts. Fields are also truncated, so a
// malformed hook payload cannot defeat the entry-count bound with one huge line.
function recordAttempt(cwd, ok, reason, detail) {
  try {
    const root = stateRoot()
    const path = join(root, 'actionable-producer-journal.jsonl')
    mkdirSync(root, { recursive: true })
    let lines = []
    try {
      lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).slice(-(JOURNAL_MAX_ENTRIES - 1))
    } catch {
      // A missing or unreadable old journal must not suppress the current record.
    }
    lines.push(JSON.stringify({
      at: Date.now(),
      ok,
      reason: boundedText(reason),
      detail: boundedText(detail),
      projectDir: boundedText(cwd),
    }))
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
  } catch {
    // Observed tool calls must remain fail-open even when diagnostics cannot be written.
  }
}

// Spawns the project's own dependency parser, one call per card. A missing
// binary, a timeout, a non-JSON reply, OR a reply whose `ids`/`unparseable`
// are not arrays all count as "cannot resolve" and THROW — the caller (main())
// aborts the whole write on any throw. Coercing a malformed reply to `[]`
// instead of throwing was a real defect (review finding): `{}` or
// `{ids:"bad"}` would have silently read as "no dependency" — exactly the
// wrong-answer-not-silence failure this producer exists to refuse.
function makeDepsResolver(parserPath) {
  return (description) => {
    const out = execFileSync(process.execPath, [parserPath], {
      input: description || '',
      encoding: 'utf8',
      timeout: DEPENDS_ON_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const parsed = JSON.parse(out)
    if (!Array.isArray(parsed?.ids) || !Array.isArray(parsed?.unparseable)) {
      throw new Error('depends-on-parser reply has non-array ids/unparseable')
    }
    return { ids: parsed.ids.map(String), unparseable: parsed.unparseable }
  }
}

function isValidSnapshotFields(f) {
  return (
    typeof f.at === 'number' && Number.isFinite(f.at) &&
    typeof f.actionable === 'number' && Number.isFinite(f.actionable) && f.actionable >= 0 &&
    typeof f.next === 'string' &&
    typeof f.workPossible === 'boolean' &&
    typeof f.reason === 'string' &&
    (f.blockedUntil === null || (typeof f.blockedUntil === 'number' && Number.isFinite(f.blockedUntil))) &&
    (f.inFlightUntil === null || (typeof f.inFlightUntil === 'number' && Number.isFinite(f.inFlightUntil)))
  )
}

function writeSnapshot(cwd, fields) {
  const path = snapshotPath(stateRoot(), cwd)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(fields), 'utf8')
}

function main() {
  let input
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {
    return
  }

  if (input.hook_event_name && input.hook_event_name !== 'PostToolUse') return
  const toolName = input.tool_name
  if (toolName !== 'mcp__planka__get_board' && toolName !== 'mcp__planka__find_cards') return

  // Normalize the triggering cwd, then walk to the project pointer. The
  // consumer receives that session project root as its cwd, so both sides key
  // the snapshot to the same directory even when this call came from a nested
  // repository or worktree.
  const triggeringCwd = typeof input.cwd === 'string' && input.cwd ? resolve(input.cwd) : ''
  if (!triggeringCwd) return
  const cwd = resolveBoardProjectDir(triggeringCwd, existsSync)
  if (!cwd) {
    recordAttempt(triggeringCwd, false, 'no-board-pointer', `no ${BOARD_POINTER_RELATIVE} for this project or its ancestors`)
    return
  }

  const extraction = extractCards({
    toolName,
    toolInput: input.tool_input,
    toolResponse: input.tool_response,
    readSpilledFile: readSpilledFileGuarded,
  })
  if (!extraction.ok) {
    if (extraction.reason === 'no readable tool_response text') {
      recordAttempt(cwd, false, 'payload-diverted-or-too-large', extraction.reason)
    } else if (extraction.reason.includes('result is a subset')) {
      recordAttempt(cwd, false, 'partial-payload', extraction.reason)
    } else {
      recordAttempt(cwd, false, 'payload-unparseable', extraction.reason)
    }
    return // partial/unreadable read — never write a guess
  }

  const parserPath = join(cwd, DEPENDS_ON_PARSER_RELATIVE)
  if (!existsSync(parserPath)) {
    recordAttempt(cwd, false, 'dependency-parser-unavailable', `no ${DEPENDS_ON_PARSER_RELATIVE} for this project`)
    return // no known dependency convention here — never write a wrong count
  }

  let resolveDeps
  try {
    resolveDeps = makeDepsResolver(parserPath)
  } catch (error) {
    recordAttempt(cwd, false, 'dependency-parser-unavailable', error?.message ?? error)
    return
  }

  const boardId =
    (input.tool_input && typeof input.tool_input === 'object' && typeof input.tool_input.boardId === 'string')
      ? input.tool_input.boardId
      : undefined

  let snapshot
  try {
    snapshot = computeSnapshot({ cards: extraction.cards, resolveDeps, boardId, now: Date.now() })
  } catch (error) {
    recordAttempt(cwd, false, 'snapshot-computation-failed', error?.message ?? error)
    return // a card's dependency line could not be resolved (parser died mid-scan) — write nothing
  }

  const fields = {
    at: snapshot.at,
    actionable: snapshot.actionable,
    next: snapshot.next,
    workPossible: snapshot.workPossible,
    reason: snapshot.reason,
    blockedUntil: snapshot.blockedUntil,
    inFlightUntil: snapshot.inFlightUntil,
    countedScope: snapshot.countedScope,
  }
  if (!isValidSnapshotFields(fields)) {
    recordAttempt(cwd, false, 'snapshot-invalid', 'computed snapshot failed field validation')
    return
  }

  try {
    writeSnapshot(cwd, fields)
    recordAttempt(cwd, true, 'snapshot-written', snapshot.countedScope)
  } catch (error) {
    recordAttempt(cwd, false, 'snapshot-write-failed', error?.message ?? error)
    // Writing must never turn this hook into a blocker — the consumer's own
    // fail-closed missing/stale path is the safety net if this write fails.
  }
}

runFailOpenHook('wt-actionable-snapshot-producer-hook.mjs', main)
