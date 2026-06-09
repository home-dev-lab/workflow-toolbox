// version.ts — pure version-signal comparison + canary-marker (de)serialization
// for the upgrade canary. NO I/O here: check-version.ts does the spawning/fs and
// uses these helpers. Kept pure so it is unit-tested offline (mirrors lib.ts).
//
// The marker records, per machine, which Claude Code runtime the canary last
// verified and whether that run passed. The skill re-runs the canary only when a
// signal changed OR the last verdict was a fail (see decideRun) — that is what
// makes the canary version-triggered, not daily.

import { isRecord } from './lib.js'

export type Verdict = 'pass' | 'fail'

export interface VersionSignals {
  /** semver of the user's interactive `claude` CLI (null if unresolved). */
  claudeVersion: string | null
  /** semver of the installed @anthropic-ai/claude-agent-sdk (null if unresolved). */
  sdkVersion: string | null
}

/** One check's stable, run-to-run-comparable outcome (no volatile taskIds). */
export interface CheckSnapshot {
  name: string
  ok: boolean
  /** Canonicalized rejection reason, for negative checks only. */
  canonicalReason?: string
}

/** What one runtime target (system | bundled) reported on the last run. */
export interface TargetSnapshot {
  /** Measured Claude Code version of the binary that ran (from the init message). */
  ccVersion: string | null
  checks: CheckSnapshot[]
}

export type TargetsSnapshot = Record<string, TargetSnapshot>

export interface CanaryMarker extends VersionSignals {
  lastRunISO: string
  lastVerdict: Verdict
  /** Per-target change-report snapshot. Optional + additive: a v1 marker without
   *  it still parses (the gate only needs claudeVersion + sdkVersion). */
  targets?: TargetsSnapshot
}

/** Extract a semver from `claude --version` output ("2.1.167 (Claude Code)"). */
export function parseClaudeVersion(raw: string): string | null {
  return raw.match(/\d+\.\d+\.\d+/)?.[0] ?? null
}

/** Numeric semver compare → -1 | 0 | 1. REQUIRES pre-normalized `x.y.z` input
 *  (callers normalize via parseClaudeVersion first), so each component is a clean
 *  integer — no NaN coercion, which would silently mis-order. Used by the changelog
 *  range filter; kept here as the version module's shared primitive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10))
  const pb = b.split('.').map((n) => Number.parseInt(n, 10))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Parse a stored marker JSON; returns null on any malformed/partial shape so a
 *  corrupt marker degrades to "no marker" (→ a full run), never throws. */
export function parseMarker(json: string): CanaryMarker | null {
  let v: unknown
  try {
    v = JSON.parse(json)
  } catch {
    return null
  }
  if (!isRecord(v)) return null
  const lastVerdict = v['lastVerdict']
  if (lastVerdict !== 'pass' && lastVerdict !== 'fail') return null
  const lastRunISO = v['lastRunISO']
  if (typeof lastRunISO !== 'string') return null
  const targets = parseTargets(v['targets'])
  return {
    claudeVersion: typeof v['claudeVersion'] === 'string' ? v['claudeVersion'] : null,
    sdkVersion: typeof v['sdkVersion'] === 'string' ? v['sdkVersion'] : null,
    lastRunISO,
    lastVerdict,
    ...(targets ? { targets } : {}),
  }
}

/** Defensively parse the optional `targets` snapshot; returns undefined for any
 *  missing/malformed shape so an older or corrupt marker degrades gracefully. */
function parseTargets(v: unknown): TargetsSnapshot | undefined {
  if (!isRecord(v)) return undefined
  const out: TargetsSnapshot = {}
  for (const [name, t] of Object.entries(v)) {
    if (!isRecord(t) || !Array.isArray(t['checks'])) continue
    const checks: CheckSnapshot[] = []
    for (const c of t['checks']) {
      if (!isRecord(c) || typeof c['name'] !== 'string' || typeof c['ok'] !== 'boolean') continue
      checks.push({
        name: c['name'],
        ok: c['ok'],
        ...(typeof c['canonicalReason'] === 'string' ? { canonicalReason: c['canonicalReason'] } : {}),
      })
    }
    out[name] = { ccVersion: typeof t['ccVersion'] === 'string' ? t['ccVersion'] : null, checks }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export interface SnapshotDiff {
  /** Per-target Claude Code version moves, e.g. "system: 2.1.167 → 2.1.168". */
  versionDeltas: string[]
  /** Checks whose pass/fail flipped, e.g. "bundled / tier2 round trip: pass → FAIL". */
  flips: string[]
  /** Negative-check rejection wording that drifted (canonicalized), per target. */
  reasonDrift: string[]
}

/** Diff the previous per-target snapshot against the current one. Only stable
 *  fields are compared — ccVersion, each check's ok, and the canonicalized reason
 *  — so volatile taskIds never produce phantom drift. A target/check absent on
 *  one side is simply skipped (new targets surface via versionDeltas as "new"). */
export function diffSnapshot(last: TargetsSnapshot | undefined, current: TargetsSnapshot): SnapshotDiff {
  const diff: SnapshotDiff = { versionDeltas: [], flips: [], reasonDrift: [] }
  for (const [name, cur] of Object.entries(current)) {
    const prev = last?.[name]
    if (prev === undefined) {
      diff.versionDeltas.push(`${name}: (new) → ${cur.ccVersion ?? 'unknown'}`)
      continue
    }
    if (prev.ccVersion !== cur.ccVersion) {
      diff.versionDeltas.push(`${name}: ${prev.ccVersion ?? 'unknown'} → ${cur.ccVersion ?? 'unknown'}`)
    }
    const prevByName = new Map(prev.checks.map((c) => [c.name, c]))
    for (const c of cur.checks) {
      const p = prevByName.get(c.name)
      if (p === undefined) continue
      if (p.ok !== c.ok) {
        diff.flips.push(`${name} / ${c.name}: ${p.ok ? 'pass' : 'FAIL'} → ${c.ok ? 'pass' : 'FAIL'}`)
      }
      if (c.canonicalReason !== undefined && p.canonicalReason !== undefined && c.canonicalReason !== p.canonicalReason) {
        diff.reasonDrift.push(`${name} / ${c.name}: "${p.canonicalReason}" → "${c.canonicalReason}"`)
      }
    }
  }
  return diff
}

/** Serialize a marker for writing (stable 2-space JSON + trailing newline). */
export function formatMarker(m: CanaryMarker): string {
  return `${JSON.stringify(m, null, 2)}\n`
}

export interface ComparisonResult {
  changed: boolean
  deltas: string[]
}

/** Compare the last marker against the current signals. No marker → changed
 *  (the marker is gitignored / per-clone, so a fresh checkout always re-verifies). */
export function compareSignals(last: CanaryMarker | null, current: VersionSignals): ComparisonResult {
  if (last === null) return { changed: true, deltas: ['no previous canary marker on this machine'] }
  const deltas: string[] = []
  if (last.claudeVersion !== current.claudeVersion) {
    deltas.push(`claude ${last.claudeVersion ?? 'unknown'} → ${current.claudeVersion ?? 'unknown'}`)
  }
  if (last.sdkVersion !== current.sdkVersion) {
    deltas.push(`sdk ${last.sdkVersion ?? 'unknown'} → ${current.sdkVersion ?? 'unknown'}`)
  }
  return { changed: deltas.length > 0, deltas }
}

export interface RunDecision {
  run: boolean
  reason: string
}

/** The gate: run the canary when forced, when a signal changed, or when the last
 *  verdict was a FAIL (re-run until green). Only skip when nothing changed AND the
 *  last run passed — otherwise a real regression would be silently suppressed. */
export function decideRun(comparison: ComparisonResult, last: CanaryMarker | null, force: boolean): RunDecision {
  if (force) return { run: true, reason: 'forced (--force)' }
  if (comparison.changed) return { run: true, reason: comparison.deltas.join('; ') }
  if (last?.lastVerdict === 'fail') {
    return { run: true, reason: 'last canary verdict was FAIL — re-running until green' }
  }
  return { run: false, reason: `unchanged since ${last?.lastRunISO ?? 'unknown'} and last verdict was pass` }
}
