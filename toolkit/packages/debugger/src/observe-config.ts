// observe-config.ts — IMPURE fs module (like source.ts / config-dir.ts / project-registry.ts
// elsewhere in this package — NOT workflow-sandbox code, Node APIs are fine here). The
// source-resolution FRONT DOOR `wt-observe start` (and the `config` verb) share: small,
// independently-testable reads that feed the PURE resolveHubSources (observe-lifecycle.ts)
// its config-file and auto-discovery candidate lists, but never do the
// exists-filtering/canonicalization/dedup themselves — that stays in the one pure function
// so every precedence rule lives in exactly one place. `writeObserveConfig` is the ONLY
// writer of the persistent source list — `wt-observe config add-source|remove-source` calls
// it; `start` never does (the file stays strictly opt-in).

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One remote-hub entry (hub federation): another wt-observe server, mounted by THIS hub
 *  as a proxied source. `token` is that server's own API token; `tokenFile` points at a
 *  file to read it from LAZILY instead — either a raw token file or a server.json pidfile
 *  (detected by JSON shape at read time, observe-remote.ts) — which is what makes a
 *  WSL↔Windows pairing survive the remote's restarts (`\\wsl.localhost\...\server.json`).
 *  The CLI enforces token XOR tokenFile at parse time; the reader below stays tolerant. */
export interface RemoteEntry {
  url: string
  token?: string
  tokenFile?: string
  label?: string
}

export interface ObserveConfig {
  /** Raw, already-string-filtered source list from config.json — NOT yet canonicalized,
   *  existence-filtered, or deduped (resolveHubSources does all three). */
  sources: string[]
  /** Remote-hub entries — a SEPARATE, additive axis: `sources` stay plain local dirs and
   *  resolveHubSources never sees remotes (they carry no existence/discovery semantics;
   *  URL validation happens at use via normalizeRemoteUrl). */
  remotes: RemoteEntry[]
}

const CONFIG_FILENAME = 'config.json'

/** Tolerant read of `<configRoot>/config.json` — the hub's persistent, user-configurable
 *  source list (multi-observe config-file support). NEVER throws: file absent / unreadable /
 *  malformed JSON / not a JSON object / `sources` missing or not an array all degrade to
 *  `{ sources: [] }` (auto-discovery then takes over in resolveHubSources); a non-string
 *  entry inside an otherwise-valid `sources` array is silently dropped rather than rejecting
 *  the whole file — one bad entry shouldn't lose the good ones. An EMPTY / whitespace-only
 *  string is dropped too (codex cross-model review): it is technically a valid string but
 *  would canonicalize to `path.resolve('') === process.cwd()` and silently mount the CLI's
 *  launch directory as a bogus source. */
export function readObserveConfig(configRoot: string): ObserveConfig {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(configRoot, CONFIG_FILENAME), 'utf8'))
  } catch {
    return { sources: [], remotes: [] }
  }
  if (typeof raw !== 'object' || raw === null) return { sources: [], remotes: [] }
  const obj = raw as Record<string, unknown>
  const rawSources = obj['sources']
  const sources = Array.isArray(rawSources) ? rawSources.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : []
  // Same per-entry tolerance as sources — `sources` and `remotes` degrade INDEPENDENTLY
  // (a malformed remotes value must never lose the good sources, and vice versa).
  const rawRemotes = obj['remotes']
  const remotes = Array.isArray(rawRemotes) ? rawRemotes.map(parseRemoteEntry).filter((e): e is RemoteEntry => e !== null) : []
  return { sources, remotes }
}

/** One remotes[] entry, tolerantly: no usable `url` → drop the entry; a blank/non-string
 *  OPTIONAL field is dropped alone (one bad field must not lose the remote). */
function parseRemoteEntry(raw: unknown): RemoteEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const url = obj['url']
  if (typeof url !== 'string' || url.trim().length === 0) return null
  const entry: RemoteEntry = { url }
  for (const field of ['token', 'tokenFile', 'label'] as const) {
    const value = obj[field]
    if (typeof value === 'string' && value.trim().length > 0) entry[field] = value
  }
  return entry
}

/** Persist the source list to `<configRoot>/config.json` — the ONLY writer (the `wt-observe
 *  config add-source|remove-source` verbs; `start` never writes here, the file stays
 *  strictly opt-in). Atomic: written to a pid+timestamp-suffixed temp file in the SAME
 *  directory, then renamed over the real path — `rename(2)` is atomic on the same
 *  filesystem, so a reader (readObserveConfig, or a concurrent `wt-observe start`) never
 *  observes a partially-written file. `configRoot` is created (0700, matching the state
 *  root's own posture — this file can end up embedding local filesystem paths) if missing;
 *  the config file itself is 0600. */
export function writeObserveConfig(configRoot: string, config: ObserveConfig): void {
  mkdirSync(configRoot, { recursive: true, mode: 0o700 })
  const path = join(configRoot, CONFIG_FILENAME)
  const tmpPath = join(configRoot, `.${CONFIG_FILENAME}.tmp-${process.pid}-${Date.now()}`)
  try {
    writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmpPath, path)
  } catch (e) {
    // A mid-write failure (ENOSPC, permissions) must not leave an orphaned temp file behind
    // (codex review) — best-effort cleanup, then re-throw the real error.
    try {
      unlinkSync(tmpPath)
    } catch {
      // temp never created, or already gone — nothing to clean
    }
    throw e
  }
}

// Conservative glob: ONLY a directory literally named `.claude`, or matching `.claude-<some
// non-empty suffix>`, ever qualifies as a discovery candidate — never an arbitrary sibling
// (and never the underscore variant `.claude_work`, which config-dir.ts's own configDirKey
// injectivity comment already treats as a DISTINCT, non-colliding config dir).
const CLAUDE_DIR_NAME = /^\.claude(-.+)?$/

/** Content-validity check for a DISCOVERY candidate ONLY — applied here, in
 *  discoverConfigDirCandidates below, and NEVER to an explicit --source flag or a
 *  config-file source (those are trusted as the user's explicit intent; resolveHubSources'
 *  explicit/configSources branches only exists-filter, they never call this). Does
 *  `candidate` contain a `projects/` subdirectory, the exact run store the observe server
 *  reads (`<configDir>/projects/<slug>/<session>/workflows/`)? The name-glob
 *  alone is too permissive — it would happily match `.claude-backup`, `.claude-old`, or any
 *  other junk `.claude-*` sibling and mount it as an empty/stale source. Checking for
 *  `.claude.json` (the project registry) was considered and rejected: that file only lists
 *  KNOWN project paths, it says nothing about whether THIS dir itself has run history —
 *  `projects/` is the ground truth for "does the hub have anything to show for this dir".
 *  Tolerant: a stat error (missing, permission denied, not a directory) → false, never throws. */
function hasProjectsStore(candidate: string): boolean {
  try {
    return statSync(join(candidate, 'projects')).isDirectory()
  } catch {
    return false
  }
}

/** Auto-discovery candidates, BEFORE existence-filtering/canonicalization/dedup (all three
 *  still happen in the pure resolveHubSources — this only gathers raw candidate strings), but
 *  AFTER the content-validity check above — every candidate this returns has already been
 *  confirmed to look like a real config dir, on this same impure discovery layer (never
 *  inside the pure resolver).
 *  `$CLAUDE_CONFIG_DIR` (if set) is a candidate; every existing sibling of `home` whose name
 *  matches `CLAUDE_DIR_NAME` is added on top — a glob, replacing the old hardcoded
 *  `~/.claude-work`-only candidate, so a differently-named second config dir (e.g.
 *  `~/.claude-acme`) is discovered too. The directory read is impure and best-effort: an
 *  unreadable `home` degrades to `$CLAUDE_CONFIG_DIR` (if set) plus a bare `~/.claude` guess —
 *  itself still subject to the same content check below — never throws. */
export function discoverConfigDirCandidates(env: Record<string, string | undefined>, home: string): string[] {
  const candidates: string[] = []
  const explicit = env['CLAUDE_CONFIG_DIR']
  if (explicit !== undefined && explicit.length > 0) candidates.push(explicit)
  try {
    // SORT the matching sibling names — readdirSync order is filesystem-dependent (not
    // deterministic across machines/runs), and this order becomes the hub's source order,
    // hence the switcher order AND which source is the default-active one (the first). A
    // plain lexicographic sort is stable AND puts the bare `.claude` ahead of every
    // `.claude-<suffix>` (a prefix sorts first), so the base config dir is the natural default.
    const siblings = readdirSync(home, { withFileTypes: true })
      // Include SYMLINKS, not just plain dirs (codex cross-model review): a config dir set up
      // as a symlink (e.g. `ln -s /mnt/shared/.claude-work ~/.claude-work`) is a real,
      // previously-supported target — the old hardcoded `~/.claude-work` was existsSync-
      // validated, which FOLLOWS symlinks. Dirent.isDirectory() is false for a symlink even
      // when it targets a directory, so a link would be silently dropped here. hasProjectsStore
      // below (statSync, which DOES follow the link) then validates the real target — a symlink
      // to a non-dir, or a dir without `projects/`, is dropped there. A regular FILE named
      // `.claude-*` is still excluded here (neither a directory nor a symlink).
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && CLAUDE_DIR_NAME.test(entry.name))
      .map((entry) => entry.name)
      .sort()
    for (const name of siblings) candidates.push(join(home, name))
  } catch {
    // home unreadable — degrade to $CLAUDE_CONFIG_DIR (already pushed above, if set) plus a
    // bare ~/.claude guess; the content check below (and resolveHubSources' exists-filter)
    // drops it if it's not really there.
    candidates.push(join(home, '.claude'))
  }
  return candidates.filter(hasProjectsStore)
}
