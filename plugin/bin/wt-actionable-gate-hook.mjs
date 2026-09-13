#!/usr/bin/env node
// wt-actionable-gate-hook.mjs — Stop hook consumer for a tracker-agnostic
// actionability snapshot. The producer decides what is STARTABLE; this hook only
// enforces the contract's stop-time invariants.
// External-lane detection is Linux-only; unsupported platforms and detection errors
// degrade legibly to transcript and declared-bound evidence.

import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { decide } from './lib/actionability-core.mjs'
import { classifyMandate } from './lib/autonomy-mandate.mjs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { recordGuardEvent } from './lib/guard-journal.mjs'
import {
  stateRoot,
  projectStatePath,
  sessionStatePath as sharedSessionStatePath,
  snapshotPath as sharedSnapshotPath,
} from './lib/actionability-state-paths.mjs'

const STALE_AFTER_MS = Number(process.env.WT_ACTIONABLE_STALE_AFTER_MS || 2 * 60 * 60 * 1000)
const BLOCK_MAX = Number(process.env.WT_ACTIONABLE_BLOCK_MAX || 3)
const INFLIGHT_MS = Number(process.env.WT_ACTIONABLE_INFLIGHT_MS || 3 * 60 * 1000)
// Caps a DECLARED inFlightUntil from the moment the snapshot was WRITTEN (snapshot.at), never
// from "now" — see actionability-core.mjs for why the asymmetry matters (a generous bound
// silences the gate for its whole window; capping from `at` makes a stale claim expire).
const INFLIGHT_CAP_MS = Number(process.env.WT_ACTIONABLE_INFLIGHT_CAP_MS || 10 * 60 * 1000)
const LANE_ANCESTOR_DEPTH = Number(process.env.WT_ACTIONABLE_LANE_ANCESTOR_DEPTH || 4)
const LANE_SELF_EXCLUDE_DEPTH = 32
const MANDATE_FRESHNESS_MS = Number(process.env.WT_AUTONOMY_WATCH_MANDATE_FRESHNESS_MINUTES || 480) * 60_000

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {
    return {}
  }
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function lanePatterns() {
  const raw = process.env.WT_ACTIONABLE_LANE_PATTERNS
  const patterns = typeof raw === 'string' && raw.trim() ? raw.split(',').map((value) => value.trim()).filter(Boolean) : ['opencode run', 'codex exec']
  return patterns.length > 0 ? patterns : ['opencode run', 'codex exec']
}

function snapshotPath(root, cwd) {
  return sharedSnapshotPath(root, cwd)
}

function sessionStatePath(root, cwd, sessionId) {
  return sharedSessionStatePath(root, cwd, sessionId)
}

function mandatePath(cwd) {
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  const mandateDir = process.env.WT_AUTONOMY_WATCH_MANDATE_DIR || join(stateHome, 'wt-queue-gate')
  const projectSlug = resolve(cwd).replace(/[^A-Za-z0-9-]/g, '-')
  return join(mandateDir, `engine-${projectSlug}.json`)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value), 'utf8')
}

function readProjectState(path) {
  try {
    const parsed = readJson(path)
    if (!parsed || typeof parsed !== 'object' || parsed.optedIn !== true) return { optedIn: false }
    return {
      optedIn: true,
      heartbeatAt: finiteNumber(parsed.heartbeatAt) ? parsed.heartbeatAt : null,
      lastOutcome: typeof parsed.lastOutcome === 'string' ? parsed.lastOutcome : '',
    }
  } catch {
    return { optedIn: false }
  }
}

function readSessionState(path) {
  try {
    const parsed = readJson(path)
    const value = parsed?.consecutiveBlocks
    return {
      consecutiveBlocks: finiteNumber(value) && value >= 0 ? value : 0,
      staleSnapshotAt: finiteNumber(parsed?.staleSnapshotAt) ? parsed.staleSnapshotAt : null,
    }
  } catch {
    return { consecutiveBlocks: 0, staleSnapshotAt: null }
  }
}

function isSnapshotObject(parsed) {
  return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
}

function normalizeSnapshot(parsed) {
  if (!isSnapshotObject(parsed)) return null
  const at = parsed.at
  const actionable = parsed.actionable
  const next = parsed.next
  const workPossible = parsed.workPossible
  const reason = parsed.reason
  const blockedUntil = parsed.blockedUntil
  const inFlightUntil = parsed.inFlightUntil
  if (!finiteNumber(at)) return null
  if (!finiteNumber(actionable) || actionable < 0) return null
  if (typeof next !== 'string') return null
  if (typeof workPossible !== 'boolean') return null
  if (typeof reason !== 'string') return null
  if (!(blockedUntil === null || finiteNumber(blockedUntil))) return null
  if (!(inFlightUntil === null || finiteNumber(inFlightUntil))) return null
  return { status: 'present', at, actionable, next, workPossible, reason, blockedUntil, inFlightUntil }
}

function readSnapshot(root, cwd, now) {
  const snapPath = snapshotPath(root, cwd)
  const projectState = readProjectState(projectStatePath(root, cwd))
  if (!existsSync(snapPath)) {
    return projectState.optedIn ? { status: 'missing', producer: projectState } : { status: 'never' }
  }

  try {
    if (!projectState.optedIn) writeJson(projectStatePath(root, cwd), { optedIn: true, seenAt: now })
  } catch {
    return { status: 'invalid' }
  }

  try {
    const normalized = normalizeSnapshot(readJson(snapPath))
    return normalized ? { ...normalized, producer: projectState } : { status: 'invalid' }
  } catch {
    return { status: 'invalid' }
  }
}

function hasInFlightWork(transcriptPath, sessionId, now) {
  const subagentsDir = join(dirname(resolve(transcriptPath)), sessionId, 'subagents')
  const cutoff = now - INFLIGHT_MS
  try {
    for (const entry of readdirSync(subagentsDir)) {
      if (!entry.endsWith('.jsonl')) continue
      if (statSync(join(subagentsDir, entry)).mtimeMs >= cutoff) return true
    }
  } catch {
    return false
  }
  return false
}

function nearAncestorsOf(pid, depth, fixture) {
  const out = new Set()
  let current = Number(pid)
  for (let i = 0; i < depth && current > 1; i += 1) {
    const stat = fixture ? null : readFileSync(`/proc/${current}/stat`, 'utf8')
    const ppid = fixture ? fixture.processes.get(current)?.ppid : Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    if (!Number.isInteger(ppid) || ppid <= 1) break
    out.add(ppid)
    current = ppid
  }
  return out
}

function intersects(left, right) {
  for (const value of left) {
    if (right.has(value)) return true
  }
  return false
}

function listMatchingPids(pattern, fixture) {
  if (fixture) {
    return {
      kind: 'ok',
      pids: [...fixture.processes.values()]
        .filter((process) => process.patterns.includes(pattern) || process.command.includes(pattern))
        .map((process) => process.pid),
    }
  }
  try {
    const out = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return {
      kind: 'ok',
      pids: out
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean)
        .map(Number)
        .filter((value) => Number.isInteger(value) && value > 0),
    }
  } catch (error) {
    if (error && error.status === 1) return { kind: 'ok', pids: [] }
    return { kind: 'error', reason: error instanceof Error ? error.message : String(error) }
  }
}

function readLaneFixture() {
  const path = process.env.WT_ACTIONABLE_LANE_FIXTURE_PATH
  if (!path) return { kind: 'absent' }
  try {
    const parsed = readJson(path)
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.processes) || !Number.isInteger(parsed.hookPid)) {
      throw new Error('fixture must contain hookPid and processes')
    }
    const processes = new Map()
    for (const entry of parsed.processes) {
      if (!entry || typeof entry !== 'object' || !Number.isInteger(entry.pid) || !Number.isInteger(entry.ppid) ||
        typeof entry.cwd !== 'string' || typeof entry.command !== 'string' || !Array.isArray(entry.patterns) ||
        !entry.patterns.every((pattern) => typeof pattern === 'string')) {
        throw new Error('fixture process is invalid')
      }
      processes.set(entry.pid, entry)
    }
    return { kind: 'present', hookPid: parsed.hookPid, processes }
  } catch (error) {
    return { kind: 'error', reason: `lane fixture: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function safeProjectRoot(cwd) {
  try {
    return realpathSync(cwd)
  } catch {
    return resolve(cwd)
  }
}

function isSameOrNestedPath(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}/`)
}

function detectExternalLane(cwd) {
  const detectionMode = process.env.WT_ACTIONABLE_LANE_DETECTION_MODE
  if (detectionMode === 'unsupported') return { kind: 'unsupported', reason: 'forced unsupported for tests' }

  const fixture = readLaneFixture()
  if (fixture.kind === 'error') return fixture

  // Degraded path is explicit: this detection relies on Linux /proc for cwd + ppid and on
  // `pgrep -f` to match the invocation without printing command lines. Elsewhere the hook must
  // fall back to transcripts plus the declared bound, not pretend it checked and found nothing.
  if (fixture.kind === 'absent' && process.platform !== 'linux') {
    return { kind: 'unsupported', reason: `external lane detection requires linux /proc + pgrep (got ${process.platform})` }
  }

  try {
    const scanner = fixture.kind === 'present' ? fixture : null
    const hookPid = scanner?.hookPid ?? process.pid
    const hookNear = nearAncestorsOf(hookPid, LANE_ANCESTOR_DEPTH, scanner)
    const hookSelfAndAncestors = new Set([hookPid, ...nearAncestorsOf(hookPid, LANE_SELF_EXCLUDE_DEPTH, scanner)])
    const projectRoot = safeProjectRoot(cwd)

    for (const pattern of lanePatterns()) {
      const matches = listMatchingPids(pattern, scanner)
      if (matches.kind !== 'ok') return matches
      for (const pid of matches.pids) {
        if (hookSelfAndAncestors.has(pid)) continue
        const laneRoot = scanner ? scanner.processes.get(pid)?.cwd : readlinkSync(`/proc/${pid}/cwd`)
        if (typeof laneRoot !== 'string') throw new Error(`missing cwd for lane pid ${pid}`)
        if (!isSameOrNestedPath(laneRoot, projectRoot)) continue
        if (intersects(hookNear, nearAncestorsOf(pid, LANE_ANCESTOR_DEPTH, scanner))) {
          return { kind: 'running', pid, pattern }
        }
      }
    }
    return { kind: 'idle' }
  } catch (error) {
    return { kind: 'error', reason: error instanceof Error ? error.message : String(error) }
  }
}

const CONTEXT_LOUD_PCT = Number(process.env.WT_ACTIONABLE_CONTEXT_PCT || 70)

// ⚠ WHY A CONTEXT CLAUSE BELONGS IN A *STOP* HOOK — measured 2026-08-06, and the asymmetry is
// the whole argument. Guidance for a filling window already existed on this machine, in a hook
// that measures context every turn and says "keep going, compaction fires and resumes". It is
// registered on UserPromptSubmit — so it speaks only when the USER types, and stays silent for
// the entire length of an autonomous stretch, which is exactly the stretch during which a
// session decides, alone, to wind down. The advice existed and structurally could not arrive.
//
// Quota has no such hole: a watcher emits on its own and wakes an idle session, so "a limit is
// a door, not a wall" lands AT the deciding moment. Context had only a rule read at session
// start — weakest precisely when the window is full and that rule is furthest away.
//
// A Stop hook fires at every turn end, which IS the deciding moment. Naming the non-reason here
// costs one clause and closes the gap.
function contextPct(transcriptPath) {
  try {
    const size = statSync(transcriptPath).size
    const span = Math.min(size, 262_144)
    const lines = readFileSync(transcriptPath, 'utf8').slice(-span).split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (line === '') continue
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        continue // the first record in the byte window may be cut mid-line
      }
      if (parsed?.subtype === 'compact_boundary') return null // just compacted — nothing to say
      const u = parsed?.type === 'assistant' ? parsed?.message?.usage : null
      if (u && typeof u.input_tokens === 'number') {
        const used = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        const budget = used > 200_000 ? 1_000_000 : 200_000
        return Math.round((used / budget) * 1000) / 10
      }
    }
  } catch {
    /* unreadable ⇒ no opinion, like every other probe in this file */
  }
  return null
}

function renderBlock(decision, blockMax, ctxPct, snapshot, now, externalLane, mandateKind) {
  // Factual, not imperative — see the emission comment in main() for why. Keep the exact
  // substrings 'actionable item(s) remain' and 'Block N of M':
  // the test suite matches on them, and they carry the state a resuming reader needs.
  let actionableLine
  if (finiteNumber(decision.actionable)) {
    actionableLine = `${decision.actionable} actionable item(s) remain.`
  } else if (finiteNumber(snapshot?.producer?.heartbeatAt) &&
    now - snapshot.producer.heartbeatAt <= STALE_AFTER_MS &&
    snapshot.producer.lastOutcome !== 'reading' && snapshot.producer.lastOutcome !== 'snapshot-written') {
    actionableLine = 'Actionability producer could not read the board — check the tracker.'
  } else if (decision.reason === 'snapshot-missing') {
    actionableLine = 'Actionability producer is declared but has not reported a heartbeat — wire the producer.'
  } else if (!finiteNumber(snapshot?.producer?.heartbeatAt)) {
    actionableLine = 'Actionability state cannot be distinguished from legacy snapshot evidence — check the tracker.'
  } else {
    actionableLine = 'Producer heartbeat is stale; refresh the board snapshot.'
  }
  if (decision.reason === 'snapshot-stale' && !actionableLine.includes('refresh the board snapshot')) {
    actionableLine += ' Refresh the board snapshot.'
  }
  const nextLine = decision.next ? decision.next : 'unknown'
  // ⚠ ONE LINE, and the length lock below is what keeps it that way.
  // Measured 2026-08-06 on this harness: NO Stop-hook emission shape hides its text from the
  // USER's terminal. `decision:block` renders as "Stop hook error"; `additionalContext` renders
  // as "Stop hook feedback". The docs' "does not appear as a chat message" is true and beside
  // the point — it still renders in the hook-results block the user reads. So LENGTH is the
  // only lever anyone has demonstrated, and every line here is charged to a human who did not
  // ask for it. Explanation belongs in the repo, never in a message that fires every turn.
  // ⚠ THE WORDING IS MECHANICAL, NOT MOTIVATIONAL — "emitting tokens", never "working".
  // The door is ALREADY OPEN: compaction is automatic and the passage costs nothing. What a
  // stopped session lacks is not force, it is MOTION — and stopping freezes the window, so the
  // compaction it was waiting for never comes. "Keep working" fails here because work is a human
  // abstraction whose content shifts with the job: a model that has just written a long report
  // can sincerely conclude it worked, and stop. Token emission is the one thing literally true of
  // every model in every task AND the actual mechanism that advances the window.
  const ctxClause =
    ctxPct !== null && ctxPct !== undefined && ctxPct >= CONTEXT_LOUD_PCT
      ? ` Context ~${ctxPct}%: the door is already open — you cross it by emitting tokens, never by falling silent.`
      : ''
  const mandateClause = mandateKind === 'unknown' ? ' Autonomy mandate could not be read.' : ''
  const laneClause = externalLane.kind === 'unsupported' || externalLane.kind === 'error'
    ? ` lane detection unavailable: ${externalLane.reason.split(/\r?\n/, 1)[0]}.`
    : ''
  const effectiveBlockMax = decision.reason === 'snapshot-stale' ? 1 : blockMax
  return `[for Claude, not the user] Actionability gate:${mandateClause} ${actionableLine} Next: ${nextLine}.${ctxClause} Block ${decision.nextConsecutiveBlocks} of ${effectiveBlockMax}.${laneClause}`
}

function main() {
  const input = readInput()
  if (input.hook_event_name && input.hook_event_name !== 'Stop') return

  const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : ''
  const sessionId = typeof input.session_id === 'string' ? input.session_id : ''
  const cwd = typeof input.cwd === 'string' ? resolve(input.cwd) : ''
  if (!transcriptPath || !sessionId || !cwd) return

  const now = Date.now()
  const root = stateRoot()
  const snapshot = readSnapshot(root, cwd, now)
  if (snapshot.status === 'invalid') return

  const mandate = classifyMandate(mandatePath(cwd), MANDATE_FRESHNESS_MS, now, sessionId)
  const protectsStop = mandate.kind === 'live' || mandate.kind === 'unknown'
  const externalLane = protectsStop ? detectExternalLane(cwd) : { kind: 'idle' }

  const sessionPath = sessionStatePath(root, cwd, sessionId)
  const sessionState = readSessionState(sessionPath)
  const decision = decide({
    snapshot,
    now,
    staleAfterMs: STALE_AFTER_MS,
    inFlight: protectsStop && (hasInFlightWork(transcriptPath, sessionId, now) || externalLane.kind === 'running'),
    mandateKind: mandate.kind,
    consecutiveBlocks: sessionState.consecutiveBlocks,
    staleSnapshotAt: sessionState.staleSnapshotAt,
    blockMax: BLOCK_MAX,
    inFlightCapMs: INFLIGHT_CAP_MS,
  })

  if (!decision.block) {
    try {
      writeJson(sessionPath, {
        consecutiveBlocks: decision.nextConsecutiveBlocks,
        staleSnapshotAt: decision.staleSnapshotAt ?? null,
        updatedAt: now,
      })
    } catch {
      // Reset failure must not turn the hook into a blocker.
    }
    return
  }

  try {
    writeJson(sessionPath, {
      consecutiveBlocks: decision.nextConsecutiveBlocks,
      staleSnapshotAt: decision.staleSnapshotAt ?? null,
      updatedAt: now,
    })
  } catch {
    return
  }
  recordGuardEvent({
    guard: 'wt-actionable-gate-hook.mjs',
    decision: 'blocked',
    class: decision.reason,
    reason: decision.reason,
    cwd,
    session: input.session_id,
    agent: input.agent_id,
    evidence: {
      holdReason: decision.reason,
      mandateKind: mandate.kind,
      blockIndex: decision.nextConsecutiveBlocks,
    },
  })
  // Emission shape — three exist for a Stop hook, and this is a deliberate choice among them,
  // not the original one:
  //   1. stderr + exit 2            — blocks; renders to BOTH the model AND the user's
  //                                    terminal transcript. This is what this hook used to do,
  //                                    and it is the noisiest form.
  //   2. stdout {"decision":"block","reason":...} + exit 0 — blocks; `reason` STILL renders to
  //                                    the user as a "<hook> hook error", measured FALSE against
  //                                    the earlier belief that this shape was model-only.
  //   3. stdout {"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":...}} + exit 0
  //                                    — blocks (per the official docs: "the conversation
  //                                    continues so Claude can act on the feedback"), and the
  //                                    text is injected as a system reminder that does NOT
  //                                    appear as a chat message in the user's terminal.
  // Shape 3 is used here: it keeps the exact refusal behaviour while dropping the noise. Its
  // phrasing is deliberately FACTUAL rather than imperative, because text that reads as an
  // out-of-band command can trigger the model's own prompt-injection defenses and get
  // resurfaced to the user anyway — an imperative rewrite would silently reopen shape 1's noise.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      // Measured only once the block is certain, so a healthy turn never pays for the read.
      additionalContext: renderBlock(decision, BLOCK_MAX, contextPct(transcriptPath), snapshot, now, externalLane, mandate.kind),
    },
  }))
  process.exit(0)
}

runFailOpenHook('wt-actionable-gate-hook.mjs', main)
