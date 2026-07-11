// IMPURE state for the Stop hook (the hook is stateless per firing, so the completion diff
// needs somewhere to remember what was running and what's been reported). Never throws — the
// hook must never break the session, so any read/write failure degrades to empty state / a no-op.
//
// THREE stores, deliberately keyed differently:
//   1. Per-SESSION diff state — $TMPDIR/wt-stop-hook/<sessionId>.json — {pending, reported, tries}.
//      `reported` is FIFO-capped so a long-lived session can't grow it unbounded; an evicted id
//      costs at most a single duplicate (idempotent) notice, never a block-loop (guarded
//      separately by stop_hook_active).
//   2+3. Durable per-PROJECT dedup sets — $TMPDIR/wt-stop-hook/<kind>-<slug>.json — keyed by the
//      cwd-derived project slug, NOT the sessionId, so they SURVIVE a mid-session session-UUID
//      change (auto-compaction, claude-code#65796) that would otherwise reset store 1 and replay
//      every still-listed finished run. `reported-runs` holds stable runIds (RESOLVED runs);
//      `given-up-tasks` holds taskIds abandoned as never-resolvable (VANISHED runs, whose runId is
//      unknown so reported-runs can't hold them). Both share one mechanism (durableSet*): writes
//      MERGE — a dedup entry is additive, so dropping one re-announces that run — which also makes
//      a slug collision or a concurrent same-project write benign.
//
// The read/write paths are covered by stop-state.test.ts.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRecord, numOrNull } from '@workflow-toolbox/std'
import { projectSlug } from './source.js'

export interface StopState {
  /** Workflow task ids seen in-flight, awaiting a completion verdict. */
  pending: string[]
  /** Task ids whose verdict has been delivered (or given up on) — never surfaced again. */
  reported: string[]
  /** Per-task resolution attempts, used to stop retrying a vanished run forever. Self-bounds
   * (unlike `reported`, which is FIFO-capped): every id is deleted on conclusion — a resolved
   * run, or a never-readable one once it hits MAX tries — so no FIFO cap is needed here. */
  tries: Record<string, number>
}

const REPORTED_CAP = 200
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function stateDir(): string {
  return join(tmpdir(), 'wt-stop-hook')
}

function statePath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown'
  return join(stateDir(), `${safe}.json`)
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

export function readStopState(sessionId: string): StopState {
  try {
    const data: unknown = JSON.parse(readFileSync(statePath(sessionId), 'utf8'))
    if (!isRecord(data)) return { pending: [], reported: [], tries: {} }
    const tries: Record<string, number> = {}
    const rawTries = data['tries']
    if (isRecord(rawTries)) {
      for (const [k, v] of Object.entries(rawTries)) {
        if (PROTO_KEYS.has(k)) continue
        const n = numOrNull(v)
        if (n !== null) tries[k] = n
      }
    }
    return { pending: strArray(data['pending']), reported: strArray(data['reported']), tries }
  } catch {
    return { pending: [], reported: [], tries: {} }
  }
}

export function writeStopState(sessionId: string, state: StopState): void {
  try {
    mkdirSync(stateDir(), { recursive: true })
    const reported = state.reported.slice(-REPORTED_CAP)
    writeFileSync(statePath(sessionId), JSON.stringify({ pending: state.pending, reported, tries: state.tries }))
  } catch {
    // best-effort — never break the session
  }
}

// ── Durable, PROJECT-scoped dedup sets ───────────────────────────────────────────────────
// The per-session state above is keyed by sessionId — which is NOT stable: main-session
// auto-compaction can spawn a new session UUID (claude-code#65796), and then readStopState
// returns EMPTY, so every finished run still listed in background_tasks[] replays as "new".
// These stores key on the cwd-derived PROJECT slug (not the sessionId), so a UUID change no
// longer replays a run already surfaced. Their ids are globally unique, so a project-wide set
// is safe to share across concurrent same-project sessions: a run is only ever surfaced by the
// session that launched it, and a shared membership check can at worst cause an idempotent skip
// — never a mis-attribution. Both dimensions (runId-keyed, taskId-keyed) are the SAME mechanism,
// so they share one generic helper rather than duplicating read/merge/cap three times.

const DURABLE_SET_CAP = 500

/** Path for a durable per-project string-set of the given `kind` — keyed by the cwd-derived
 *  project slug, NOT the (unstable) sessionId, so it survives a mid-session session-UUID change.
 *  The slug is truncated to keep `<kind>-<slug>.json` within the 255-byte filename limit (a very
 *  long cwd would otherwise ENAMETOOLONG on write and silently disable the durable guard); a rare
 *  truncation collision is benign because writes MERGE and the ids are globally unique. */
function durableSetPath(cwd: string, kind: string): string {
  const safe = (projectSlug(cwd) || 'unknown').slice(0, 200)
  return join(stateDir(), `${kind}-${safe}.json`)
}

/** Read a durable set's values (stored under `field`). Never throws; a missing or malformed file
 *  degrades to []. */
function readDurableSet(cwd: string, kind: string, field: string): string[] {
  try {
    const data: unknown = JSON.parse(readFileSync(durableSetPath(cwd, kind), 'utf8'))
    if (!isRecord(data)) return []
    return strArray(data[field])
  } catch {
    return []
  }
}

/** Persist a durable set, MERGED with whatever is currently on disk (FIFO-capped so it can't grow
 *  unbounded). The merge is load-bearing: the set is additive — an entry must never be DROPPED
 *  (that re-announces its run) — so a later write, a concurrent same-project session, or a slug
 *  collision unions rather than clobbers. Re-reading at write time also narrows the last-writer-
 *  wins race. Never throws (best-effort — must not break the session). */
function writeDurableSet(cwd: string, kind: string, field: string, values: string[]): void {
  try {
    mkdirSync(stateDir(), { recursive: true })
    const merged = [...new Set([...readDurableSet(cwd, kind, field), ...values])]
    writeFileSync(durableSetPath(cwd, kind), JSON.stringify({ [field]: merged.slice(-DURABLE_SET_CAP) }))
  } catch {
    // best-effort — never break the session
  }
}

// reported-runs — stable runIds already conclusively surfaced (RESOLVED runs). ─────────────
export function reportedRunsPath(cwd: string): string {
  return durableSetPath(cwd, 'reported-runs')
}
export function readReportedRuns(cwd: string): string[] {
  return readDurableSet(cwd, 'reported-runs', 'runs')
}
export function writeReportedRuns(cwd: string, runs: string[]): void {
  writeDurableSet(cwd, 'reported-runs', 'runs', runs)
}

// given-up-tasks — taskIds abandoned as never-resolvable (VANISHED runs). A run whose journal is
// never readable yields no runId, so reported-runs can't hold it; without this second store it
// re-emits one provisional notice per session-UUID change. Keyed by the stable background-task id.
export function givenUpTasksPath(cwd: string): string {
  return durableSetPath(cwd, 'given-up-tasks')
}
export function readGivenUpTasks(cwd: string): string[] {
  return readDurableSet(cwd, 'given-up-tasks', 'tasks')
}
export function writeGivenUpTasks(cwd: string, tasks: string[]): void {
  writeDurableSet(cwd, 'given-up-tasks', 'tasks', tasks)
}
