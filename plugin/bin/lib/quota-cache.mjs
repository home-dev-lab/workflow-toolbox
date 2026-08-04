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

// Cross-family review (2026-08-04) flagged raw `===` on configDir strings as too strict:
// the SAME directory can be spelled two ways (a trailing slash one caller adds and
// another doesn't; `\` vs `/` if a value was ever hand-typed; `C:\Users\x` vs
// `c:\users\x` on Windows, where the filesystem itself is case-insensitive). Comparing
// raw strings would reject a legitimate own-dir entry in those cases — safe (fail-closed
// discards a valid reading, never trusts a foreign one) but wrong, and it would silently
// defeat cache sharing between the hook and the watcher on exactly the platform this
// project ships to. `path.normalize` collapses separator/trailing-slash differences on
// every platform; case-folding is applied ONLY on win32, where the filesystem is
// case-insensitive by default — folding case on POSIX would make two DIFFERENT
// directories (`/A` and `/a` are distinct on Linux/macOS) compare as equal, which is the
// opposite of what this guard exists to prevent. Verified from source (`process.platform`
// docs + Node's own `path.win32`/`path.posix` split): NOT run on a live Windows host,
// so the win32 branch is READ, not battle-tested — flagged honestly in the card report.
function sameConfigDir(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const normalize = (p) => {
    let n = path.normalize(p).replace(/[\\/]+$/, '')
    if (process.platform === 'win32') n = n.toLowerCase()
    return n
  }
  return normalize(a) === normalize(b)
}

/**
 * Reads the shared quota-probe cache.
 *
 * PROVENANCE. This file is a fixed, predictable path any process on the machine can
 * write — another config-dir's own hook/watcher, or a test fixture. Structurally valid
 * JSON with the right shape is not the same thing as a reading that describes the
 * caller's own account: observed 2026-08-04, an entry carrying `configDir: "/fake"` was
 * read and relayed as a real quota drop (12%/30% vs a live 44%/41%). So every entry is
 * checked against `expectedConfigDir` (the caller's own `CLAUDE_CONFIG_DIR`) before it
 * is trusted; an entry naming a DIFFERENT config dir is discarded exactly like a missing
 * or corrupt cache — a cache miss, never a wrong-but-plausible reading. An entry written
 * before this field existed has no `configDir` at all and is unknown provenance for the
 * same reason, so it is discarded too (`undefined !== expectedConfigDir`).
 *
 * @param {string} cachePath
 * @param {number} [ttlMs]
 * @param {string} expectedConfigDir the caller's own config dir (e.g. `CLAUDE_CONFIG_DIR`
 *   as resolved by the caller) — REQUIRED, not optional, so a new call site cannot skip
 *   the provenance check by omission. Pass it explicitly even when it looks redundant
 *   with `cachePath` already being derived from the same dir: the check compares the
 *   ENTRY'S claimed origin, not the path it happened to be found at.
 * @returns {Promise<{data: unknown, at: number, fresh: boolean} | null>} `null` on any
 *   condition that makes the cache unusable (missing, unreadable, corrupt, foreign
 *   shape, foreign or absent provenance) — the caller treats `null` exactly like a cache
 *   miss. When non-null, `fresh` tells the caller whether it is still within the TTL; a
 *   non-fresh reading is returned too (a caller may still want `at`/`data` for
 *   diagnostics) but must not be used in place of a probe.
 */
export async function readQuotaCache(cachePath, ttlMs = DEFAULT_CACHE_TTL_MS, expectedConfigDir) {
  if (typeof expectedConfigDir !== 'string' || expectedConfigDir.length === 0) {
    throw new TypeError(
      'readQuotaCache: expectedConfigDir is required — pass the caller\'s own CLAUDE_CONFIG_DIR so an entry describing a different config dir cannot be read as a valid measurement',
    )
  }

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

  // Provenance gate — see the doc comment above. Deliberately compared BEFORE freshness:
  // a fresh-but-foreign entry is exactly as dangerous as a stale-but-foreign one.
  if (!sameConfigDir(parsed.data.configDir, expectedConfigDir)) return null

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
 * PROVENANCE. Refuses to persist a reading that does not describe `expectedConfigDir` —
 * the write-side half of the same guard as `readQuotaCache`. Without this, a probe that
 * somehow returned (or was fed) another dir's data would poison the cache for the NEXT
 * reader too, including readers built before this fix shipped. This throws rather than
 * silently no-op-ing so a caller's existing best-effort `catch` (every current caller
 * already wraps this call for other reasons) covers it without new call-site changes.
 *
 * @param {string} cachePath
 * @param {unknown} data the parsed probe JSON to cache (same shape a live probe prints)
 * @param {string} expectedConfigDir the caller's own config dir — REQUIRED; see
 *   `readQuotaCache` for why this is not optional.
 */
export async function writeQuotaCacheAtomic(cachePath, data, expectedConfigDir) {
  if (typeof expectedConfigDir !== 'string' || expectedConfigDir.length === 0) {
    throw new TypeError(
      'writeQuotaCacheAtomic: expectedConfigDir is required — refuse to persist a reading whose provenance cannot be checked',
    )
  }
  if (!sameConfigDir(data?.configDir, expectedConfigDir)) {
    throw new Error(
      `writeQuotaCacheAtomic: refusing to persist a reading for configDir=${JSON.stringify(data?.configDir)}, expected ${JSON.stringify(expectedConfigDir)}`,
    )
  }
  const dir = path.dirname(cachePath)
  const tmp = path.join(dir, `.quota-cache.${process.pid}.${randomUUID()}.tmp`)
  await writeFile(tmp, JSON.stringify({ at: Date.now(), data }), 'utf8')
  await rename(tmp, cachePath)
}
