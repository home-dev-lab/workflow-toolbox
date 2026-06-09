// IMPURE per-session state for the Stop hook (the hook is stateless per firing, so the
// completion diff needs somewhere to remember what was running and what's been reported).
// Held out of `pnpm test` (no .test.ts peer). Never throws — the hook must never break
// the session, so any read/write failure degrades to empty state / a no-op.
//
// State lives at $TMPDIR/dwt-stop-hook/<sessionId>.json. `reported` is FIFO-capped so a
// long-lived session can't grow it unbounded; the worst case of an evicted id is a single
// duplicate (idempotent) notice, never a block-loop (guarded separately by stop_hook_active).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRecord, numOrNull } from '@dwt/std'

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
  return join(tmpdir(), 'dwt-stop-hook')
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
