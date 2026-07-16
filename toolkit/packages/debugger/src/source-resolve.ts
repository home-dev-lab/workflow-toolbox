// source-resolve.ts — pure decision core for resolving a hub source prefix, extracted for
// card #1819922556652619607 (`wt-observe await` reported a false "missing" on a LIVE
// server-launched run). Root cause: the old `resolveSourcePrefix` made ONE-SHOT, unretried
// `/api/sources` fetch and `.catch(() => null)`'d any failure into "confirmed single-source"
// — a transient timeout/401/blip was indistinguishable from a real single-source server, so
// every subsequent call went out UNPREFIXED into a multi-source hub's deliberate ambiguity
// 404 (host.ts's makeHubHandler), which `api()` folds to null, which `classifyAwaitTick`
// reads as "never seen" forever. The client-side twin of this bug (App.svelte's
// `detectHubMode`, card #1816078436100212349) already established the fix pattern this
// module ports: a probe FAILURE must retry, never latch a confirmed answer.
//
// The CLI shell (observe-cli.ts) owns the HTTP + sleep; everything here is deterministic,
// synchronous or injected-I/O, and unit-tested (source-resolve.test.ts) without a server.

import { basename } from 'node:path'

/** One local source, as `GET /api/health`'s hub-level payload reports it (host.ts's
 *  makeHubHandler, `/api/health` branch) — `configDir` present. */
export interface HealthLocalSource {
  key: string
  configDir: string
}

/** One REMOTE (federated) source, as the same payload reports it — no `configDir` (a
 *  remote's filesystem path is not this host's to disclose), `remote: true` instead. */
export interface HealthRemoteSource {
  key: string
  remote: true
}

export type HealthSourceEntry = HealthLocalSource | HealthRemoteSource

/** One entry of the richer, auth-gated `GET /api/sources` payload — carries `label`
 *  (host.ts computes it as `basename(configDir)` for local sources), which the public
 *  `/api/health` payload does not. `configDir` is absent for remote entries there too. */
export interface SourcesListEntry {
  key: string
  configDir?: string
  label: string
}

/** Distinguishes a genuine "no match" from an I/O failure — `SourceResolutionError` is
 *  thrown ONLY when the source itself could not be confirmed/matched, never when a run
 *  simply isn't found under an already-resolved source (that is `await`'s ordinary
 *  `missing` verdict, a DIFFERENT and unrelated outcome — see observe-await.ts). */
export class SourceResolutionError extends Error {}

export interface ResolvedSource {
  /** '' for a confirmed single-source server; `/s/<key>` for a resolved hub source. */
  prefix: string
  /** The resolved source's key, or null when the server is confirmed single-source. */
  key: string | null
  label: string
}

function hasConfigDir(s: HealthSourceEntry): s is HealthLocalSource {
  return typeof (s as HealthLocalSource).configDir === 'string'
}

function labelFor(s: HealthSourceEntry): string {
  return hasConfigDir(s) ? basename(s.configDir) : s.key
}

/** The LOCAL (non-remote) source keys in a health payload — used by `await`'s multi-source
 *  runId search (requirement 4), deliberately scoped to local sources only: a remote is a
 *  federated OTHER hub, and searching it adds a cross-host round trip this fix does not
 *  need to make (the incident, and every reported occurrence, involved local sources). */
export function localSourceKeys(healthSources: readonly HealthSourceEntry[] | undefined): string[] {
  if (!Array.isArray(healthSources)) return []
  return healthSources.filter(hasConfigDir).map((s) => s.key)
}

export function matchHealthSource(healthSources: readonly HealthSourceEntry[], wanted: string): HealthSourceEntry | undefined {
  return healthSources.find((s) => s.key === wanted || (hasConfigDir(s) && (s.configDir === wanted || s.configDir.endsWith(`/${wanted}`))))
}

export function matchSourcesListEntry(list: readonly SourcesListEntry[], wanted: string): SourcesListEntry | undefined {
  return list.find((s) => s.key === wanted || s.label === wanted || (typeof s.configDir === 'string' && (s.configDir === wanted || s.configDir.endsWith(`/${wanted}`))))
}

export type SourceSearchResult = { kind: 'unique'; key: string } | { kind: 'none' } | { kind: 'ambiguous'; keys: string[] }

/** Classifies a set of "this source has the runId" hits from a multi-source search. A
 *  runId is globally unique (each source has its own registry keyed by the same
 *  workflow-run id format) — `unique` is the expected, resolvable case; `ambiguous` is a
 *  defensive fallback that should not occur in practice. */
export function classifySourceSearch(hits: readonly string[]): SourceSearchResult {
  const unique = [...new Set(hits)]
  if (unique.length === 1) return { kind: 'unique', key: unique[0]! }
  if (unique.length === 0) return { kind: 'none' }
  return { kind: 'ambiguous', keys: unique }
}

export type RetryOutcome<T> = { kind: 'ok'; value: T } | { kind: 'exhausted' }

/** Generic bounded retry: `attempt` returns null on a failed try. Deliberately does not
 *  distinguish WHY an attempt failed (timeout, 401, malformed body, connection reset) from
 *  any other — every failure gets the SAME retry treatment, and only running OUT of
 *  attempts is a real failure. This is the mechanical fix for the bug this module exists
 *  for: one `.catch(() => null)` used to be read as a CONFIRMED answer instead of a
 *  transient miss. */
export async function withRetry<T>(
  attempt: () => Promise<T | null>,
  opts: { attempts: number; delayMs: (attemptIndex: number) => number; sleep: (ms: number) => Promise<void> },
): Promise<RetryOutcome<T>> {
  for (let i = 0; i < opts.attempts; i++) {
    const value = await attempt()
    if (value !== null) return { kind: 'ok', value }
    if (i < opts.attempts - 1) await opts.sleep(opts.delayMs(i))
  }
  return { kind: 'exhausted' }
}

export const SOURCE_PROBE_ATTEMPTS = 3
export const sourceProbeDelayMs = (attemptIndex: number): number => [300, 900][attemptIndex] ?? 900

/** The full source-prefix resolution decision, with I/O INJECTED (`fetchSourcesList`,
 *  `sleep`) so it is unit-testable without a real server or real timers.
 *
 * `healthSources` is the ALREADY-FETCHED `/api/health` payload's `sources` field —
 * `requireOwnedServer`'s own health probe already succeeded to get here, so
 * `undefined`/`[]` here is a CONFIRMED single-source answer, never a guess from a
 * failure. Matching by key or configDir is resolved straight off it — ZERO extra round
 * trip for the common cases (no `--source`, or `--source` naming a key/configDir). The
 * fallback fetch of the richer, auth-gated `/api/sources` list (needed only for LABEL
 * matching, which the health payload doesn't carry) is reached ONLY when `wanted` fails
 * to match by key/configDir — and even then, retried, never silently downgraded to
 * "unprefixed" on failure. */
export async function resolveSource(
  healthSources: readonly HealthSourceEntry[] | undefined,
  wanted: string | undefined,
  fetchSourcesList: () => Promise<SourcesListEntry[] | null>,
  sleep: (ms: number) => Promise<void>,
): Promise<ResolvedSource> {
  if (!Array.isArray(healthSources) || healthSources.length === 0) return { prefix: '', key: null, label: '' }
  if (wanted === undefined) {
    const first = healthSources[0]! // non-empty, checked above
    return { prefix: `/s/${first.key}`, key: first.key, label: labelFor(first) }
  }
  const bySource = matchHealthSource(healthSources, wanted)
  if (bySource !== undefined) return { prefix: `/s/${bySource.key}`, key: bySource.key, label: labelFor(bySource) }
  const outcome = await withRetry(fetchSourcesList, { attempts: SOURCE_PROBE_ATTEMPTS, delayMs: sourceProbeDelayMs, sleep })
  if (outcome.kind === 'exhausted') {
    throw new SourceResolutionError(
      `could not confirm hub sources after ${SOURCE_PROBE_ATTEMPTS} attempts (wanted "${wanted}") — refusing to guess. Run \`wt-observe status\` to check server health.`,
    )
  }
  const pick = matchSourcesListEntry(outcome.value, wanted)
  if (pick === undefined) {
    throw new SourceResolutionError(
      `--source ${wanted} matches no hub source — available: ${outcome.value.map((s) => `${s.label} (${s.configDir ?? 'remote'})`).join(', ')}`,
    )
  }
  return { prefix: `/s/${pick.key}`, key: pick.key, label: pick.label }
}
