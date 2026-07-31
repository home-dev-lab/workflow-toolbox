// quota-cache.mjs — shared reader/writer for the quota-probe cache.
//
// WHAT IT IS FOR. Two different processes read the account's usage window through the
// SAME endpoint today: the per-turn UserPromptSubmit hook (private,
// `inject-context-quota.mjs`) and `wt-quota-watch.mjs` (this plugin). The hook already
// throttles itself behind a 300s file cache at `<configDir>/.quota-cache.json`; the
// watcher used to bypass it entirely and hit the live endpoint on every poll — with
// several sessions and their watchers active at once, that is enough independent,
// uncoordinated traffic against one account to trip the endpoint's own rate limit
// (observed: HTTP 429). This module lets the watcher READ that same cache before
// probing, and REFILL it after a live probe, so a fresh reading is shared instead of
// re-fetched by every reader.
//
// FORMAT CONTRACT — byte-compatible with the hook, on purpose. The hook writes
// `{ at: <ms epoch>, data: <parsed probe JSON> }` with a 300_000ms TTL. This module
// reads and writes the exact same shape. If the hook's format ever changes, this file
// must change with it — two caches that silently disagree would be a worse defect than
// the one this fixes.
//
// FAIL OPEN, ALWAYS. A missing file, an unreadable file, malformed JSON, a foreign
// shape, or an expired `at` all mean the SAME thing to a caller: no usable cache,
// degrade to a direct probe. A reader that throws, or that treats a broken/foreign
// cache as a valid reading, would either crash the watcher or report a number nobody
// actually measured — the second failure is the more dangerous one (a guard that
// reassures when it should say "unknown").
//
// CONCURRENT WRITERS. Several watchers (one per session) plus the hook can all try to
// write this file around the same time. The write is tmp-file + rename, which is
// atomic on the filesystems this plugin ships on (POSIX rename; Node's fs.rename on
// Windows uses MoveFileExW with MOVEFILE_REPLACE_EXISTING, so it also replaces an
// existing destination file atomically) — a reader never observes a partially written
// file, only the old content or the new one.

import { readFile, writeFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

/** Matches the hook's own TTL (`inject-context-quota.mjs`, `CACHE_TTL_MS`). Keep in sync. */
export const DEFAULT_CACHE_TTL_MS = 300_000

/** Default path, honouring CLAUDE_CONFIG_DIR like the rest of the plugin (and the hook). */
export function defaultQuotaCachePath(configDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')) {
  return path.join(configDir, '.quota-cache.json')
}

/**
 * Reads the shared quota-probe cache.
 *
 * @param {string} cachePath
 * @param {number} [ttlMs]
 * @returns {Promise<{data: unknown, at: number, fresh: boolean} | null>} `null` on any
 *   condition that makes the cache unusable (missing, unreadable, corrupt, foreign
 *   shape) — the caller treats `null` exactly like a cache miss. When non-null,
 *   `fresh` tells the caller whether it is still within the TTL; a non-fresh reading
 *   is returned too (a caller may still want `at`/`data` for diagnostics) but must not
 *   be used in place of a probe.
 */
export async function readQuotaCache(cachePath, ttlMs = DEFAULT_CACHE_TTL_MS) {
  let raw
  try {
    raw = await readFile(cachePath, 'utf8')
  } catch {
    return null // missing or unreadable
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null // corrupt / truncated — e.g. read mid-write by a writer without atomic rename
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (typeof parsed.at !== 'number' || !Number.isFinite(parsed.at)) return null
  if (parsed.data === null || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) return null

  const age = Date.now() - parsed.at
  // A negative age (clock skew, or a foreign writer stamping a future `at`) is treated
  // as NOT fresh rather than trusted — the caller falls through to a direct probe.
  const fresh = age >= 0 && age < ttlMs
  return { data: parsed.data, at: parsed.at, fresh }
}

/**
 * Writes the cache atomically: a tmp file (unique per process + call) written in full,
 * then renamed onto the target path. Never partially observable by a concurrent reader.
 *
 * @param {string} cachePath
 * @param {unknown} data the parsed probe JSON to cache (same shape a live probe prints)
 */
export async function writeQuotaCacheAtomic(cachePath, data) {
  const dir = path.dirname(cachePath)
  const tmp = path.join(dir, `.quota-cache.${process.pid}.${randomUUID()}.tmp`)
  await writeFile(tmp, JSON.stringify({ at: Date.now(), data }), 'utf8')
  await rename(tmp, cachePath)
}
