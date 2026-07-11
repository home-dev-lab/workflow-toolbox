// observe-lifecycle.ts — the PURE brain of the `wt-observe` CLI (start|stop|status):
// state-file paths, pidfile parse/serialize, health-identity classification, config-verb
// arg parsing, and the start/stop decision tables. All process I/O (spawn / kill / health
// probe / /proc identity reads) lives in the CLI entry; everything here is deterministic
// and unit-tested.
//
// Design (card #1809494718673847696, post red-team; verb-unification follow-up):
//  - ONE observe server total, config-dir-INDEPENDENT (one pidfile, `server.json`, under
//    the state root below) — it serves whichever 1+ config dirs were resolved at start
//    time (resolveHubSources' own precedence: --source > config-file > discovery). This
//    dissolves the old "hub vs single-source, two pidfiles" split: 1 resolved source is
//    just the common case of "the set happens to have one member".
//  - Adoption is decided on HEALTH IDENTITY — GET /api/health answers with EITHER a
//    `configDir` string (1-source shape) or a `sources[]` array (2+-source shape). Ownership
//    no longer requires the served set to equal what was just freshly resolved (drift-
//    tolerant, same posture the old hub classifier already had): the REAL proof for any
//    destructive/token-transmitting action is the pidfile's PID IDENTITY match, not the
//    served-set comparison. See classifyHealth's own doc for why.
//  - The port BIND is the concurrent-start mutex (the server exits on EADDRINUSE);
//    the pidfile is written AFTER health confirms — so a lost race converges to adopt.
//  - Signalling is gated on PID IDENTITY (boot-id + /proc start ticks recorded at
//    write time): a recycled pid (reboot, PID reuse) is cleared, NEVER signalled.

import { join } from 'node:path'

/** The platforms the root resolvers branch on. Anything that is not darwin/win32 gets the
 *  XDG treatment (linux, the BSDs, WSL — all XDG-shaped). Matches `process.platform`'s
 *  relevant values; callers pass `process.platform` at the impure edge. */
export type ObservePlatform = NodeJS.Platform

/** An EXPLICITLY set XDG var is explicit user intent — it wins on EVERY platform (env-paths
 *  ignores XDG off-Linux, which would surprise a mac/Windows user who set it on purpose). */
function xdgOverride(env: Record<string, string | undefined>, name: string): string | null {
  const v = env[name]
  return v !== undefined && v.length > 0 ? v : null
}

/** Config-dir-INDEPENDENT state root (+ wt-observe). Per-OS natives
 *  (card #1813359570421023938):
 *  - linux/other: $XDG_STATE_HOME ?? ~/.local/state  (unchanged — existing installs)
 *  - darwin:      ~/Library/Application Support      (app state is machine data)
 *  - win32:       %LOCALAPPDATA% ?? ~/AppData/Local  (local, non-roaming — the pidfile,
 *                 logs and manifests are machine-bound and must not roam). */
export function observeStateRoot(env: Record<string, string | undefined>, home: string, platform: ObservePlatform): string {
  const xdg = xdgOverride(env, 'XDG_STATE_HOME')
  const base = xdg !== null ? xdg
    : platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : platform === 'win32' ? (xdgOverride(env, 'LOCALAPPDATA') ?? join(home, 'AppData', 'Local'))
    : join(home, '.local', 'state')
  return join(base, 'wt-observe')
}

/** Config-dir-INDEPENDENT config root (+ wt-observe) — mirrors observeStateRoot's shape.
 *  The hub's persistent, user-configurable source list (`readObserveConfig` reads
 *  `<this>/config.json`) spans SEVERAL config dirs, so — like the state root — it cannot
 *  live inside any single config dir's own settings. Per-OS natives:
 *  - linux/other: $XDG_CONFIG_HOME ?? ~/.config       (unchanged — existing installs)
 *  - darwin:      ~/Library/Preferences               (user preferences)
 *  - win32:       %APPDATA% ?? ~/AppData/Roaming      (roaming — a user-authored source
 *                 list follows the user profile). */
export function observeConfigRoot(env: Record<string, string | undefined>, home: string, platform: ObservePlatform): string {
  const xdg = xdgOverride(env, 'XDG_CONFIG_HOME')
  const base = xdg !== null ? xdg
    : platform === 'darwin' ? join(home, 'Library', 'Preferences')
    : platform === 'win32' ? (xdgOverride(env, 'APPDATA') ?? join(home, 'AppData', 'Roaming'))
    : join(home, '.config')
  return join(base, 'wt-observe')
}

// ── per-OS identity parsers (card #1813359570421023938) ────────────────────────
// The impure probes (readFileSync /proc, execFileSync sysctl/ps/powershell) live in
// observe-cli; these are their PURE output parsers. Identity equality only ever compares
// values recorded and re-probed on the SAME machine/OS, so each parser just needs a
// stable value on its own platform — units are never compared across platforms.

/** macOS `sysctl -n kern.boottime` → `{ sec = 1751970002, usec = ... } <date>`; the sec
 *  field is the boot identity (the darwin analogue of Linux's boot_id). */
export function parseSysctlBoottimeSec(output: string): number | null {
  const m = /sec\s*=\s*(\d+)/.exec(output)
  return m !== null ? Number(m[1]) : null
}

/** macOS `ps -p <pid> -o lstart=` → `Tue Jul  8 07:30:02 2026` (local wall time, no TZ —
 *  fine: recorded and compared on the same machine). Epoch seconds, null on garbage. */
export function parsePsLstartEpochSec(output: string): number | null {
  const t = output.trim()
  if (t.length === 0) return null
  const ms = Date.parse(t)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

/** Windows PowerShell single-integer outputs (LastBootUpTime/StartTime via
 *  `ToUnixTimeSeconds()` — NOT `ToFileTime()`, whose ~1.3e17 exceeds
 *  Number.MAX_SAFE_INTEGER). CRLF-tolerant; null unless the whole line is an integer. */
export function parsePowershellInt(output: string): number | null {
  const t = output.trim()
  return /^\d+$/.test(t) ? Number(t) : null
}

/** THE server pidfile: a literal 'server.json' under the config-dir-independent state
 *  root — never a configDirKey, since the unified server serves 1+ config dirs, not
 *  pinned to exactly one. "One server per user" — a second `wt-observe start` adopts the
 *  SAME running server rather than minting a second pidfile, regardless of how many
 *  sources either invocation resolved. (Pre-unification this repo had TWO pidfile
 *  schemes — one per config dir, plus a separate 'hub.json' for 2+ sources; the verb
 *  unification collapses both into this one file.) */
export function observeServerPidfilePath(stateRoot: string): string {
  return join(stateRoot, 'server.json')
}

/** The server's own logfile — ONE formula (writer opens it, the fail-fast error tails
 *  it; two copies of the derivation would let them silently diverge). */
export function observeServerLogPath(stateRoot: string): string {
  return join(stateRoot, 'server.log')
}

export interface ObservePidfile {
  pid: number
  port: number
  /** The PRIMARY served config dir — always `sources[0]` (the first-resolved source).
   *  Kept as its own field (rather than folded away) so a 1-source pidfile still reads
   *  exactly like the pre-unification single-source pidfile did. */
  configDir: string
  /** Boot identity at write time — Linux boot_id / darwin `boottime-<sec>` / win32
   *  `boottime-<unix-sec>`; null when unprobeable. Only ever compared same-machine. */
  bootId: string | null
  /** Platform-specific process-start STAMP at write time — Linux: /proc clock ticks;
   *  darwin/win32: epoch seconds. The JSON key keeps its historical name for pidfile
   *  compat; only same-platform equality is ever tested, so units never mix. */
  procStartTicks: number | null
  startedAt: string
  /** Per-server API token (I8), passed to the spawn via env and kept here (0600 file).
   *  CARRIED across adopts from the prior pidfile (health never transports it — the
   *  served page is the browser's only carrier); absent only if never recorded. */
  token?: string
  /** The FULL set of config dirs this server serves (1+, `configDir` mirrors `sources[0]`).
   *  REQUIRED post-verb-unification — every pidfile this CLI writes now goes through the
   *  same resolved-source path, single-source included, so there is no longer a "pidfile
   *  shape that predates `sources`" to stay compatible with (no retro-compat required). */
  sources: string[]
}

/** Carry the recorded token into a rebuilt pidfile. Health responses NEVER carry the
 *  token, so any pidfile rebuilt from health (the adopt paths) would silently WIPE the
 *  only out-of-browser copy — the bug class this helper exists to close. Centralized
 *  and pure: a future adopt-like call site uses THIS, not an ad-hoc spread. */
export function withCarriedToken(next: ObservePidfile, prior: ObservePidfile | null): ObservePidfile {
  if (next.token !== undefined) return next
  if (prior?.token === undefined) return next
  return { ...next, token: prior.token }
}

export function serializeObservePidfile(pf: ObservePidfile): string {
  return JSON.stringify(pf)
}

export function parseObservePidfile(text: string): ObservePidfile | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  if (typeof m['pid'] !== 'number' || typeof m['port'] !== 'number') return null
  if (typeof m['configDir'] !== 'string' || typeof m['startedAt'] !== 'string') return null
  if (m['bootId'] !== null && typeof m['bootId'] !== 'string') return null
  if (m['procStartTicks'] !== null && typeof m['procStartTicks'] !== 'number') return null
  if (m['token'] !== undefined && typeof m['token'] !== 'string') return null
  if (!Array.isArray(m['sources']) || m['sources'].length === 0 || m['sources'].some((s) => typeof s !== 'string')) return null
  return raw as unknown as ObservePidfile
}

/** Dedup preserving first-seen order — shared by resolveHubSources' two branches so
 *  "unique" means the same thing whether the caller passed explicit flags or we're
 *  auto-discovering. */
function dedupe(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    if (!seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  return out
}

/**
 * Multi-observe I5 (+ config-file/glob follow-up) — which config dirs `wt-observe hub start`
 * mounts. Pure: `exists` and `canonicalize` are injected (the CLI passes real
 * `fs.existsSync` / `resolveDir`), and so are the THREE candidate lists below — gathered by
 * the impure CLI layer (flag parsing, `readObserveConfig`, `discoverConfigDirCandidates` in
 * observe-config.ts) — so every precedence branch here is testable with plain literals, no
 * fs/env/home access inside this function at all.
 *
 * Precedence: `--source` flags  >  config-file `sources`  >  auto-discovery.
 *  - `explicit` non-empty → WINS outright: canonicalized + deduped, NOT filtered by `exists`
 *    (the CLI validates each one exists separately and fails loudly on a typo, rather than
 *    this function silently dropping it like a discovery candidate would).
 *  - Else `configSources` non-empty (the already-string-filtered list `readObserveConfig`
 *    returned) → canonicalize + filter-`exists` + dedupe, and this SHORT-CIRCUITS discovery
 *    entirely — a configured source list is explicit user intent, not a hint to merge with
 *    auto-discovery. If it then resolves to fewer than 2, the caller's <2-refusal fires
 *    (this function doesn't know or care what "too few" means).
 *  - Else `discoveryCandidates` (the CLI's $CLAUDE_CONFIG_DIR + ~/.claude + ~/.claude-*-glob
 *    list) → canonicalize + filter-`exists` + dedupe.
 *
 * `canonicalize` (I5-review fix, preserved across every branch): candidates are mapped
 * through it BEFORE deduping — so "unique" means canonically-unique, exactly what the server
 * (`dev-api.ts` canonicalizes `OBSERVE_SOURCES` via `resolveDir` before its own `>= 2` check)
 * will conclude. Without it, two same-real-dir spellings (a symlink / trailing slash /
 * relative path) survive as distinct strings here, pass the caller's `< 2` refusal, then
 * collapse to one server-side → the server boots SINGLE-source and the hub readiness poll
 * times out (found by the codex cross-model I5 review, empirically reproduced by both
 * reviewers).
 */
export function resolveHubSources(
  explicit: readonly string[],
  configSources: readonly string[],
  discoveryCandidates: readonly string[],
  exists: (path: string) => boolean,
  canonicalize: (path: string) => string,
): string[] {
  if (explicit.length > 0) return dedupe(explicit.map(canonicalize))
  if (configSources.length > 0) return dedupe(configSources.map(canonicalize).filter(exists))
  return dedupe(discoveryCandidates.map(canonicalize).filter(exists))
}

/** What GET /api/health on the candidate port said: `ours` = a validly-shaped observe-ui
 *  server answered (either health shape — see classifyHealth); `foreign` = something
 *  answered CONCLUSIVELY not-ours (an unrelated process, or a mismatching self-reported
 *  port); `unreachable` = nothing listens (connection refused); `inconclusive` = a listener
 *  accepted but the probe TIMED OUT — maybe a busy-but-healthy server, so no destructive
 *  action may ever be taken on this verdict. */
export type HealthIdentity = 'ours' | 'foreign' | 'unreachable' | 'inconclusive'

/** The identity-relevant SHAPE of a health-probe result — decoupled from the CLI's full
 *  `Health` payload (pid/port/startedAt/claude/… stay in observe-cli.ts; this classifier
 *  never needs them). A structural subset: `Health` satisfies this by construction. */
export type HealthShape = { configDir?: string; sources?: unknown[] } | 'no-listener' | 'not-ours' | 'timeout'

/** Verb-unification classifier (merges the old per-config-dir `classifyHealth` and the
 *  hub's `classifyHubHealth` into one): there is now exactly ONE observe server per user
 *  (one pidfile, serving 1+ resolved sources), so "ours" no longer means "the health
 *  payload's `configDir` equals the ONE config dir this pidfile is scoped to" — that
 *  distinction only mattered when EACH config dir had its own pidfile/port and could
 *  collide with a sibling's. Ownership here is intentionally DRIFT-TOLERANT: a running
 *  server whose ACTUALLY-served set (either shape) differs from whatever was just freshly
 *  re-resolved (an added --source, a changed config file, a new discovery sibling) is
 *  STILL classified `ours` — changing the served set needs an explicit stop+restart, never
 *  a silent auto-adopt-and-diverge, and never a silent "not ours" that would spawn a
 *  SECOND competing server on a probed free port. The real, security-relevant ownership
 *  proof for anything destructive or token-transmitting is the pidfile's PID IDENTITY
 *  match (boot-id + /proc start ticks) — a separate check downstream — not this classifier.
 *  `no-listener`/`not-ours`/`timeout` already encode every case the OWNER-vs-anything-else
 *  question resolves at the transport level (probeHealth validated app==observe-ui and the
 *  self-reported port before ever producing an object here), so any object payload that
 *  reaches this function is `ours` by construction. */
export function classifyHealth(h: HealthShape): HealthIdentity {
  if (h === 'no-listener') return 'unreachable'
  if (h === 'not-ours') return 'foreign'
  if (h === 'timeout') return 'inconclusive'
  return 'ours'
}

export interface StartProbe {
  pidfile: ObservePidfile | null
  /** kill(pid, 0) — only meaningful when pidfile !== null. */
  pidAlive: boolean
  /** boot-id + /proc start ticks still match the pidfile — only meaningful when pidAlive. */
  pidIdentityMatches: boolean
  /** Health probe on pidfile.port (or the default port when no pidfile). */
  health: HealthIdentity
}

export type StartDecision =
  | { action: 'adopt' } // healthy + ours → re-own (rewrite the pidfile from health), print URL
  | { action: 'start' } // nothing there → spawn on the default port
  | { action: 'start-free-port' } // a foreign/unproven listener owns the port → spawn on a probed free port
  | { action: 'kill-zombie'; pid: number } // ours by identity, but CONCLUSIVELY wedged → SIGTERM, then re-decide
  | { action: 'clear-stale' } // dead pid or recycled pid → clear the pidfile, then re-decide
  | { action: 'retry-health' } // owned + alive but the probe timed out (maybe just busy) → re-probe, never kill

/** The start decision table. The CLI loops decide→act (bounded): `kill-zombie`,
 *  `clear-stale` and `retry-health` are intermediate — after acting, re-probe and
 *  decide again. */
export function decideStart(probe: StartProbe): StartDecision {
  if (probe.pidfile === null) {
    if (probe.health === 'ours') return { action: 'adopt' }
    // foreign AND inconclusive: something occupies the port — leave it alone either way.
    if (probe.health === 'foreign' || probe.health === 'inconclusive') return { action: 'start-free-port' }
    return { action: 'start' }
  }
  if (!probe.pidAlive || !probe.pidIdentityMatches) return { action: 'clear-stale' }
  // Our recorded process is alive and really is the one we started.
  if (probe.health === 'ours') return { action: 'adopt' }
  // A TIMEOUT is not proof of a zombie — a healthy server can be busy (journal scan,
  // GC pause). Never SIGTERM on an inconclusive verdict; re-probe patiently instead.
  if (probe.health === 'inconclusive') return { action: 'retry-health' }
  // Conclusively not serving (connection refused, or a foreign process answered while
  // ours sits unbound): a ZOMBIE we own — safe to SIGTERM precisely because identity matched.
  return { action: 'kill-zombie', pid: probe.pidfile.pid }
}

export interface StopProbe {
  pidfile: ObservePidfile | null
  pidAlive: boolean
  pidIdentityMatches: boolean
}

export type StopDecision =
  | { action: 'noop' } // no pidfile — nothing we own
  | { action: 'clear' } // dead or recycled pid — clear the pidfile, signal nothing
  | { action: 'kill'; pid: number } // owned + alive → SIGTERM then clear

/** The stop decision table. User-invoked (on-demand skill), so it stops the ONE observe
 *  server regardless of which session started it — but never a process whose identity no
 *  longer matches the pidfile (PID reuse). */
export function decideStop(probe: StopProbe): StopDecision {
  if (probe.pidfile === null) return { action: 'noop' }
  if (!probe.pidAlive || !probe.pidIdentityMatches) return { action: 'clear' }
  return { action: 'kill', pid: probe.pidfile.pid }
}

// ── `wt-observe config` verb — pure arg parsing (the fs read/write lives in
// observe-config.ts: readObserveConfig/writeObserveConfig; the CLI wires this parser to
// those). ────────────────────────────────────────────────────────────────────────────────

export type ConfigAction =
  | { action: 'show' }
  | { action: 'add-source'; dir: string }
  | { action: 'remove-source'; dir: string }
  | { action: 'add-remote'; url: string; token?: string; tokenFile?: string; label?: string }
  | { action: 'remove-remote'; url: string }
  | { action: 'invalid'; message: string }

const ADD_REMOTE_USAGE = 'usage: wt-observe config add-remote <url> [--token <t> | --token-file <path>] [--label <label>]'
const ADD_REMOTE_FLAGS: Record<string, 'token' | 'tokenFile' | 'label'> = {
  '--token': 'token',
  '--token-file': 'tokenFile',
  '--label': 'label',
}

/** Parse `wt-observe config <...rest>` (rest = argv with the leading `config` word already
 *  stripped — the CLI passes `argv.slice(1)`). Pure: no fs/env access, so every branch is
 *  plain-literal testable. `show` is the default action (bare `wt-observe config` prints the
 *  current state) — same "no verb = the read-only/status-like action" posture as the
 *  top-level command defaulting to `status`. */
export function parseConfigAction(rest: readonly string[]): ConfigAction {
  const sub = rest[0]
  if (sub === undefined || sub === 'show') return { action: 'show' }
  if (sub === 'add-source' || sub === 'remove-source') {
    const dir = rest[1]
    if (dir === undefined) return { action: 'invalid', message: `usage: wt-observe config ${sub} <dir>` }
    return { action: sub, dir }
  }
  if (sub === 'add-remote') {
    const url = rest[1]
    if (url === undefined || url.startsWith('--')) return { action: 'invalid', message: ADD_REMOTE_USAGE }
    const out: ConfigAction & { action: 'add-remote' } = { action: 'add-remote', url }
    for (let i = 2; i < rest.length; i += 2) {
      const flag = rest[i]!
      const field = ADD_REMOTE_FLAGS[flag]
      if (field === undefined) return { action: 'invalid', message: `config add-remote: unknown flag "${flag}"` }
      const value = rest[i + 1]
      if (value === undefined) return { action: 'invalid', message: `config add-remote: ${flag} requires a value` }
      out[field] = value
    }
    if (out.token !== undefined && out.tokenFile !== undefined) {
      return { action: 'invalid', message: 'config add-remote: pass --token OR --token-file, not both' }
    }
    return out
  }
  if (sub === 'remove-remote') {
    const url = rest[1]
    if (url === undefined) return { action: 'invalid', message: 'usage: wt-observe config remove-remote <url>' }
    return { action: 'remove-remote', url }
  }
  return {
    action: 'invalid',
    message: `unknown \`wt-observe config\` action "${sub}" (expected show|add-source|remove-source|add-remote|remove-remote)`,
  }
}

// ── remote-URL helpers (hub federation) — pure, shared by the CLI (add/remove-remote
// canonical compare) and the server side (dev-api.ts parses OBSERVE_REMOTES through the
// same normalization, so "same remote" means the same thing on both sides). ─────────────

/** Canonicalize a remote-hub URL: http/https only, lowercased/default-port-elided by the
 *  URL parser, trailing slashes stripped, query/hash dropped (a hub origin never carries
 *  them, and keeping them would make dedupe/removal spelling-sensitive). null = not a
 *  usable remote URL (the caller decides whether that is a hard error or a drop). */
export function normalizeRemoteUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/** What the Electron shell should do when a renderer calls `window.open(url)`.
 *  `external` (when set) is the URL to hand to the OS browser via shell.openExternal. */
export type WindowOpenDecision = { action: 'allow' } | { action: 'deny'; external: string | null }

/** Decide the Electron `setWindowOpenHandler` outcome for a renderer window.open(url).
 *  - http/https → a real external link: open it in the OS browser, deny the in-app popup.
 *  - about:/blob: → app-generated internal content (the "raw report" flow pre-opens
 *    `about:blank` then navigates it to a `blob:` of the authenticated report bytes): open
 *    an in-app child window. The OS CANNOT open these schemes — shell.openExternal('about:blank')
 *    or ('blob:…') triggers Windows' "look for an app in the Microsoft Store" prompt, which is
 *    the bug this replaces. Never externalize them.
 *  - anything else (javascript:, file:, data:, custom, or an unparseable url) → drop silently:
 *    neither externalize (Store prompt) nor allow (a javascript: window would be an XSS surface). */
export function classifyWindowOpen(url: string): WindowOpenDecision {
  let protocol = ''
  try {
    protocol = new URL(url).protocol
  } catch {
    protocol = ''
  }
  if (protocol === 'http:' || protocol === 'https:') return { action: 'deny', external: url }
  if (protocol === 'about:' || protocol === 'blob:') return { action: 'allow' }
  return { action: 'deny', external: null }
}

/** Collapse an arbitrary string to the [a-z0-9-] alphabet host.ts's SOURCE_PREFIX route
 *  contract requires (lowercase, every non-alphanumeric run → one '-', trimmed). The single
 *  home for that guarantee — every route key/segment that a remote or a config dir feeds into
 *  the router passes through here. */
export function slugKey(body: string): string {
  return body.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** The /s/<key> route segment for a remote (host.ts's SOURCE_PREFIX contract: the segment
 *  is used verbatim in the route table, so it must stay [a-z0-9-]): `remote-` +
 *  host[-port][-path], every non-alphanumeric run collapsed to a single '-'. Total: an
 *  unparseable input (callers pass normalizeRemoteUrl output, so this is belt-and-braces)
 *  is sanitized as a raw string rather than throwing. */
export function remoteKeyForUrl(url: string): string {
  let body: string
  try {
    const parsed = new URL(url)
    body = `${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`
  } catch {
    body = url
  }
  return `remote-${slugKey(body)}`
}

/** A remote entry as the SERVER mounts it — a config RemoteEntry plus its derived,
 *  route-stable key (host.ts's /s/<key> segment) and, after the boot health probe, the
 *  remote-side path prefix ('' for a single-source remote; '/s/<subkey>' when the remote
 *  is itself a hub and this mount targets ONE of its local sources). */
export interface ResolvedRemote {
  key: string
  url: string
  token?: string
  tokenFile?: string
  label?: string
  pathPrefix?: string
}

/** Explode one configured remote into its actual mounts, from its /api/health payload
 *  (public — no credentials needed at probe time). Pure: the impure fetch lives with the
 *  caller (dev-api.ts); every shape decision is here, plain-literal testable.
 *
 *  - health unusable (probe failed / non-object) → ONE flattened mount (degraded: the
 *    remote may be down right now; a single-source remote will just work, a hub remote
 *    404s until a restart re-probes — the caller notes this).
 *  - single-source health (no `sources` array) → ONE flattened mount (the remote serves
 *    unprefixed routes).
 *  - hub health (`sources[]`) → one mount PER remote-LOCAL source, proxied under
 *    '/s/<subkey>' (red-team confirmed: a remote hub serves NOTHING unprefixed, so a
 *    flattened mount against it 404s on every route). The remote's OWN remote:true
 *    entries are SKIPPED — federation depth is 1, deliberately: no transitive chains,
 *    no proxy loops (each world pairs directly with the worlds it wants).
 */
export function planRemoteMounts(remote: ResolvedRemote, healthBody: unknown): ResolvedRemote[] {
  const flattened: ResolvedRemote = { ...remote }
  if (typeof healthBody !== 'object' || healthBody === null) return [flattened]
  const rawSources = (healthBody as Record<string, unknown>)['sources']
  if (!Array.isArray(rawSources)) return [flattened]
  const locals = rawSources.filter(
    (s): s is Record<string, unknown> =>
      typeof s === 'object' &&
      s !== null &&
      (s as Record<string, unknown>)['remote'] !== true &&
      typeof (s as Record<string, unknown>)['key'] === 'string' &&
      // Route-safe key REQUIRED. The subKey lands in BOTH my local route key AND the
      // `/s/<subKey>` prefix I forward to the REMOTE's own route — so it must be used VERBATIM
      // (it has to byte-match the remote's configDirKey output, e.g. `-home-doublefx--claude-…`
      // with a leading + double dash). We therefore VALIDATE the charset instead of rewriting
      // it (an earlier slug-collapse here was a regression: it turned that key into
      // `home-doublefx-claude-…`, so every forwarded request 404'd → the UI read "server
      // unreachable"). A key outside [a-z0-9-] can't be a real remote route AND is unsafe to
      // splice into a forward path (`/`, CRLF, `..`), so such a sub-source is DROPPED, not mangled.
      /^[a-z0-9-]+$/.test((s as Record<string, unknown>)['key'] as string),
  )
  if (locals.length === 0) return [flattened]
  return locals.map((src) => {
    // VERBATIM (validated [a-z0-9-] above) — must byte-match the remote's own /s/<key> route.
    const subKey = src['key'] as string
    const configDir = typeof src['configDir'] === 'string' ? (src['configDir'] as string) : null
    // Cross-OS basename: the remote may report 'C:\\Users\\x\\.claude' while we run on
    // POSIX (or vice versa) — split on both separators rather than using path.basename.
    const subLabel = configDir !== null ? (configDir.split(/[\\/]/).filter((part) => part.length > 0).pop() ?? subKey) : subKey
    const mount: ResolvedRemote = {
      key: `${remote.key}-${subKey}`,
      url: remote.url,
      pathPrefix: `/s/${subKey}`,
      label: `${remote.label ?? remote.url} · ${subLabel}`,
    }
    if (remote.token !== undefined) mount.token = remote.token
    if (remote.tokenFile !== undefined) mount.tokenFile = remote.tokenFile
    return mount
  })
}

/** Shared remote-mount orchestration: probe each configured remote's health, note a degraded
 *  (flattened) mount when it doesn't answer, and explode a remote hub into per-source mounts.
 *  Both process shells that resolve remotes — dev-api.ts (env → OBSERVE_REMOTES) and the
 *  Electron desktop (config.json directly) — call THIS, so the probe→explode loop can never
 *  drift between them (the primitives were already shared; this closes the last hand-copied
 *  loop). The impure health probe is injected. Notes are prefix-free; the caller tags them. */
export async function resolveRemoteMounts(
  entries: readonly ResolvedRemote[],
  probe: (remote: ResolvedRemote) => Promise<unknown>,
): Promise<{ mounts: ResolvedRemote[]; notes: string[]; unhealthy: ResolvedRemote[] }> {
  const mounts: ResolvedRemote[] = []
  const notes: string[] = []
  // The CONFIGURED entries whose probe did not answer — returned so an embedding shell
  // (the Electron desktop) can re-probe them later and re-resolve when one comes back
  // (auto-reconnect); the flattened mount below keeps the boot behavior unchanged.
  const unhealthy: ResolvedRemote[] = []
  for (const entry of entries) {
    const health = await probe(entry)
    if (health === null) {
      unhealthy.push(entry)
      notes.push(
        `remote ${entry.url} did not answer its health probe — mounting it flattened (a single-source remote will work once up; a hub remote needs a restart here to re-probe).`,
      )
    }
    mounts.push(...planRemoteMounts(entry, health))
  }
  return { mounts, notes, unhealthy }
}

/** Federation-aware start port: if a configured remote points at loopback:<preferred>, an
 *  embedding shell (or the CLI hub) must start on the NEXT port — on WSL2/Windows one shared
 *  default port shadows localhost forwarding and would federate the hub WITH ITSELF (the
 *  self-federation demo-killer). Pure. createHost carries the same guard as a backstop. */
export function pickStartPort(preferred: number, remotes: readonly ResolvedRemote[]): number {
  const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
  const clash = remotes.some((remote) => {
    try {
      const url = new URL(remote.url)
      const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
      return LOOPBACK.has(url.hostname) && port === preferred
    } catch {
      return false
    }
  })
  return clash ? preferred + 1 : preferred
}

/** The decision an embedding shell (the Electron desktop) makes when its preferred port is
 *  already bound (EADDRINUSE). The TRUST ANCHOR is the 0600 identity-probed pidfile — NOT the
 *  unauthenticated /api/health `app` flag, which any local process can spoof on a shared
 *  loopback box:
 *   - `adopt` — the pidfile authenticates OUR OWN server as the port owner (even when the
 *     health probe merely TIMED OUT on a slow-but-healthy server): load its origin as-is. The
 *     shell must NOT claim the canonical pidfile — the owner already holds it.
 *   - `ephemeral` — no authenticated corroboration (a genuinely foreign process, an observe
 *     server with no corroborating pidfile, or a bind race): run a PRIVATE server on an
 *     ephemeral port and NEVER overwrite the canonical pidfile. Overwriting it would hijack
 *     `wt-observe status|stop|launch|await` away from whoever legitimately owns the preferred
 *     port — the exact drift the desktop's shared-function design exists to prevent (and, for
 *     the timeout case, the bug this decision table replaces: a slow health probe no longer
 *     reads as "foreign").
 *  Pure + total — every branch is decided here, so main.ts's electron glue stays testable. */
export type PortAdoptionDecision =
  | { kind: 'adopt'; served: string[]; mismatch: boolean }
  | { kind: 'ephemeral'; reason: 'foreign' | 'unauthenticated-observe' | 'inconclusive' }

export function decidePortAdoption(args: {
  port: number
  health: unknown
  pidfile: ObservePidfile | null
  wanted: readonly string[]
}): PortAdoptionDecision {
  const { port, health, pidfile, wanted } = args
  const healthObj = typeof health === 'object' && health !== null ? (health as Record<string, unknown>) : null
  // Map the raw probe result onto the SHARED HealthShape and classify with the SAME table the
  // CLI's start path uses — so a no-answer/TIMEOUT becomes 'inconclusive', never 'foreign'
  // (the exact distinction the desktop's old hand-rolled binary ours/foreign check collapsed,
  // turning a slow-but-healthy server into a pidfile-hijacking ephemeral fallback).
  const shape: HealthShape =
    healthObj === null ? 'timeout' : healthObj['app'] === 'observe-ui' ? (healthObj as { configDir?: string; sources?: unknown[] }) : 'not-ours'
  const identity = classifyHealth(shape)
  // Trust anchor = the 0600 identity-probed pidfile recording THIS port as ours, NOT the
  // spoofable health `app` flag. (Residual: a stale pidfile whose recorded process died and
  // whose port a foreign process rebound would still read as owned — a same-uid loopback edge;
  // adding a pidAlive + boot/proc identity re-check is the follow-up hardening card.)
  const pidfileOwnsPort = pidfile !== null && pidfile.port === port

  if (pidfileOwnsPort) {
    // Authenticated as ours. Compare the served set ONLY when the probe actually answered (a
    // timeout leaves no live set — adopt clean, no scary mismatch dialog on our own server).
    if (identity === 'ours' && Array.isArray(healthObj?.['sources'])) {
      const served = (healthObj['sources'] as unknown[]).map((s) => {
        const o = typeof s === 'object' && s !== null ? (s as Record<string, unknown>) : {}
        return (typeof o['configDir'] === 'string' ? o['configDir'] : typeof o['key'] === 'string' ? o['key'] : '?') as string
      })
      const mismatch = served.length !== wanted.length || wanted.some((w) => !served.includes(w))
      return { kind: 'adopt', served, mismatch }
    }
    return { kind: 'adopt', served: pidfile.sources ?? [pidfile.configDir], mismatch: false }
  }
  // No authenticated corroboration — never load a possibly-foreign origin into the trusted
  // window and never touch the canonical pidfile: run a private ephemeral server instead.
  if (identity === 'ours') return { kind: 'ephemeral', reason: 'unauthenticated-observe' }
  if (identity === 'foreign') return { kind: 'ephemeral', reason: 'foreign' }
  return { kind: 'ephemeral', reason: 'inconclusive' }
}

/** Parse the OBSERVE_REMOTES env payload (a JSON array of { url, token?, tokenFile?,
 *  label? } — JSON, NOT delimiter-joined: URLs contain colons on every platform). Pure and
 *  total: malformed JSON / a non-array / bad entries degrade to drops with a human note
 *  each (`dropped`), never a throw — the CLI already validated what it wrote here, so a
 *  drop only fires for a hand-set env var, and the server names it instead of dying.
 *  URLs are canonicalized (normalizeRemoteUrl) and deduped by derived KEY, first-wins —
 *  the same first-wins posture as the source list's own dedupe. */
export function parseObserveRemotesEnv(raw: string | undefined): { remotes: ResolvedRemote[]; dropped: string[] } {
  if (raw === undefined || raw.trim().length === 0) return { remotes: [], dropped: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { remotes: [], dropped: ['OBSERVE_REMOTES is not valid JSON — ignoring it'] }
  }
  if (!Array.isArray(parsed)) return { remotes: [], dropped: ['OBSERVE_REMOTES is not a JSON array — ignoring it'] }
  return resolveRemoteEntries(parsed)
}

/** The entry-list half of the resolution — shared verbatim by the env path above (the
 *  CLI-spawned server) and the Electron desktop shell (which reads config.json remotes
 *  directly, no env hop): canonicalize URLs, derive keys, dedupe first-wins, keep
 *  non-blank string credentials/labels, drop the rest with a note each. */
export function resolveRemoteEntries(list: readonly unknown[]): { remotes: ResolvedRemote[]; dropped: string[] } {
  const remotes: ResolvedRemote[] = []
  const dropped: string[] = []
  const seenKeys = new Set<string>()
  for (const item of list) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      dropped.push(`remotes entry ${JSON.stringify(item)} is not an object — dropped`)
      continue
    }
    const obj = item as Record<string, unknown>
    const rawUrl = obj['url']
    const url = typeof rawUrl === 'string' ? normalizeRemoteUrl(rawUrl) : null
    if (url === null) {
      dropped.push(`remotes entry ${JSON.stringify(rawUrl)} has no usable http(s) url — dropped`)
      continue
    }
    const key = remoteKeyForUrl(url)
    if (seenKeys.has(key)) {
      dropped.push(`remotes entry ${url} duplicates key "${key}" — dropped (first entry wins)`)
      continue
    }
    seenKeys.add(key)
    const remote: ResolvedRemote = { key, url }
    for (const field of ['token', 'tokenFile', 'label'] as const) {
      const value = obj[field]
      if (typeof value === 'string' && value.trim().length > 0) remote[field] = value
    }
    remotes.push(remote)
  }
  return { remotes, dropped }
}
