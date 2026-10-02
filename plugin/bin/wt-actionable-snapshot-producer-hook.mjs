#!/usr/bin/env node
// wt-actionable-snapshot-producer-hook.mjs — PostToolUse producer for the
// actionability snapshot wt-actionable-gate-hook.mjs (the Stop-hook consumer)
// reads. Card 1835531703: the consumer shipped and started firing on public
// main (286e473) with NOTHING ever writing the snapshot it consumes — the
// single file found on disk for this project had been hand-written once,
// 2026-08-04, and gone stale two days later. This hook is the producer that
// EXECUTES instead of relying on someone remembering to run a skill.
//
// WHY THIS SHAPE: the PostToolUse path reuses a complete Planka response the
// session already received. When that response would be too large for session
// context, wt-actionable-snapshot-refresh.mjs connects to the same local MCP
// endpoint and paginates internally, then calls produceSnapshot() with the one
// complete set. Both routes therefore share extraction, dependency parsing,
// validation, state, and journaling instead of growing two counting rules.
// A project that never uses Planka never triggers either route.
//
// WHAT IT DELIBERATELY DOES NOT DO: write a count on a PARTIAL read. A filtered
// find_cards call (list="Next" alone, say) returns real data but not the whole
// board — computing "actionable" from a subset is exactly the plausible-but-
// wrong number the card calls out by name. See extractCards() in
// actionability-planka-producer-core.mjs: a partial/unreadable/unparseable
// response makes this hook skip the snapshot, never a guess. A complete read
// without card descriptions (a get_board summary read) is refused the same way,
// because it cannot say which cards declare dependencies. It records why in
// a bounded state-directory journal so that refusal is no longer silent.
//
// DEPENDENCY RESOLUTION prefers the project's own parser when present, invoked
// in stdin mode as before. Projects without that file use the shipped parser
// in-process. Both paths require an explicit Depends-on line before a card
// can be counted as actionable; undeclared cards are reported separately.
//
// TRUST BOUNDARY, NAMED EXPLICITLY (review finding): `execFileSync` is called
// with an argument array, never a shell string, so there is no shell/path
// injection here. But it DOES execute arbitrary project-local code — any
// Planka read in a project carrying a file at that conventional path runs it
// with this process's environment. That is inherent to reusing the project's
// own parser rather than restating its rules (see above), not a bug to patch;
// it is a trust decision an adopter makes the moment they open a project here.

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { isInvokedDirectly } from './lib/host/entry-guard.mjs'
import { ACTIONABLE_REFRESH_COMMAND, projectStatePath, stateRoot, snapshotPath } from './lib/actionability-state-paths.mjs'
import { checkDescriptionsPresent, extractCards, computeSnapshot, resolveBoardProjectDir } from './lib/actionability-planka-producer-core.mjs'
import { parseDependsOn } from './lib/depends-on-parser.mjs'
import { stateRoot as priorArtStateRoot, cardIndexPath } from './lib/prior-art-state-paths.mjs'
import { buildCardIndex } from './lib/prior-art-index-core.mjs'

const DEPENDS_ON_PARSER_RELATIVE = '.claude/scripts/lib/depends-on-parser.mjs'
const BOARD_POINTER_RELATIVE = '.claude/planka.json'
const DEPENDS_ON_TIMEOUT_MS = Number(process.env.WT_ACTIONABLE_DEPS_TIMEOUT_MS || 5000)
const JOURNAL_MAX_ENTRIES = 100
const JOURNAL_FIELD_MAX_CHARS = 500
const MAX_SPILL_BYTES = Number(process.env.WT_ACTIONABLE_MAX_SPILL_BYTES || (8 * 1024 * 1024))

function boundedText(value) {
  return String(value ?? '').slice(0, JOURNAL_FIELD_MAX_CHARS)
}

function canonicalPath(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function isWithin(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
}

function allowedSpillRoots() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return [canonicalPath(tmpdir()), canonicalPath(dirname(stateRoot())), canonicalPath(join(configDir, 'projects'))]
}

// The CORE decides WHETHER a spill happened and hands us the path it read out of the
// harness's placeholder; this function decides whether that path may be read at all.
// Validation stays here, on the hook side, because the bound it enforces is about THIS
// machine's directories — an allow-list of temp/state roots, a plain file, a size cap —
// and a refusal is journaled rather than swallowed. `null` is the core's contract for
// "unavailable", so a refusal degrades to no snapshot, never to a guessed one.
function readValidatedSpillFile(cwd, spillPath) {
  const refuse = (reason) => {
    recordAttempt(cwd, false, 'spill-payload-refused', reason)
    return null
  }
  if (!isAbsolute(spillPath)) return refuse(`spill-path validation failed: not absolute (${spillPath})`)

  const roots = allowedSpillRoots()
  const canonicalSpillPath = canonicalPath(spillPath)
  if (!roots.some((root) => isWithin(root, canonicalSpillPath))) {
    return refuse(`spill-path validation failed: ${spillPath} is outside allowed temp/state roots (${roots.join(', ')})`)
  }

  let stat
  try {
    stat = lstatSync(spillPath)
  } catch (error) {
    return refuse(`spill-file unreadable: ${error?.message ?? error}`)
  }
  if (!stat.isFile()) return refuse(`spill-path validation failed: ${spillPath} is not a plain file`)
  if (stat.size > MAX_SPILL_BYTES) {
    return refuse(`spill-file too large: ${stat.size} bytes exceeds ${MAX_SPILL_BYTES}-byte bound`)
  }

  try {
    return readFileSync(spillPath, 'utf8')
  } catch (error) {
    return refuse(`spill-file read failed: ${error?.message ?? error}`)
  }
}

// Keep only the latest 100 one-line attempts. Fields are also truncated, so a
// malformed hook payload cannot defeat the entry-count bound with one huge line.
export function writeJournalEntry(root, cwd, ok, reason, detail) {
  try {
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

function recordAttempt(cwd, ok, reason, detail) { writeJournalEntry(stateRoot(), cwd, ok, reason, detail) }

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
    Number.isInteger(f.undeclared) && f.undeclared >= 0 &&
    typeof f.next === 'string' &&
    typeof f.workPossible === 'boolean' &&
    typeof f.reason === 'string' &&
    (f.blockedUntil === null || (typeof f.blockedUntil === 'number' && Number.isFinite(f.blockedUntil))) &&
    (f.inFlightUntil === null || (typeof f.inFlightUntil === 'number' && Number.isFinite(f.inFlightUntil)))
  )
}

// Writes the {id, name, listName} index wt-prior-art-launch-guard-hook.mjs
// reads. Only ever called with a `buildCardIndex()` result computed from a
// SUCCESSFUL extraction — never on a partial/unreadable read (main() does
// not call this function at all in that case), so this function itself has
// no "degrade gracefully" branch: an empty `cards: []` array reaching here
// is a genuinely empty board, not a degraded read, and is written as such.
function writeCardIndex(cwd, index) {
  const path = cardIndexPath(priorArtStateRoot(), cwd)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(index), 'utf8')
}

function writeSnapshot(cwd, fields) {
  const path = snapshotPath(stateRoot(), cwd)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(fields), 'utf8')
}

function writeProducerState(cwd, lastOutcome, lastReason = '', lastDetail = '') {
  const path = projectStatePath(stateRoot(), cwd)
  mkdirSync(dirname(path), { recursive: true })
  const state = { optedIn: true, heartbeatAt: Date.now(), lastOutcome, lastReason: boundedText(lastReason) }
  if (lastDetail) state.lastDetail = boundedText(lastDetail)
  writeFileSync(path, JSON.stringify(state), 'utf8')
}

// Records a refusal in the journal, then declares it in the producer state the Stop gate reads.
function refuseSnapshot(cwd, outcome, reason, detail) {
  recordAttempt(cwd, false, reason, detail)
  try {
    writeProducerState(cwd, outcome, reason, detail)
  } catch (error) {
    recordAttempt(cwd, false, 'producer-state-write-failed', error?.message ?? error)
  }
}

// For the refresh CLI: the board could not be read at all, so no hook ever ran. Declaring it keeps
// the Stop gate from reading an older heartbeat as a stale one.
export function recordBoardReadFailure(cwd, reason, detail) {
  refuseSnapshot(cwd, reason === 'board-unreachable' ? 'unreachable' : 'unavailable', reason, detail)
}

function recordExtractionFailure(cwd, extraction, spillRefused) {
  let reason = 'payload-unparseable'
  let detail = extraction.reason
  if (extraction.reason === 'no readable tool_response text') {
    reason = 'payload-diverted-or-too-large'
    detail = `Run exactly: ${ACTIONABLE_REFRESH_COMMAND}`
  } else if (extraction.reason.includes('result is a subset')) reason = 'partial-payload'
  recordAttempt(cwd, false, reason, detail)
  return spillRefused ? 'spill-payload-refused' : reason
}

export function produceSnapshot(input) {
  if (input.hook_event_name && input.hook_event_name !== 'PostToolUse') return
  const toolName = input.tool_name
  if (toolName !== 'mcp__planka__get_board' && toolName !== 'mcp__planka__find_cards') return

  // Normalize the triggering cwd, then walk to the project pointer. The
  // consumer receives that session project root as its cwd, so both sides key
  // the snapshot to the same directory even when this call came from a nested
  // repository or worktree.
  const triggeringCwd = typeof input.cwd === 'string' && input.cwd ? resolve(input.cwd) : ''
  if (!triggeringCwd) return
  // The board pointer gates the ACTIONABILITY SNAPSHOT, never the read itself.
  // Resolving it here but deferring the refusal keeps the prior-art index below
  // reachable on a project that has no pointer at all — which is exactly what
  // that index's own comment promises, and what a straight early return silently
  // took away.
  const boardProjectDir = resolveBoardProjectDir(triggeringCwd, existsSync)
  const journalDir = boardProjectDir || triggeringCwd
  // Journaled HERE so the record keeps its place at the head of the journal, but
  // deliberately WITHOUT returning: a missing pointer is a permanent property of
  // the project, not a reason to skip the read.
  if (!boardProjectDir) {
    recordAttempt(triggeringCwd, false, 'no-board-pointer', `no ${BOARD_POINTER_RELATIVE} for this project or its ancestors`)
  } else {
    try {
      writeProducerState(boardProjectDir, 'reading')
    } catch (error) {
      recordAttempt(boardProjectDir, false, 'producer-state-write-failed', error?.message ?? error)
    }
  }

  let spillRefused = false
  const extraction = extractCards({
    toolName,
    toolInput: input.tool_input,
    toolResponse: input.tool_response,
    readSpilledFile: (path) => {
      const text = readValidatedSpillFile(journalDir, path)
      if (text === null) spillRefused = true
      return text
    },
  })
  if (!extraction.ok) {
    const reason = recordExtractionFailure(journalDir, extraction, spillRefused)
    if (boardProjectDir) {
      try {
        writeProducerState(boardProjectDir, 'unreachable', reason)
      } catch (error) {
        recordAttempt(boardProjectDir, false, 'producer-state-write-failed', error?.message ?? error)
      }
    }
    return // partial/unreadable read — never write a guess
  }

  // PRIOR-ART CARD-TITLE INDEX. Deliberately independent of the
  // board-pointer gating below: the title index needs
  // only {id, name, listName}, which extraction() already guarantees on
  // `ok` — it is written on ANY successful read, including a project with
  // no `.claude/planka.json` (the
  // actionability snapshot below stays silent for such a project; this
  // index does not have to, because it answers a different question). A
  // write failure here must never affect the actionability snapshot logic
  // that follows, and vice versa — same fail-open posture as every other
  // write in this hook.
  try {
    writeCardIndex(journalDir, buildCardIndex(extraction.cards, Date.now()))
  } catch (error) {
    recordAttempt(journalDir, false, 'prior-art-index-write-failed', error?.message ?? error)
  }

  // From here down the work IS the actionability snapshot, which is meaningless
  // without a board pointer. The refusal was already journaled above.
  if (!boardProjectDir) return
  const cwd = boardProjectDir
  const descriptions = checkDescriptionsPresent({ toolName, toolInput: input.tool_input, extraction })
  if (!descriptions.ok) return refuseSnapshot(cwd, 'unreachable', 'descriptions-missing', descriptions.reason)

  const parserPath = join(cwd, DEPENDS_ON_PARSER_RELATIVE)
  const projectParser = existsSync(parserPath)
  const resolveDeps = projectParser ? makeDepsResolver(parserPath) : parseDependsOn

  const boardId =
    (input.tool_input && typeof input.tool_input === 'object' && typeof input.tool_input.boardId === 'string')
      ? input.tool_input.boardId
      : undefined

  let snapshot
  try {
    snapshot = computeSnapshot({ cards: extraction.cards, resolveDeps, boardId, now: Date.now(), parserKind: projectParser ? 'project parser' : 'shipped parser' })
  } catch (error) {
    // A card's dependency line could not be resolved (parser died mid-scan) — write nothing.
    return refuseSnapshot(cwd, 'unavailable', 'snapshot-computation-failed', error?.message ?? error)
  }

  const fields = {
    at: snapshot.at,
    actionable: snapshot.actionable,
    undeclared: snapshot.undeclared,
    next: snapshot.next,
    workPossible: snapshot.workPossible,
    reason: snapshot.reason,
    blockedUntil: snapshot.blockedUntil,
    inFlightUntil: snapshot.inFlightUntil,
    countedScope: snapshot.countedScope,
  }
  if (!isValidSnapshotFields(fields)) {
    return refuseSnapshot(cwd, 'unavailable', 'snapshot-invalid', 'computed snapshot failed field validation')
  }

  // Two writes, two failure reasons: the snapshot-file remedy is only true of the snapshot write.
  // Writing must never turn this hook into a blocker — the consumer's own fail-closed
  // missing/stale path is the safety net if either write fails.
  try {
    writeSnapshot(cwd, fields)
  } catch (error) {
    return refuseSnapshot(cwd, 'unavailable', 'snapshot-write-failed', error?.message ?? error)
  }
  recordAttempt(cwd, true, 'snapshot-written', snapshot.countedScope)
  try {
    writeProducerState(cwd, 'snapshot-written')
  } catch (error) {
    recordAttempt(cwd, false, 'producer-state-write-failed', error?.message ?? error)
  }
}

function main() {
  let input
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {
    return
  }
  produceSnapshot(input)
}

if (isInvokedDirectly(import.meta.url)) {
  runFailOpenHook('wt-actionable-snapshot-producer-hook.mjs', main)
}
