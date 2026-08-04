#!/usr/bin/env node
// wt-actionable-gate-hook.mjs — Stop hook consumer for a tracker-agnostic
// actionability snapshot. The producer decides what is STARTABLE; this hook only
// enforces the contract's stop-time invariants.

import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

import { decide } from './lib/actionability-core.mjs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'

const STALE_AFTER_MS = Number(process.env.WT_ACTIONABLE_STALE_AFTER_MS || 2 * 60 * 60 * 1000)
const BLOCK_MAX = Number(process.env.WT_ACTIONABLE_BLOCK_MAX || 3)
const INFLIGHT_MS = Number(process.env.WT_ACTIONABLE_INFLIGHT_MS || 3 * 60 * 1000)
const LANE_ANCESTOR_DEPTH = Number(process.env.WT_ACTIONABLE_LANE_ANCESTOR_DEPTH || 4)
const LANE_SELF_EXCLUDE_DEPTH = 32

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

function projectSlug(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9-]/g, '-')
}

function stateRoot() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  return join(base, 'wt-actionable')
}

function lanePatterns() {
  const raw = process.env.WT_ACTIONABLE_LANE_PATTERNS
  const patterns = typeof raw === 'string' && raw.trim() ? raw.split(',').map((value) => value.trim()).filter(Boolean) : ['opencode run', 'codex exec']
  return patterns.length > 0 ? patterns : ['opencode run', 'codex exec']
}

function safeSessionId(sessionId) {
  return String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '-')
}

function snapshotPath(root, cwd) {
  return join(root, `${projectSlug(cwd)}.json`)
}

function projectStatePath(root, cwd) {
  return join(root, `${projectSlug(cwd)}.project-state.json`)
}

function sessionStatePath(root, cwd, sessionId) {
  return join(root, `${projectSlug(cwd)}--${safeSessionId(sessionId)}.session-state.json`)
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
    return parsed && typeof parsed === 'object' ? parsed : { optedIn: false }
  } catch {
    return { optedIn: false }
  }
}

function readSessionState(path) {
  try {
    const parsed = readJson(path)
    const value = parsed?.consecutiveBlocks
    return finiteNumber(value) && value >= 0 ? value : 0
  } catch {
    return 0
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
  if (!existsSync(snapPath)) {
    const projectState = readProjectState(projectStatePath(root, cwd))
    return projectState.optedIn ? { status: 'missing' } : { status: 'never' }
  }

  try {
    writeJson(projectStatePath(root, cwd), { optedIn: true, seenAt: now })
  } catch {
    return { status: 'invalid' }
  }

  try {
    const normalized = normalizeSnapshot(readJson(snapPath))
    return normalized ?? { status: 'invalid' }
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

function nearAncestorsOf(pid, depth) {
  const out = new Set()
  let current = Number(pid)
  for (let i = 0; i < depth && current > 1; i += 1) {
    const stat = readFileSync(`/proc/${current}/stat`, 'utf8')
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
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

function listMatchingPids(pattern) {
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

  // Degraded path is explicit: this detection relies on Linux /proc for cwd + ppid and on
  // `pgrep -f` to match the invocation without printing command lines. Elsewhere the hook must
  // fall back to transcripts plus the declared bound, not pretend it checked and found nothing.
  if (process.platform !== 'linux') {
    return { kind: 'unsupported', reason: `external lane detection requires linux /proc + pgrep (got ${process.platform})` }
  }

  try {
    const hookNear = nearAncestorsOf(process.pid, LANE_ANCESTOR_DEPTH)
    const hookSelfAndAncestors = new Set([process.pid, ...nearAncestorsOf(process.pid, LANE_SELF_EXCLUDE_DEPTH)])
    const projectRoot = safeProjectRoot(cwd)

    for (const pattern of lanePatterns()) {
      const matches = listMatchingPids(pattern)
      if (matches.kind !== 'ok') return matches
      for (const pid of matches.pids) {
        if (hookSelfAndAncestors.has(pid)) continue
        const laneRoot = readlinkSync(`/proc/${pid}/cwd`)
        if (!isSameOrNestedPath(laneRoot, projectRoot)) continue
        if (intersects(hookNear, nearAncestorsOf(pid, LANE_ANCESTOR_DEPTH))) {
          return { kind: 'running', pid, pattern }
        }
      }
    }
    return { kind: 'idle' }
  } catch (error) {
    return { kind: 'error', reason: error instanceof Error ? error.message : String(error) }
  }
}

function renderBlock(decision, blockMax) {
  const actionableLine = finiteNumber(decision.actionable)
    ? `${decision.actionable} actionable item(s) remain.`
    : 'Actionable count is UNKNOWN (snapshot missing or stale after opt-in).'
  const nextLine = decision.next ? decision.next : 'unknown'
  return [
    `ACTIONABILITY GATE: ${actionableLine}`,
    `Next: ${nextLine}`,
    'Ending the turn again will NOT clear this.',
    'Only work running, or nothing actionable, clears it.',
    `Block ${decision.nextConsecutiveBlocks} of ${blockMax}.`,
    'A gate makes stopping loud; it does not make work happen. Only a self-paced loop hands a turn back.',
  ].join('\n')
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

  const externalLane = detectExternalLane(cwd)
  if (externalLane.kind === 'error') return

  const sessionPath = sessionStatePath(root, cwd, sessionId)
  const consecutiveBlocks = readSessionState(sessionPath)
  const decision = decide({
    snapshot,
    now,
    staleAfterMs: STALE_AFTER_MS,
    inFlight: hasInFlightWork(transcriptPath, sessionId, now) || externalLane.kind === 'running',
    consecutiveBlocks,
    blockMax: BLOCK_MAX,
  })

  if (!decision.block) {
    try {
      writeJson(sessionPath, { consecutiveBlocks: decision.nextConsecutiveBlocks, updatedAt: now })
    } catch {
      // Reset failure must not turn the hook into a blocker.
    }
    return
  }

  try {
    writeJson(sessionPath, { consecutiveBlocks: decision.nextConsecutiveBlocks, updatedAt: now })
  } catch {
    return
  }
  process.stderr.write(renderBlock(decision, BLOCK_MAX))
  process.exit(2)
}

runFailOpenHook('wt-actionable-gate-hook.mjs', main)
