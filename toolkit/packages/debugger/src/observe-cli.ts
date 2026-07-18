// observe-cli.ts — the IMPURE shell of `wt-observe`: probes (pid liveness, /proc
// identity, /api/health), actions (detached spawn with a rotating logfile, SIGTERM,
// authenticated /api calls), and the bounded decide→act loop around the pure
// decision tables in observe-lifecycle.ts (+ observe-await.ts for `await`).
//
// ONE observe server total (verb-unification — the old split between a per-config-dir
// single-source server and a separate `hub` verb is dissolved): `start` always resolves
// 1+ Claude config dirs (--source flags > the persistent config-file list > auto-discovery
// — resolveHubSources' own precedence, unchanged) and serves that whole SET through ONE
// server + ONE pidfile (`server.json`) under the config-dir-INDEPENDENT state root
// (~/.local/state/wt-observe). 1 resolved source runs unprefixed (byte-identical to the old
// single-source server); 2+ mount a source-switcher server, each under /s/<key>/ — see
// createHost in host.ts, unchanged by this refactor.
//
//     wt-observe start [--source <dir>]... [--watch] [--enable-launch]
//                          — resolve the source set, adopt a healthy server or spawn one
//                          (detached). --enable-launch opts the instance into live launches
//                          (spawn env, or runtime POST /api/launch-enable on adopt — the
//                          latter only when EXACTLY 1 source is served: multi-source has no
//                          server-wide launch toggle, only a per-source one under
//                          /s/<key>/api/launch-enable).
//     wt-observe stop    — SIGTERM the owned server (identity-checked), clear the pidfile
//     wt-observe status  — pidfile + live health (sources served, launch opt-in), human-readable
//     wt-observe launch  — POST /api/launch a workflow by id, print { runId }
//     wt-observe await   — block until a run finishes, print { runId, status, result }
//                          (run it with run_in_background: its exit IS the notification)
//     wt-observe config show|add-source <dir>|remove-source <dir>
//                          — manage the persistent source list at
//                          <observeConfigRoot>/config.json (readObserveConfig/
//                          writeObserveConfig) — NEVER auto-written by `start`; the file
//                          stays strictly opt-in, populated only via this verb.
//
// Source resolution (unchanged from the old `hub` verb, minus its <2 refusal): `--source`
// flags win outright; else the persistent list at <observeConfigRoot>/config.json; else
// auto-discovery of $CLAUDE_CONFIG_DIR (if set) plus every existing ~/.claude* sibling
// (discoverConfigDirCandidates — a glob), each validated to contain a projects/ run store.
// A 0-source resolution (nothing configured/discovered yet — e.g. a brand-new config dir
// with no run history) falls back to the bare CLAUDE_CONFIG_DIR ?? ~/.claude default, so
// `start` never regresses to a hard failure for a fresh single-user setup.
//
// Interim (pre-npm distribution): the spawn target is the repo checkout's dev
// server (tsx apps/observe-ui/server/dev-api.ts), located from $DWT_OBSERVE_ROOT
// or by walking up from cwd — the same interim posture as the card's
// "Distribution" item (build-from-repo until @workflow-toolbox/observe-ui ships).

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  classifyHealth,
  decideStart,
  decideStop,
  normalizeRemoteUrl,
  observeConfigRoot,
  observeServerLogPath,
  observeServerPidfilePath,
  observeStateRoot,
  parseConfigAction,
  parseObservePidfile,
  resolveHubSources,
  serializeObservePidfile,
  withCarriedToken,
  type HealthIdentity,
  type ObservePidfile,
} from './observe-lifecycle.js'
import { clearAllLaunchEnableRecords } from './launch-enable-state.js'
import { composeCapabilityOptions, extractCapabilities, type CapabilitiesSpec } from './capabilities.js'
import { loadCapabilityRegistry, probeProviders, type CapabilityRegistry, type CapabilitySidecar } from './capability-registry.js'
import { composeLaunchCapabilities, foldCapabilitiesIntoArgs, inlineObserverRequires, observerDefinitionFileWarnings, ownObserverResolutions, resolveObserverRequires, sidecarPathFor } from './launch-capabilities.js'
import { isRecord } from './validator-shared.js'
import { extractObservers } from './observer-def.js'
import { buildLaunchBody, safeRequesterCwd, resolveLaunchTimeoutMs, resolveWebAvailable } from './launch-body.js'
import { awaitSpawnedServerReady } from './spawn-ready.js'
import { readBootId, readProcStartStamp, pidState } from './observe-identity.js'
import { discoverConfigDirCandidates, readObserveConfig, writeObserveConfig, type RemoteEntry } from './observe-config.js'
import { classifyAwaitTick, extractAwaitOutcome, awaitExitCode, truncateAwaitError, AWAIT_SOURCE_UNRESOLVED_EXIT_CODE } from './observe-await.js'
import { recoverExitCodeFor } from './observe-resume.js'
import {
  resolveSource,
  localSourceKeys,
  classifySourceSearch,
  SourceResolutionError,
  type ResolvedSource,
  type SourcesListEntry,
  type SourceSearchResult,
} from './source-resolve.js'
import { resolveConfigDir, resolveDir } from './config-dir.js'
import {
  selectRuns,
  runNameFromScript,
  parseDurationMs,
  pathsToDelete,
  DEFAULT_TEST_PREFIXES,
  type PruneRunRecord,
} from './observe-prune.js'

const DEFAULT_PORT = 5174
const HEALTH_TIMEOUT_MS = 2_000
// How long `start` waits for a fresh spawn to answer /api/health before declaring failure.
const SPAWN_READY_TIMEOUT_MS = 30_000
const LOG_ROTATE_BYTES = 5 * 1024 * 1024

// ── identity probes — EXTRACTED to observe-identity.ts (shared with the Electron
// desktop shell, which writes the same pidfile through the same probes). ────────────────

// ── health probe ────────────────────────────────────────────────────────────────

interface Health {
  app: string
  pid: number
  port: number
  // 1-source mode: the served config dir. Absent when the server serves 2+ sources
  // (`sources` reported instead) — see server/host.ts's makeHubHandler.
  configDir?: string
  startedAt: string
  // S1 version observability (additive, absent on pre-I8 servers): WHICH claude
  // drives that server's live launches, and its version. Not identity-relevant —
  // never part of the adopt/foreign classification.
  claude?: string | null
  claudeVersion?: string | null
  // Live-launch opt-in state (additive, absent on older builds). Not identity-relevant.
  launchEnabled?: boolean
  // 2+-source mode: one entry per mounted config dir, INSTEAD of a single `configDir`.
  sources?: { key: string; configDir: string }[]
}

/** Probe /api/health. Distinguishes "nothing listens" (ECONNREFUSED → the port is
 *  free, safe to bind), "something answered CONCLUSIVELY not-ours" (an old server
 *  build, or an unrelated process → FOREIGN), and "the probe TIMED OUT" (a listener
 *  accepted but did not answer in time → maybe a busy-but-healthy server: an
 *  INCONCLUSIVE verdict no destructive action may rest on). The self-reported `port`
 *  must match the port actually probed — a mismatching answer is treated as not-ours
 *  (never adopt/print an identity a squatter chose). */
async function probeHealth(port: number, timeoutMs = HEALTH_TIMEOUT_MS): Promise<Health | 'no-listener' | 'not-ours' | 'timeout'> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return 'not-ours'
    const body: unknown = await res.json()
    if (typeof body !== 'object' || body === null) return 'not-ours'
    const h = body as Record<string, unknown>
    if (h['app'] !== 'observe-ui') return 'not-ours'
    if (typeof h['pid'] !== 'number' || typeof h['port'] !== 'number') return 'not-ours'
    if (typeof h['startedAt'] !== 'string') return 'not-ours'
    // A 1-source server reports `configDir` (a string); a 2+-source server reports
    // `sources` (an array) INSTEAD. Accept either identity shape here — classifyHealth
    // (observe-lifecycle.ts) no longer distinguishes them at all (see its own doc).
    const hasConfigDir = typeof h['configDir'] === 'string'
    const hasSources = Array.isArray(h['sources'])
    if (!hasConfigDir && !hasSources) return 'not-ours'
    if (h['port'] !== port) return 'not-ours' // self-reported port must be the one probed
    // Residual trust: pid/configDir/startedAt are still self-reported (unauthenticated
    // localhost). The per-server token (I8) closes this; impact today is bounded to
    // same-user confused-deputy (kill only reaches processes the user already owns).
    return h as unknown as Health
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') return 'timeout'
    const cause = (err as { cause?: { code?: string } }).cause
    // Connection refused = the port is genuinely free. Other conclusive transport
    // errors (reset, protocol garbage) = something holds the port and is not ours.
    return cause?.code === 'ECONNREFUSED' ? 'no-listener' : 'not-ours'
  }
}

/** Ask the OS for a free port: listen(0), read it back, close. */
async function probeFreePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      srv.close(() => (port > 0 ? resolvePort(port) : reject(new Error('no port assigned'))))
    })
  })
}

// ── spawn target (interim: a local checkout) ────────────────────────────────────

/** Locate the dir that DIRECTLY contains apps/observe-ui/server/dev-api.ts — a
 *  Workflow Observatory checkout root, or a legacy monorepo's toolkit/ dir.
 *  $DWT_OBSERVE_ROOT wins (either shape accepted, with or without the toolkit/
 *  segment); else walk up from cwd, probing each ancestor itself, its toolkit/,
 *  and a workflow-observatory/ checkout sitting under it (the sibling-dir case:
 *  walking up from the public repo reaches the common parent, which contains
 *  the observatory checkout). Returns the SERVER BASE, not the repo root. */
function findObserveRoot(cwd: string, env: Record<string, string | undefined>): string | null {
  // Identity gate (review finding, 2026-07-11): the walk EXECUTES what it finds, so mere
  // existence of the dev-api.ts path is not enough on a shared filesystem — require the
  // app manifest to identify itself before trusting the base. Not a cryptographic
  // boundary (a writer in your ancestor path can forge it), but it stops accidental and
  // low-effort lookalikes; DWT_OBSERVE_ROOT stays the explicit override.
  const isObserveApp = (d: string): boolean => {
    try {
      const pkg: unknown = JSON.parse(readFileSync(join(d, 'apps', 'observe-ui', 'package.json'), 'utf8'))
      return typeof pkg === 'object' && pkg !== null && (pkg as Record<string, unknown>)['name'] === '@workflow-toolbox/observe-ui'
    } catch {
      return false
    }
  }
  const hasServer = (d: string): boolean =>
    existsSync(join(d, 'apps', 'observe-ui', 'server', 'dev-api.ts')) && isObserveApp(d)
  const probe = (d: string): string | null =>
    hasServer(d) ? d : hasServer(join(d, 'toolkit')) ? join(d, 'toolkit') : null
  const forced = env['DWT_OBSERVE_ROOT']
  if (forced !== undefined && forced.length > 0) return probe(forced)
  let dir = cwd
  for (let depth = 0; depth < 64; depth++) { // bounded — a cwd 64 dirs deep is not a checkout
    const hit = probe(dir) ?? probe(join(dir, 'workflow-observatory'))
    if (hit !== null) return hit
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

// ── logfile (one rotation generation) ───────────────────────────────────────────

/** The actual open+rotate logic, parameterized by the ALREADY-COMPUTED log path — shared by
 *  every caller (just observeServerLogPath's path now, post verb-unification). */
function openLogFileAt(path: string): number {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    if (existsSync(path) && statSync(path).size > LOG_ROTATE_BYTES) {
      renameSync(path, `${path}.1`)
    }
  } catch {
    // rotation is best-effort
  }
  return openSync(path, 'a', 0o600)
}

// ── pidfile IO ──────────────────────────────────────────────────────────────────

function readPidfileAt(path: string): ObservePidfile | null {
  try {
    return parseObservePidfile(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function writePidfileAt(path: string, pf: ObservePidfile): void {
  // 0700 dir / 0600 file: the pidfile will carry the per-server token (I8) — keep
  // the whole state root out of other local users' reach from day one.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, serializeObservePidfile(pf), { mode: 0o600 })
}

function clearPidfileAt(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // already gone
  }
}

/** One-line best-effort cleanup of the OLD (pre-verb-unification) hub pidfile: a prior
 *  bundle version could leave `hub.json` behind under the same state root once the user
 *  moves to the unified `start`/`stop` (which only ever read/write `server.json`). Never
 *  throws — most machines never had one; this must never block the real command. */
function clearLegacyHubPidfile(stateRoot: string): void {
  try {
    unlinkSync(join(stateRoot, 'hub.json'))
  } catch {
    // absent, or unremovable — best-effort only
  }
}

/** Pidfile content for a server we just confirmed healthy: identity is read from
 *  /proc for the pid HEALTH reported (not the spawn wrapper's pid — tsx/pnpm may
 *  interpose), so stop/adopt later verify the right process. `configDir` mirrors
 *  `sources[0]` (the primary/first-resolved source) — see ObservePidfile's own doc. */
/** The config-dir SET a health payload says the server ACTUALLY serves — hub shape
 *  (`sources[]`) or single-source shape (`configDir`). Used to record the pidfile from what
 *  is really running, NOT from the caller's freshly-resolved request (codex review): on an
 *  ADOPT of a server whose served set has drifted from the request, recording the request
 *  would write a pidfile — and print an "adopted" message — claiming a set the server does
 *  not serve. Deriving from `h` keeps the pidfile-of-record true. Empty only for a malformed
 *  payload probeHealth would already have rejected as not-ours. */
function sourcesFromHealth(h: Health): string[] {
  if (Array.isArray(h.sources)) return h.sources.map((s) => s.configDir)
  return typeof h.configDir === 'string' ? [h.configDir] : []
}

/** Order-independent set equality — the adopt path compares the server's actual served set
 *  against the freshly-resolved request to decide whether to warn about drift. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((v, i) => v === sb[i])
}

function pidfileFromHealth(h: Health): ObservePidfile {
  const sources = sourcesFromHealth(h)
  return {
    pid: h.pid,
    port: h.port,
    configDir: sources[0]!,
    bootId: readBootId(),
    procStartTicks: readProcStartStamp(h.pid),
    startedAt: h.startedAt,
    sources,
  }
}

// ── commands ────────────────────────────────────────────────────────────────────

interface Ctx {
  pidfilePath: string
  stateRoot: string
}

function makeCtx(): Ctx {
  const stateRoot = observeStateRoot(process.env, homedir(), process.platform)
  return { stateRoot, pidfilePath: observeServerPidfilePath(stateRoot) }
}

async function probeFor(ctx: Ctx): Promise<{ pf: ObservePidfile | null; health: Health | null; identity: HealthIdentity; alive: boolean; idMatch: boolean; port: number }> {
  const pf = readPidfileAt(ctx.pidfilePath)
  const port = pf?.port ?? Number(process.env['OBSERVE_UI_SERVER_PORT'] ?? DEFAULT_PORT)
  const probed = await probeHealth(port)
  const { alive, idMatch } = pidState(pf)
  return {
    pf,
    health: typeof probed === 'object' ? probed : null,
    identity: classifyHealth(probed),
    alive,
    idMatch,
    port,
  }
}

interface StartFlags {
  watch: boolean
  enableLaunch: boolean
}

/** Resolve the source set `wt-observe start` serves: --source flags > the persistent
 *  config-file list > auto-discovery (resolveHubSources' own precedence, unchanged from the
 *  old `hub` verb). Unlike the pre-unification hub, there is NO <2 refusal — 1 resolved
 *  source is the common case (createHost runs it unprefixed, byte-identical to the old
 *  single-source server). A 0-source resolution (nothing --source'd, configured, or
 *  discovered — e.g. a brand-new config dir with no run history yet, so it fails
 *  discovery's `projects/` content check) falls back to the bare CLAUDE_CONFIG_DIR ??
 *  ~/.claude default: the EXACT pre-unification single-source default, so `start` never
 *  regresses to a hard failure for a fresh single-user setup that configured/discovered
 *  nothing yet. */
function resolveStartSources(explicitRaw: readonly string[]): string[] {
  const explicit = explicitRaw.map(resolveDir)
  for (const [i, dir] of explicit.entries()) {
    if (!existsSync(dir)) throw new Error(`--source ${explicitRaw[i]}: directory does not exist (resolved to ${dir})`)
  }
  const configRoot = observeConfigRoot(process.env, homedir(), process.platform)
  const { sources: configSources } = readObserveConfig(configRoot)
  const discoveryCandidates = discoverConfigDirCandidates(process.env, homedir())
  const resolved = resolveHubSources(explicit, configSources, discoveryCandidates, existsSync, resolveDir)
  if (resolved.length > 0) return resolved
  // Nothing resolved — fall back to the active config dir so `start` always works (matching the
  // pre-unification single-source start, which never existence-checked). But SAY so (codex
  // review): an all-stale CONFIGURED list resolving to nothing is materially different from a
  // fresh setup, and a silent substitution would hide it. `config show` surfaces the details.
  const fallback = resolveConfigDir()
  if (configSources.length > 0 || discoveryCandidates.length > 0) {
    process.stderr.write(
      `note: no configured/discovered source still resolves — falling back to ${fallback}. Run \`wt-observe config show\` to see why.\n`,
    )
  }
  return [fallback]
}

/** The configured remote-hub entries `start` forwards to the server (OBSERVE_REMOTES).
 *  Config-file only (no --remote flag: remotes are durable pairings, not per-start
 *  gestures); entries whose URL is unusable are SKIPPED with a note — one stale remote
 *  must not block the whole start. */
function resolveStartRemotes(): RemoteEntry[] {
  const configRoot = observeConfigRoot(process.env, homedir(), process.platform)
  const { remotes } = readObserveConfig(configRoot)
  const valid: RemoteEntry[] = []
  for (const remote of remotes) {
    if (normalizeRemoteUrl(remote.url) === null) {
      process.stderr.write(`note: skipping configured remote "${remote.url}" — not a usable http(s) URL (\`wt-observe config show\`).\n`)
    } else {
      valid.push(remote)
    }
  }
  return valid
}

/** The agents-only shim plugin (plugin/launch-agents/) handed to the server for its
 *  delegated SDK sessions. Resolved from THIS module's own location so both homes work:
 *  the built artifact (plugin/bin/wt-observe.mjs → ../launch-agents) and a source run
 *  (toolkit/packages/debugger/src/ → repo-root plugin/launch-agents). realpath FIRST —
 *  a symlinked bin must resolve the true plugin dir, not the symlink's neighborhood
 *  (same class as the bin entry-guard realpath lesson). null when no candidate exists
 *  (an older layout): the env stays unset and the server behaves exactly as before. */
function resolveLaunchAgentsDir(): string | null {
  let selfDir: string
  try {
    selfDir = dirname(realpathSync(fileURLToPath(import.meta.url)))
  } catch {
    return null
  }
  for (const rel of ['../launch-agents', '../../../../plugin/launch-agents']) {
    const candidate = resolvePath(selfDir, rel)
    if (existsSync(join(candidate, '.claude-plugin', 'plugin.json'))) return candidate
  }
  return null
}

async function spawnServer(stateRoot: string, port: number, sourceDirs: readonly string[], remotes: readonly RemoteEntry[], flags: StartFlags): Promise<{ health: Health; token: string }> {
  const base = findObserveRoot(process.cwd(), process.env)
  if (base === null) {
    throw new Error(
      'cannot locate the observe server (no checkout found from cwd; set DWT_OBSERVE_ROOT). ' +
        'Until the Workflow Observatory binary distribution ships, wt-observe start needs a ' +
        'workflow-observatory checkout (or a legacy workflow-toolbox one) on this machine.',
    )
  }
  const logPath = observeServerLogPath(stateRoot)
  const log = openLogFileAt(logPath)
  // Size BEFORE the child writes anything: the port-banner parser must only
  // see THIS spawn's output — the log is append-mode, and a stale banner from
  // a previous server would otherwise announce the wrong port (card
  // #1820935029484684499).
  const logStartOffset = ((): number => {
    try {
      return statSync(logPath).size
    } catch {
      return 0
    }
  })()
  // Per-server API token (I8): generated here, handed to the server via env, kept
  // in the 0600 pidfile. The browser receives it through the served page only.
  const token = randomBytes(24).toString('hex')
  const launchAgentsDir = resolveLaunchAgentsDir()
  // --watch: the server owns a vite build watcher child (dev-api.ts reaps it on every
  // exit path), so UI edits rebuild live — the dev loop the bare start deliberately skips.
  // --enable-launch: boot-time live-launch opt-in (dev-api.ts reads the env) — the
  // DELIBERATE per-start gesture that replaces "re-POST /api/launch-enable after every
  // restart" without ever persisting the opt-in across starts.
  // Spawn target = node + tsx's OWN JS entry, resolved from the checkout — NOT
  // `spawn('pnpm', ...)`: on Windows the pnpm/.bin shims are .cmd files, which Node
  // (>=18.20, CVE-2024-27980) refuses to spawn without shell:true, and shell:true
  // reopens quoting of paths-with-spaces. node + a resolved .mjs runs identically on
  // every OS (cross-OS I3, card #1813359570421023938).
  const tsxCli = ((): string => {
    try {
      return createRequire(join(base, 'package.json')).resolve('tsx/cli')
    } catch {
      throw new Error(`observe base ${base} has no resolvable 'tsx' — run pnpm install in ${base}`)
    }
  })()
  const child = spawn(process.execPath, [tsxCli, 'apps/observe-ui/server/dev-api.ts', ...(flags.watch ? ['--watch'] : [])], {
    cwd: base,
    env: {
      ...process.env,
      // Both env vars are set regardless of cardinality: dev-api.ts only switches to
      // multi-source mode when OBSERVE_SOURCES resolves to 2+ UNIQUE entries (its own
      // `parsedSources.length >= 2` check) — with exactly 1 resolved source it falls
      // straight through to CLAUDE_CONFIG_DIR, so setting both here is always correct and
      // needs no cardinality branch on this side either.
      CLAUDE_CONFIG_DIR: sourceDirs[0]!,
      // path.delimiter, not ':' — a colon inside 'C:\...' would shred Windows paths;
      // dev-api.ts splits with the same constant (same machine, same value).
      OBSERVE_SOURCES: sourceDirs.join(delimiter),
      OBSERVE_UI_SERVER_PORT: String(port),
      OBSERVE_UI_TOKEN: token,
      // Remote-hub mounts (hub federation) — JSON, not delimiter-joined: URLs carry
      // colons everywhere. Only set when configured, so a remote-less start's env is
      // byte-identical to before.
      ...(remotes.length > 0 ? { OBSERVE_REMOTES: JSON.stringify(remotes) } : {}),
      ...(flags.enableLaunch ? { OBSERVE_UI_ENABLE_LAUNCH: '1' } : {}),
      // The agents-only shim plugin the server loads into every DELEGATED SDK
      // session (SDK `plugins` option), so `workflow-toolbox:lean`/`leaf` resolve
      // there despite the sessions' deliberate `settingSources: []` (without it
      // the fences always probe "not found" and degrade — found live 2026-07-13).
      // An explicit user-set value wins; absent shim (older checkout) = unset,
      // the server then launches exactly as before.
      ...(process.env['OBSERVE_LAUNCH_PLUGIN_DIRS'] === undefined && launchAgentsDir !== null
        ? { OBSERVE_LAUNCH_PLUGIN_DIRS: launchAgentsDir }
        : {}),
    },
    detached: true,
    windowsHide: true, // win32: detached must not flash a console window
    stdio: ['ignore', log, log],
  })
  // Both failure signals are OBSERVED, not assumed: an async spawn error (e.g. a
  // missing node executable → ENOENT) must reject cleanly, and a child that dies right
  // away (EADDRINUSE, tsx load error) must fail FAST with the log tail — not mask
  // itself as a silent 30s readiness timeout.
  let spawnError: Error | null = null
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null
  child.once('error', (e) => {
    spawnError = e
  })
  child.once('exit', (code, signal) => {
    exited = { code, signal }
  })
  child.unref()

  // The port bind is the mutex: wait for /api/health to answer OURS. A lost
  // concurrent-start race surfaces here as the WINNER's health — which we adopt.
  // The wait itself lives in spawn-ready.ts (injectable, test-locked — card
  // #1820935029484684499): port 0 resolves the child's REAL OS-assigned port
  // from its log banner (this spawn's slice only), and a readiness timeout
  // REAPS the still-alive child by precise PID instead of leaving an orphan.
  const h = await awaitSpawnedServerReady<Health>({
    requestedPort: port,
    timeoutMs: SPAWN_READY_TIMEOUT_MS,
    readLogSlice: () => readLogSliceFrom(logPath, logStartOffset),
    probe: (p) => probeHealth(p),
    // Accept EITHER health shape (the readiness poll must not assume cardinality).
    isReady: (v): v is Health =>
      typeof v === 'object' && (Array.isArray((v as Health).sources) || typeof (v as Health).configDir === 'string'),
    spawnState: () => ({ error: spawnError, exited }),
    kill: () => {
      if (typeof child.pid === 'number') {
        try {
          process.kill(child.pid, 'SIGTERM')
        } catch {
          // already gone — nothing to reap
        }
      }
    },
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    logTail: () => logTail(logPath),
  })
  return { health: h, token }
}

/** The log slice written after `offset` BYTES (append-mode log — earlier
 *  content belongs to previous servers). Byte-accurate: slices the raw buffer,
 *  not the decoded string. */
function readLogSliceFrom(path: string, offset: number): string {
  try {
    const buf = readFileSync(path)
    return buf.subarray(Math.min(offset, buf.length)).toString('utf8')
  } catch {
    return ''
  }
}

/** Last few log lines, labelled — the actionable cause of most spawn failures. */
function logTail(logPath: string, lines = 5): string {
  try {
    const text = readFileSync(logPath, 'utf8')
    const tail = text.split('\n').filter(Boolean).slice(-lines).join('\n')
    return tail.length > 0 ? `log tail (${logPath}):\n${tail}` : `log is empty (${logPath})`
  } catch {
    return `log unreadable (${logPath})`
  }
}

/** `wt-observe start` — resolves the source set (see resolveStartSources), then runs the
 *  bounded decide→act loop (kill-zombie / clear-stale are intermediate actions) against the
 *  ONE server pidfile. */
async function cmdStart(ctx: Ctx, sourceDirs: readonly string[], remotes: readonly RemoteEntry[], flags: StartFlags): Promise<void> {
  for (let round = 0; round < 3; round++) {
    const p = await probeFor(ctx)
    const d = decideStart({ pidfile: p.pf, pidAlive: p.alive, pidIdentityMatches: p.idMatch, health: p.identity })
    if (d.action === 'adopt') {
      // health is non-null whenever identity === 'ours'. Preserve the recorded token:
      // health never carries it (deliberately), so a bare rewrite would WIPE the only
      // out-of-browser copy on every adopt — the common path once a server is up.
      const h = p.health as Health
      // Record the pidfile + report the set the server ACTUALLY serves (from health), NOT the
      // freshly-resolved request — on a drift adopt they differ (codex review): recording the
      // request would write a pidfile-of-record, and print an "adopted for X" line, claiming a
      // set the running server does not serve.
      const served = sourcesFromHealth(h)
      writePidfileAt(ctx.pidfilePath, withCarriedToken(pidfileFromHealth(h), p.pf))
      const label = served.length === 1 ? ` for ${served[0]}` : ''
      const sourcesLine = served.length > 1 ? `sources: ${served.join(', ')}\n` : ''
      process.stdout.write(`observe-ui already running${label} — adopted.\n${sourcesLine}URL: http://127.0.0.1:${h.port}/\n`)
      // Drift: the running server serves a DIFFERENT set than requested. Adopt keeps it AS-IS
      // (applying a new set needs stop+restart) — warn rather than silently imply the request took.
      if (!sameSet(served, sourceDirs)) {
        process.stderr.write(
          `note: the running server serves ${served.join(', ')}, not the requested ${sourceDirs.join(', ')} — \`wt-observe stop\` then \`start\` to apply the new set.\n`,
        )
      }
      // Adopt keeps the running server AS-IS — a --watch request cannot retrofit a watcher.
      if (flags.watch) process.stderr.write('note: --watch ignored (adopted a running server). `wt-observe stop` then `start --watch` to get the watcher.\n')
      // --enable-launch CAN retrofit when EXACTLY 1 source is served (a root-level runtime
      // opt-in exists there, same as before verb-unification). 2+ sources have NO
      // server-wide toggle (launches are per-source, under /s/<key>/api/launch-enable) —
      // declined with a note, same posture the old hub adopt branch already had.
      if (flags.enableLaunch && h.launchEnabled !== true) {
        if (sourceDirs.length > 1) {
          process.stderr.write(
            'note: --enable-launch not retrofitted on an adopted multi-source server (launches are per-source; no server-wide toggle). ' +
              '`wt-observe stop` then `start --enable-launch` to enable at boot.\n',
          )
        } else if (!p.idMatch) {
          process.stderr.write('note: --enable-launch skipped — the running server\'s process identity does not verify against the pidfile; `wt-observe stop` then `start --enable-launch`.\n')
        } else {
          const token = readPidfileAt(ctx.pidfilePath)?.token
          if (token === undefined) {
            process.stderr.write('note: --enable-launch skipped — no token recorded for this server (restart with `wt-observe stop` then `start --enable-launch`).\n')
          } else {
            // Best-effort: the ADOPT already succeeded — a failed retrofit must degrade to
            // a note, never flip the command's exit code to failure.
            try {
              const res = await fetch(`http://127.0.0.1:${h.port}/api/launch-enable`, {
                method: 'POST',
                headers: { 'x-observe-token': token },
                signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
              })
              if (res.ok) process.stdout.write('live launches ENABLED on the adopted server (runtime opt-in).\n')
              else process.stderr.write(`note: --enable-launch failed (HTTP ${res.status}) — enable from the UI or restart with the flag.\n`)
            } catch (e) {
              process.stderr.write(`note: --enable-launch failed (${e instanceof Error ? e.message : String(e)}) — enable from the UI or restart with the flag.\n`)
            }
          }
        }
      }
      return
    }
    if (d.action === 'kill-zombie') {
      process.stderr.write(`wt-observe: owned server (pid ${d.pid}) is wedged — SIGTERM, restarting…\n`)
      try {
        process.kill(d.pid, 'SIGTERM')
      } catch {
        // died in between — fine
      }
      clearPidfileAt(ctx.pidfilePath)
      await new Promise((r) => setTimeout(r, 1000))
      continue
    }
    if (d.action === 'clear-stale') {
      clearPidfileAt(ctx.pidfilePath)
      clearLegacyHubPidfile(ctx.stateRoot) // one-line best-effort — no pre-unification orphan lingers
      continue
    }
    if (d.action === 'retry-health') {
      // The 2s probe timed out on our own alive server — maybe just busy (journal
      // scan, GC). One patient retry; if still silent, REPORT rather than kill:
      // a timeout is never proof of a zombie.
      process.stderr.write('wt-observe: owned server slow to answer — retrying health with a longer timeout…\n')
      const h = await probeHealth(p.port, 10_000)
      if (typeof h === 'object') {
        writePidfileAt(ctx.pidfilePath, withCarriedToken(pidfileFromHealth(h), p.pf))
        process.stdout.write(`observe-ui already running (answered on retry) — adopted.\nURL: http://127.0.0.1:${h.port}/\n`)
        return
      }
      throw new Error(
        `owned server (pid ${p.pf?.pid ?? '?'}) is alive but not answering /api/health on :${p.port} — busy or wedged. ` +
          'Retry shortly, or run `wt-observe stop` then `start` to force-restart it.',
      )
    }
    const port = d.action === 'start-free-port' ? await probeFreePort() : p.port
    const { health: h, token } = await spawnServer(ctx.stateRoot, port, sourceDirs, remotes, flags)
    writePidfileAt(ctx.pidfilePath, { ...pidfileFromHealth(h), token })
    const notes = [flags.watch ? ' with the vite build watcher (--watch)' : '', flags.enableLaunch ? ' with live launches ENABLED (--enable-launch)' : ''].join('')
    const label = sourceDirs.length === 1 ? ` for ${sourceDirs[0]}` : ''
    const sourcesLine = sourceDirs.length > 1 ? `sources: ${sourceDirs.join(', ')}\n` : ''
    process.stdout.write(`observe-ui started${label} (pid ${h.pid})${notes}.\n${sourcesLine}URL: http://127.0.0.1:${h.port}/\n`)
    return
  }
  throw new Error('start did not converge after 3 rounds — check `wt-observe status` and the state dir')
}

async function cmdStop(ctx: Ctx): Promise<void> {
  clearLegacyHubPidfile(ctx.stateRoot) // one-line best-effort — no pre-unification orphan lingers
  const pf = readPidfileAt(ctx.pidfilePath)
  const { alive, idMatch } = pidState(pf)
  const d = decideStop({ pidfile: pf, pidAlive: alive, pidIdentityMatches: idMatch })
  if (d.action === 'noop') {
    process.stdout.write('no observe-ui pidfile — nothing to stop.\n')
    return
  }
  if (d.action === 'kill') {
    try {
      process.kill(d.pid, 'SIGTERM')
      process.stdout.write(`stopped observe-ui (pid ${d.pid}).\n`)
    } catch {
      process.stdout.write(`observe-ui (pid ${d.pid}) was already gone.\n`)
    }
  } else {
    process.stdout.write('stale pidfile (pid dead or recycled) — cleared, nothing signalled.\n')
  }
  clearPidfileAt(ctx.pidfilePath)
  // Card #1812476922312000519 increment B — a DELIBERATE stop revokes every source's
  // live-launch opt-in (never the in-flight launch records themselves: a run this stop just
  // killed is exactly what the next `--enable-launch` start should resume — see
  // launch-enable-state.ts's own header doc).
  clearAllLaunchEnableRecords(ctx.stateRoot)
}

async function cmdStatus(ctx: Ctx): Promise<void> {
  const p = await probeFor(ctx)
  process.stdout.write(`pidfile    : ${ctx.pidfilePath}${p.pf === null ? ' (absent)' : ''}\n`)
  if (p.pf !== null) {
    process.stdout.write(`recorded   : pid ${p.pf.pid} port ${p.pf.port} startedAt ${p.pf.startedAt}\n`)
    process.stdout.write(`pid state  : ${p.alive ? (p.idMatch ? 'alive (identity OK)' : 'alive but RECYCLED (identity mismatch)') : 'dead'}\n`)
    process.stdout.write('recorded sources:\n')
    for (const s of p.pf.sources) process.stdout.write(`  - ${s}\n`)
  }
  if (p.identity === 'ours' && p.health !== null) {
    process.stdout.write(`health :${p.port} → ours — pid ${p.health.pid}, up since ${p.health.startedAt}\n`)
    // Which interpreter drives that server's live launches (S1) — absent on old builds.
    if (p.health.claude !== undefined) {
      const v = p.health.claudeVersion != null ? ` (v${p.health.claudeVersion})` : ''
      process.stdout.write(`claude     : ${p.health.claude ?? 'SDK bundled fallback'}${v}\n`)
    }
    if (p.health.launchEnabled !== undefined) {
      process.stdout.write(`launches   : ${p.health.launchEnabled ? 'ENABLED (live-launch opt-in active)' : 'disabled (start --enable-launch, or the UI Launch opt-in)'}\n`)
    }
    // Straight from the server's OWN live /api/health (the authoritative current source
    // list, not just what the pidfile last recorded at start/adopt time).
    if (Array.isArray(p.health.sources)) {
      process.stdout.write('sources    :\n')
      for (const s of p.health.sources) process.stdout.write(`  - ${s.key}  ${s.configDir}\n`)
    } else if (typeof p.health.configDir === 'string') {
      process.stdout.write(`config dir : ${p.health.configDir}\n`)
    }
    process.stdout.write(`URL        : http://127.0.0.1:${p.health.port}/\n`)
  } else if (p.identity === 'foreign') {
    // Any object payload reaching classifyHealth now classifies 'ours' by construction
    // (see its own doc) — so 'foreign' here always means probeHealth itself concluded
    // not-ours (an old/unrelated build, or a self-reported-port mismatch): there is no
    // health payload to describe.
    process.stdout.write(`health :${p.port} → FOREIGN — no health identity (old build or unrelated process)\n`)
  } else if (p.identity === 'inconclusive') {
    process.stdout.write(`health :${p.port} → INCONCLUSIVE (listener accepted but timed out — busy server?)\n`)
  } else {
    process.stdout.write(`health :${p.port} → unreachable (port free)\n`)
  }
}

// ── launch + await (the launch-and-notify pair) ─────────────────────────────────

/** The owned, healthy server's (port, token) — the precondition of every /api call
 *  the CLI makes. Fails with an actionable message instead of guessing a port.
 *
 *  SECURITY (pr-review round 3, high): these are the only paths where the CLI TRANSMITS
 *  the plaintext token, so the weak self-reported health match ('ours') is not enough —
 *  a local port-squatter can answer /api/health with guessable fields and harvest the
 *  token. Require the SAME proof-of-identity the SIGTERM path already does
 *  (pidIdentityMatches: recorded boot-id + /proc start ticks), which a squatter cannot
 *  satisfy without being the exact process we spawned. On platforms where identity is
 *  unavailable (non-Linux → nulls recorded) this degrades to REFUSING — the safe
 *  direction, consistent with stop's "never signal on a guess". */
async function requireOwnedServer(ctx: Ctx): Promise<{ port: number; token: string; health: Health }> {
  const p = await probeFor(ctx)
  if (p.identity !== 'ours' || p.health === null) {
    throw new Error(`no owned observe-ui server (health on :${p.port} → ${p.identity}). Run \`wt-observe start\` first.`)
  }
  if (!p.idMatch) {
    throw new Error(
      'server answers as ours but its recorded process identity does not verify (stale pidfile, recycled pid, or a platform without /proc identity) — ' +
        'refusing to send the API token. `wt-observe stop` then `start` to re-establish identity.',
    )
  }
  const token = p.pf?.token
  if (token === undefined) {
    throw new Error('owned server found but no token recorded in the pidfile — `wt-observe stop` then `start` to mint one.')
  }
  // Card #1819922556652619607 — the health payload probeFor() already fetched is handed
  // back so resolveSourcePrefix can resolve the common cases (no --source, or --source
  // naming a key/configDir) WITHOUT a second, failure-prone /api/sources round trip.
  return { port: p.health.port, token, health: p.health }
}

async function api(port: number, token: string, path: string, init: RequestInit = {}, timeoutMs = HEALTH_TIMEOUT_MS): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { 'x-observe-token': token, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  })
}

/** Resolve the URL prefix for source-scoped endpoints (/api/launch, /api/runs/*, …).
 *  A MULTI-SOURCE hub mounts every per-source route under /s/<key>/ and answers GET
 *  /api/sources with the mount list; a single-source server has no such route and
 *  serves everything unprefixed — burnt live 2026-07-08: `launch` POSTed the bare
 *  path against a hub and got "unknown hub route" (and `await`'s unprefixed polls
 *  would read every hub run as missing). `wanted` matches a source by key, label,
 *  or configDir (exact or path-suffix); default = the FIRST source, echoed so a
 *  multi-source user sees which one was targeted.
 *
 *  Card #1819922556652619607 — the decision itself now lives in source-resolve.ts's
 *  `resolveSource` (pure, unit-tested): this is just the thin I/O adapter, injecting the
 *  real `/api/sources` fetch and a real `setTimeout` sleep for its bounded retry. The old
 *  version made a ONE-SHOT `/api/sources` fetch and `.catch(() => null)`'d any failure
 *  into "confirmed single-source" — a transient blip was indistinguishable from a real
 *  single-source server, silently routing every subsequent call unprefixed into a hub's
 *  deliberate ambiguity 404. `resolveSource` never latches that from a failure: it
 *  resolves the common cases straight off the already-fetched health payload (zero extra
 *  round trip), and only reaches this fetch for label-only matches — retried, and loud
 *  (`SourceResolutionError`) on exhaustion, never silent. */
async function resolveSourcePrefix(port: number, token: string, health: Health, wanted: string | undefined): Promise<ResolvedSource> {
  return resolveSource(
    health.sources,
    wanted,
    () =>
      api(port, token, '/api/sources', {}, 10_000)
        .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
        .catch(() => null)
        .then((body) => {
          const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['sources'] : undefined
          return Array.isArray(raw) ? (raw as SourcesListEntry[]) : null
        }),
    (ms) => new Promise((r) => setTimeout(r, ms)),
  )
}

interface WorkflowListEntry {
  id: string
  path?: string
}

/** The machine registry + probe results, loaded AT MOST ONCE per launch and shared by
 *  the sidecar path and the observer-requires path (both resolve against the same
 *  registry; probing twice would double-spawn the declared probe processes). Loading is
 *  NON-throwing: an invalid registry yields an EMPTY registry + `registryErrors`, so the
 *  two consumers can diverge — the SIDECAR fails loud on those errors (a role capability
 *  is constitutive), the OBSERVER ignores them and degrades to unresolved (an observer
 *  never fails the launch). */
type CapContext = { registry: CapabilityRegistry; availability: Record<string, boolean>; registryErrors: string[] }

/** webAvailable for capability resolution — an OPERATOR declaration via the
 *  `OBSERVE_WEB_AVAILABLE` env (resolveWebAvailable, default true), NOT a probe: the launcher
 *  runs outside the spawned bare session and cannot observe its actual WebSearch/WebFetch
 *  grant (a server-side property of the target run). The only effect is the docs-lookup
 *  degradation branch (design §4.3): on a machine whose delegated sessions lack web tools,
 *  set `OBSERVE_WEB_AVAILABLE=false` so a docs-lookup that DEGRADES names `degraded:none`
 *  (no phantom WebSearch/WebFetch the session can't use) instead of `degraded:web`. */
const WEB_AVAILABLE = resolveWebAvailable(process.env['OBSERVE_WEB_AVAILABLE'])

/** Detect + resolve a workflow's capability sidecar (card I3, design §3.2/§5/§9),
 *  returning the args to send — AUGMENTED with the resolved `capabilities` section and a
 *  sibling `capabilitiesReport` (the audit trail). The sidecar is located via GET
 *  /api/workflows, whose entries carry the server's OWN resolved absolute `path`
 *  (allowlist-faithful — no root-guessing; wt-observe is loopback so the path is local).
 *
 *  FAILURE POSTURE (design §5.4). A sidecar that is ABSENT or cannot even be LOCATED (an
 *  unknown script id, a transient /api/workflows failure) leaves `args` byte-for-byte
 *  UNCHANGED — a plain launch must never break on capability plumbing. But once a sidecar
 *  is FOUND, every failure from there on (unreadable/invalid JSON, an invalid registry, an
 *  unresolvable required need, a $cap guard violation) is a FAIL-LOUD refusal: the sidecar
 *  declares needs a constitutive role depends on, so launching without them would be a
 *  lying run. */
async function applySidecarCapabilities(input: {
  port: number
  token: string
  prefix: string
  script: string
  args: unknown
  callerCapabilities: CapabilitiesSpec | null
  requesterCwd: string
  loadCapContext: () => Promise<CapContext>
  sourceIsLocal: boolean
}): Promise<unknown> {
  const { port, token, prefix, script, args, callerCapabilities, requesterCwd } = input

  // A sidecar sits beside the workflow on the server's filesystem; reading it only makes
  // sense when that filesystem is THIS host's (review, high). A remote/federated source →
  // no local sidecar detection (the launch is unchanged); v0 boundary, documented at the
  // call site.
  if (!input.sourceIsLocal) return args

  // Locate the resolved workflow path (the server's own allowlist). Any failure here means
  // "cannot locate a sidecar" → proceed unchanged, never breaking a plain launch.
  let workflowPath: string | undefined
  try {
    const list = await api(port, token, `${prefix}/api/workflows`).then(
      (r) => (r.ok ? (r.json() as Promise<WorkflowListEntry[]>) : []),
      () => [] as WorkflowListEntry[],
    )
    const entry = Array.isArray(list) ? list.find((w) => w.id === script) : undefined
    if (entry !== undefined && typeof entry.path === 'string') workflowPath = entry.path
  } catch {
    workflowPath = undefined
  }
  if (workflowPath === undefined) return args

  // Read the sidecar beside the artifact. ENOENT = no sidecar → unchanged. A present but
  // unreadable/invalid sidecar is fail-loud (it exists, so it is meant to be honored).
  const sidecarPath = sidecarPathFor(workflowPath)
  let rawSidecar: string
  try {
    rawSidecar = readFileSync(sidecarPath, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return args
    throw new Error(`capability sidecar ${sidecarPath} is present but unreadable: ${String(e)}`)
  }
  let sidecar: CapabilitySidecar
  try {
    sidecar = JSON.parse(rawSidecar) as CapabilitySidecar
  } catch (e) {
    throw new Error(`capability sidecar ${sidecarPath} is not valid JSON: ${(e as Error).message}`)
  }

  // Load the machine registry + probes (shared, non-throwing). The SIDECAR fails loud on an
  // invalid registry — a role capability is constitutive — then the PURE resolve →
  // $CWD-substitute → project → merge (launch-capabilities.ts).
  const ctx = await input.loadCapContext()
  if (ctx.registryErrors.length > 0) throw new Error(`capability registry invalid:\n  - ${ctx.registryErrors.join('\n  - ')}`)
  const composed = composeLaunchCapabilities({ sidecar, registry: ctx.registry, availability: ctx.availability, webAvailable: WEB_AVAILABLE, requesterCwd, callerCapabilities })
  if (composed.errors.length > 0) {
    throw new Error(`capability sidecar ${sidecarPath} cannot be resolved for launch:\n  - ${composed.errors.join('\n  - ')}`)
  }

  // Augment args with the resolved section + the redacted audit report (foldCapabilitiesIntoArgs
  // — pure, unit-tested; fail-loud on non-object args). The I/O around it (GET /api/workflows,
  // the sidecar read, loadCapContext's probes) is covered end-to-end against the real server.
  const roleCount = isRecord(sidecar) && isRecord(sidecar.roles) ? Object.keys(sidecar.roles).length : 0
  process.stderr.write(`capability sidecar: resolved ${composed.report.length} need(s) across ${roleCount} role(s) from ${sidecarPath}\n`)
  return foldCapabilitiesIntoArgs(args, composed.capabilities, composed.report, script)
}

/** Resolve each inline observer definition's `requires` and embed the resulting
 *  NeedResolution[] on the entry as `resolution` — the launcher-emitted wire contract
 *  (card I3 scope extension) the companion server reads/stores/composes. NEVER fails the
 *  launch: an unresolved required observer need rides through as an UNRESOLVED entry (the
 *  server decides "not attached + noisy record"). A launch with no observers, or none
 *  carrying requires, is returned byte-for-byte UNCHANGED. */
async function applyObserverResolution(input: { args: unknown; requesterCwd: string; loadCapContext: () => Promise<CapContext> }): Promise<unknown> {
  const { args, requesterCwd, loadCapContext } = input
  if (!isRecord(args) || !Array.isArray(args['observers'])) return args
  const observers = args['observers']
  const hasInline = observers.some((e) => inlineObserverRequires(e) !== null)
  const hasDefinitionFile = observers.some((e) => isRecord(e) && typeof e['definitionFile'] === 'string')
  const hasCallerResolution = observers.some((e) => isRecord(e) && 'resolution' in e)
  // Nothing to do only if there is no requires to resolve, no definitionFile to warn about,
  // AND no caller-supplied resolution to strip.
  if (!hasInline && !hasDefinitionFile && !hasCallerResolution) return args

  // Registry presence (for the definitionFile warning), best-effort + NON-throwing. When we
  // actually resolve (inline requires) we reuse the shared context — whose registry is EMPTY
  // on a broken registry file, so an observer degrades to unresolved rather than failing the
  // launch (review, high: a broken registry must not defeat the observer never-fails
  // invariant). With only definitionFile/caller-resolution entries a cheap read suffices.
  let ctx: CapContext | null = null
  let registryPresent = false
  if (hasInline) {
    ctx = await loadCapContext()
    registryPresent = Object.keys(ctx.registry.providers).length > 0
  } else {
    const probe = loadCapabilityRegistry()
    registryPresent = probe.errors.length === 0 && Object.keys(probe.registry.providers).length > 0
  }
  // v0 boundary: a definitionFile's requires are resolved server-side, not launcher-side —
  // warn the author at launch (only when a registry exists) instead of leaving it silent.
  for (const w of observerDefinitionFileWarnings(observers, registryPresent)) process.stderr.write(`${w}\n`)

  // The launcher is the SOLE producer of `resolution` (design §5.3; review, high) — strip
  // caller-supplied ones, set the launcher-resolved one on inline-with-requires. See
  // ownObserverResolutions. The resolve closure carries the loaded registry/availability
  // (ctx is non-null whenever an inline definition has requires, since that sets hasInline).
  const owned = ownObserverResolutions(observers, (requires) =>
    ctx === null ? [] : resolveObserverRequires(requires, ctx.registry, ctx.availability, WEB_AVAILABLE, requesterCwd),
  )
  if (owned.strippedCaller > 0) {
    process.stderr.write(`observer requires: dropped ${owned.strippedCaller} caller-supplied 'resolution' field(s) — the launcher is the sole resolver (a resolution is machine-produced, never a launch input)\n`)
  }
  if (owned.resolved > 0) process.stderr.write(`observer requires: resolved needs for ${owned.resolved} inline observer definition(s)\n`)
  return { ...args, observers: owned.observers }
}

/** `wt-observe launch <workflow.js> [--args <json>] [--source <label|dir>]` — POST
 *  /api/launch (source-prefixed on a hub), print {runId}. The id is the workflow's
 *  filename under the server's allowlisted roots (GET /api/workflows lists them —
 *  echoed here on an unknown id). */
async function cmdLaunch(ctx: Ctx, script: string | undefined, rawArgs: string | undefined, sourceFlag: string | undefined, launchTimeoutMs: number, commRoot: string | undefined): Promise<void> {
  if (script === undefined) throw new Error('usage: ' + SYNOPSIS.launch)
  let args: unknown
  if (rawArgs !== undefined) {
    try {
      args = JSON.parse(rawArgs)
    } catch {
      throw new Error(`--args is not valid JSON: ${rawArgs}`)
    }
  }
  // Per-run capabilities (card #1820698986697196666): an args `capabilities` section
  // ({ mcpServers?, agents?, skills? }) is validated HERE so a malformed section fails
  // fast client-side with every problem listed — the server composes the same section
  // into the delegated run's query() options (see capabilities.ts, the shared contract).
  const cap = extractCapabilities(args)
  if (cap.errors.length > 0) throw new Error(`--args capabilities section invalid:\n  - ${cap.errors.join('\n  - ')}`)
  // Observer definitions (observers-custom design): an args `observers` section is
  // validated HERE so an invalid definition fails fast client-side with every violation
  // listed — authoring/launch is the FAIL-LOUD regime. (Run-time attachment is the
  // never-fail regime: that lives server-side.) The server validates the same section
  // through the same shared module (observer-def.ts) and registers the targets.
  const obs = extractObservers(args)
  if (obs.errors.length > 0) throw new Error(`--args observers section invalid:\n  - ${obs.errors.join('\n  - ')}`)
  if (obs.entries !== null && obs.entries.length > 0) {
    const names = obs.entries.map((e) => ('definition' in e ? e.definition.name : e.definitionFile))
    process.stderr.write(
      `observers section: ${names.join(', ')} — needs a server with observer attachment; older servers ignore it\n`,
    )
  }
  const { port, token, health } = await requireOwnedServer(ctx)
  const { prefix, label, key: resolvedKey } = await resolveSourcePrefix(port, token, health, sourceFlag)
  if (label !== '') process.stderr.write(`launching under source ${label}\n`)
  // Is the resolved source LOCAL to this host? A confirmed single-source server (key null)
  // is local; a hub source is local iff it carries a configDir (remotes report `remote:true`
  // with no path). Sidecar detection reads `<artifact>.capabilities.json` off the server's
  // OWN resolved path — only meaningful when that path is on THIS filesystem (review, high:
  // a remote/federated source's path is the remote's, and could even collide with an
  // unrelated local file). Observer resolution is unaffected (it reads no file — the local
  // machine registry is the correct trust root regardless of the target source).
  const sourceIsLocal = resolvedKey === null || localSourceKeys(health.sources).includes(resolvedKey)
  // requesterCwd (card #1820589984604750931): the requesting process's cwd rides along so
  // the server attributes the delegated run to THIS project's timeline bucket (old servers
  // ignore the unknown field; buildLaunchBody omits a degenerate cwd — see launch-body.ts).
  // safeRequesterCwd degrades LOUDLY on an unresolvable cwd (deleted directory): the field
  // is omitted — never an empty string, never a failed launch — and the operator is told.
  const { cwd: requesterCwd, note: cwdNote } = safeRequesterCwd(() => process.cwd())
  if (cwdNote !== null) process.stderr.write(`${cwdNote}\n`)
  // The machine registry + probes, loaded AT MOST ONCE and shared by the sidecar path and
  // the observer-requires path below (both resolve against the same registry; probing
  // twice would double-spawn the declared probe processes). A plain launch never loads it.
  let capContext: CapContext | null = null
  const loadCapContext = async (): Promise<CapContext> => {
    if (capContext === null) {
      // NON-throwing: an invalid registry yields an empty registry + errors. The sidecar
      // path fails loud on `registryErrors`; the observer path degrades on the empty
      // registry (never fails the launch). Probing an empty registry is a no-op ({}).
      const { registry, errors } = loadCapabilityRegistry()
      capContext = { registry, availability: await probeProviders(registry), registryErrors: errors }
    }
    return capContext
  }
  // Capability sidecar (card I3, design §3.2/§5/§9): a `<artifact>.capabilities.json`
  // beside the resolved workflow declares each role's ABSTRACT needs. The launcher resolves
  // them against the machine registry (WT_CAPABILITY_REGISTRY / XDG default), runs the
  // declared probes, expands the `$cap:<need>` placeholders, and folds the concrete
  // tools/servers + a resolution report into `args` — which the server already composes.
  // Absent/undetectable sidecar → the launch is byte-for-byte UNCHANGED (backward-compat);
  // a PRESENT sidecar whose required needs cannot be resolved → FAIL-LOUD launch refusal
  // (design §5.4 — a role capability is constitutive, not a peripheral observer).
  args = await applySidecarCapabilities({ port, token, prefix, script, args, callerCapabilities: cap.spec, requesterCwd, loadCapContext, sourceIsLocal })
  // Observer requires (card I3 scope extension, wire contract with the companion server):
  // resolve each inline observer definition's abstract `requires` and embed the resulting
  // NeedResolution[] as `resolution` on the entry. NEVER fails the launch — an observer is
  // peripheral, so an unresolved required need rides through and the server decides
  // "not attached + noisy record" (contrast the sidecar's constitutive fail-loud above).
  args = await applyObserverResolution({ args, requesterCwd, loadCapContext })
  // The capabilities note reflects the FINAL (caller + sidecar) section the server composes.
  const finalCap = extractCapabilities(args)
  // Fail-loud parity (review, medium): the re-validation of the MERGED section HONORS its
  // errors — never computes-then-discards them. A composition that produced an invalid
  // section (e.g. an unexpanded $cap: leaking through the resolver) refuses the launch here,
  // client-side, instead of surfacing as a distant server 400.
  if (finalCap.errors.length > 0) throw new Error(`composed capabilities section invalid:\n  - ${finalCap.errors.join('\n  - ')}`)
  if (finalCap.spec !== null) {
    process.stderr.write(
      `capabilities section: ${Object.keys(composeCapabilityOptions(finalCap.spec)).join(', ') || '(empty)'} — needs a server with capabilities composition; older servers ignore it\n`,
    )
  }
  let res: Response
  try {
    res = await api(port, token, `${prefix}/api/launch`, { method: 'POST', body: JSON.stringify(buildLaunchBody(script, args, requesterCwd, commRoot)) }, launchTimeoutMs)
  } catch (err) {
    // A slow server-side SDK session spawn (concurrent load) can exceed the request
    // timeout: the fetch aborts (AbortSignal.timeout → TimeoutError) with the run's start
    // UNKNOWN from here (card #1821667078139020890). Give the honest, actionable message
    // instead of a raw abort. Retrying the SAME script+args is SAFE — the server's launch
    // guard (observatory launch-guard.ts) dedups an overlapping identical launch onto the
    // one run (acquire()/release() spans the whole run), so it never double-launches.
    const name = err instanceof Error ? err.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(
        `launch request timed out after ${Math.round(launchTimeoutMs / 1000)}s — the server did not accept the run in time (likely under concurrent load). ` +
          `From here the run's start is UNKNOWN: it may still be spawning. ` +
          `Retrying the SAME "${script}" with the SAME --args is safe — the server dedups an overlapping identical launch onto the one run (no double-launch). ` +
          `To wait longer, re-run with --launch-timeout-s <N> or set OBSERVE_LAUNCH_TIMEOUT_MS=<ms>. ` +
          `Check \`wt-observe status\` (or the UI) to see whether a run started.`,
      )
    }
    throw err
  }
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const code = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['code'] : undefined
    let hint = ''
    if (res.status === 404) {
      const list = await api(port, token, `${prefix}/api/workflows`).then((r) => r.json() as Promise<WorkflowListEntry[]>, () => [])
      if (list.length > 0) hint = `\navailable: ${list.map((w) => w.id).join(', ')}`
    }
    // 403 is TWO different refusals (pr-review round 3): the launch-disabled gate tags
    // its body with code:'launch-disabled'; a bare 403 is the token check refusing us.
    if (res.status === 403 && code === 'launch-disabled') hint = '\nlive launches are disabled — `wt-observe start --enable-launch` (or the UI Launch opt-in).'
    else if (res.status === 403) hint = '\ntoken rejected — the pidfile token no longer matches the server; `wt-observe stop` then `start` to re-mint.'
    const msg = typeof body === 'object' && body !== null ? String((body as Record<string, unknown>)['error'] ?? res.status) : String(res.status)
    throw new Error(`launch failed: ${msg}${hint}`)
  }
  // One machine-readable line — the runId feeds `wt-observe await` (and the UI attaches
  // to the same registry run automatically).
  process.stdout.write(`${JSON.stringify(body)}\n`)
}

const AWAIT_DEFAULT_TIMEOUT_S = 7_200
const AWAIT_DEFAULT_POLL_S = 3
const AWAIT_MISSING_GRACE_MS = 30_000
// Post-completion settle window: the registry can know `finished` before the completion
// artifact (and thus io.result) lands on disk — bounded retries, COMPLETED runs only
// (a stopped/early-failed run structurally never grows a result; waiting on it would
// burn the whole window every time — pr-review round 3, confirmed medium).
const AWAIT_SETTLE_TRIES = 10
const AWAIT_SETTLE_INTERVAL_MS = 1_000

/** GET /api/runs/:runId as parsed JSON, null on any failure — the recall read both the
 *  main poll loop and the settle window share. `prefix` = hub source mount ('' single-source). */
async function fetchRecall(port: number, token: string, prefix: string, runId: string): Promise<unknown> {
  return api(port, token, `${prefix}/api/runs/${encodeURIComponent(runId)}`, {}, 10_000)
    .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
    .catch(() => null)
}

/** Card #1819922556652619607 requirement 4 — a runId is globally unique across a hub's
 *  LOCAL sources: search every LOCAL source (never remotes — a federated other hub is out
 *  of scope here, no server-side changes in this fix) for a live-registry or recall hit.
 *  Used by `await` ONLY when the run wasn't found under its (default-guessed) active
 *  source, so the common already-correct case never pays this cost. */
async function searchLocalSources(
  port: number,
  token: string,
  keys: readonly string[],
  runId: string,
): Promise<{ found: SourceSearchResult; unprobed: string[] }> {
  const hits: string[] = []
  const unprobed: string[] = []
  await Promise.all(
    keys.map(async (key) => {
      const p = `/s/${key}`
      // Track whether each endpoint was actually REACHED. A timeout/5xx under concurrent
      // load is UNKNOWN, never a confirmed "run not here" — conflating the two is the
      // false-missing this fixes (card #1821784328170899045): the same never-latch
      // discipline source-resolve.ts already applies to resolveSource.
      let liveReached = false
      let inLive = false
      try {
        const r = await api(port, token, `${p}/api/runs/live`)
        if (r.ok) {
          liveReached = true
          const list = (await r.json().catch(() => null)) as { runId: string }[] | null
          inLive = Array.isArray(list) && list.some((e) => e.runId === runId)
        }
      } catch {
        /* unreachable — liveReached stays false */
      }
      if (inLive) {
        hits.push(key)
        return
      }
      // Recall: 200 = the run has a record here (hit); 404 = a CONFIRMED miss; anything
      // else (timeout/5xx) leaves the source unprobed.
      let recallReached = false
      try {
        const r = await api(port, token, `${p}/api/runs/${encodeURIComponent(runId)}`, {}, 10_000)
        if (r.ok) {
          hits.push(key)
          return
        }
        if (r.status === 404) recallReached = true
      } catch {
        /* unreachable — recallReached stays false */
      }
      // Not found here. Only a source whose BOTH endpoints gave a definitive answer is a
      // confirmed miss; if either could not be reached, its status is UNKNOWN (unprobed),
      // so the caller must not read a `none` search as "the run is nowhere".
      if (!(liveReached && recallReached)) unprobed.push(key)
    }),
  )
  return { found: classifySourceSearch(hits), unprobed }
}

/** `wt-observe await <runId>` — block until the run reaches a terminal state, then print
 *  ONE JSON line { runId, status, result } and exit 0 (completed) / 2 (other terminal) /
 *  3 (timeout) / 4 (never seen) / 5 (source resolution failed/ambiguous — see
 *  AWAIT_SOURCE_UNRESOLVED_EXIT_CODE). Designed to be run with run_in_background from an
 *  agent session: the process EXIT is the completion notification (self-nudge), and the
 *  result tail arrives with it — no follow-up fetch needed. Polling (not SSE) on purpose:
 *  the poll is 2 cheap localhost GETs, survives server-side SSE hiccups, and the decision
 *  logic stays pure/unit-tested (observe-await.ts). */
async function cmdAwait(ctx: Ctx, runId: string | undefined, timeoutS: number, pollS: number, sourceFlag: string | undefined): Promise<number> {
  if (runId === undefined) throw new Error('usage: ' + SYNOPSIS.await)
  const { port, token, health } = await requireOwnedServer(ctx)
  let resolved: ResolvedSource
  try {
    resolved = await resolveSourcePrefix(port, token, health, sourceFlag)
  } catch (err) {
    if (err instanceof SourceResolutionError) {
      // Card #1819922556652619607 requirement 3 — a DISTINCT, loud outcome: the run's
      // existence is UNKNOWN (we could not even confirm which source to ask), never
      // conflated with `missing` (which means a resolved, reachable source genuinely
      // never saw this runId).
      process.stdout.write(`${JSON.stringify({ runId, error: 'source-unresolved', message: err.message })}\n`)
      return AWAIT_SOURCE_UNRESOLVED_EXIT_CODE
    }
    throw err
  }
  let prefix = resolved.prefix
  let activeKey = resolved.key
  // Only search when the caller didn't pin a source — an explicit --source is a promise
  // to honor, not a guess to second-guess (non-goal: no behavior change for explicit
  // --source). searchableKeys is [] for a confirmed single-source server too (nothing to
  // disambiguate), so this never adds cost there.
  const searchableKeys = sourceFlag === undefined ? localSourceKeys(health.sources) : []
  let warnedAmbiguous = false
  const startedAt = Date.now()
  for (;;) {
    const live = await api(port, token, `${prefix}/api/runs/live`)
      .then((r) => (r.ok ? (r.json() as Promise<{ runId: string; finished: boolean; status: string | null }[]>) : []))
      .catch(() => [] as { runId: string; finished: boolean; status: string | null }[])
    const entry = live.find((e) => e.runId === runId) ?? null
    let recallStatus: string | null = null
    let recall: unknown = null
    if (entry === null || entry.finished) {
      recall = await fetchRecall(port, token, prefix, runId)
      recallStatus = extractAwaitOutcome(recall).status
    }
    let searchUnprobed: string[] = []
    if (entry === null && recall === null && searchableKeys.length > 1) {
      const search = await searchLocalSources(port, token, searchableKeys, runId)
      searchUnprobed = search.unprobed
      if (search.found.kind === 'unique' && search.found.key !== activeKey) {
        process.stderr.write(`[wt-observe await] "${runId}" found under source "${search.found.key}" (default was "${String(activeKey)}") — switching.\n`)
        activeKey = search.found.key
        prefix = `/s/${search.found.key}`
        continue // re-tick immediately under the corrected prefix, no sleep burned
      }
      if (search.found.kind === 'ambiguous' && !warnedAmbiguous) {
        warnedAmbiguous = true
        process.stderr.write(
          `[wt-observe await] "${runId}" ambiguously found under multiple sources (${search.found.keys.join(', ')}) — refusing to guess, staying on "${String(activeKey)}".\n`,
        )
      }
    }
    const verdict = classifyAwaitTick({
      live: entry === null ? null : { finished: entry.finished, status: entry.status },
      recallStatus,
      elapsedMs: Date.now() - startedAt,
      timeoutMs: timeoutS * 1000,
      missingGraceMs: AWAIT_MISSING_GRACE_MS,
      // A run "visible nowhere" while a local source could not be reached this tick has an
      // UNKNOWN absence — keeps the tick pending instead of a false `missing` (never-latch).
      sourcesUnprobed: searchUnprobed.length > 0,
    })
    if (verdict.kind === 'pending') {
      await new Promise((r) => setTimeout(r, pollS * 1000))
      continue
    }
    if (verdict.kind === 'done') {
      let outcome = extractAwaitOutcome(recall)
      // A status that POSITIVELY says "not completed" (killed/failed/stopped on the
      // artifact) will never grow a result — print immediately instead of burning the
      // window (pr-review round 3). An UNKNOWN/absent status must keep settling: at
      // done-time the completion artifact may simply not have landed yet, and cutting
      // early would drop a genuinely-completed run's verdict tail. Residual accepted:
      // a stopped run that never writes an artifact still waits the full window (the
      // registry doesn't expose which of "not yet" vs "never" applies).
      const resultRuledOut = (s: string | null): boolean => s !== null && s !== 'completed' && s !== 'unknown'
      for (let i = 0; i < AWAIT_SETTLE_TRIES && outcome.result === null && !resultRuledOut(outcome.status); i++) {
        await new Promise((r) => setTimeout(r, AWAIT_SETTLE_INTERVAL_MS))
        recall = await fetchRecall(port, token, prefix, runId)
        outcome = extractAwaitOutcome(recall)
      }
      const status = outcome.status ?? verdict.status
      // Card #1821485224316372412 — a non-completed run carries a failure REASON (recall
      // `error` = journal.error). Relay it as an ADDITIVE stdout field (JSON shape preserved
      // for machines) AND print it on stderr for the human, so `wt-observe await` no longer
      // reports a bare "failed" with the "why" reachable only from the on-disk record —
      // decisive for a boot/input failure that spawns zero agents (no transcript carries it).
      const reasonPart = status !== 'completed' && outcome.error !== null ? { error: truncateAwaitError(outcome.error) } : {}
      process.stdout.write(`${JSON.stringify({ runId, status, result: outcome.result, ...reasonPart })}\n`)
      if ('error' in reasonPart) process.stderr.write(`[wt-observe await] ${runId} ${status}: ${reasonPart.error}\n`)
      return awaitExitCode({ kind: 'done', status })
    }
    // timeout / missing — one machine-readable error line, distinct exit codes. When the
    // multi-source search could not reach some local sources this tick, NAME them: the run
    // may be live under one of them and the verdict is an "unknown", not a confident
    // absence (card #1821784328170899045). Pass --source to target it directly, or retry.
    if (searchUnprobed.length > 0) {
      process.stderr.write(
        `[wt-observe await] ${runId} ${verdict.kind}: could not probe source(s) ${searchUnprobed.join(', ')} — the run may be live under one of them (retry, or pass --source <label|dir>).\n`,
      )
      process.stdout.write(`${JSON.stringify({ runId, error: verdict.kind, unprobedSources: searchUnprobed })}\n`)
    } else {
      process.stdout.write(`${JSON.stringify({ runId, error: verdict.kind })}\n`)
    }
    return awaitExitCode(verdict)
  }
}

// ── resume: the sanctioned explicit recovery of a settled-FAILED run ────────────

/** `wt-observe resume <runId> [--source <label|dir>]` — POST /api/runs/:runId/recover
 *  (source-prefixed on a hub): EXPLICITLY relaunch a settled-FAILED run from its cached
 *  agent work (card #1819953357465323377's incident: a dev-plan run died at its last step
 *  with 39 agents / 92 minutes of cached work intact, and no sanctioned recovery path).
 *  DISTINCT from the server's own pause-transport `/api/runs/:id/resume` (this verb never
 *  touches that — see the server's app.ts for why the HTTP route is named /recover). Opt-in,
 *  per-runId, never a sweep — an operator decides to recover ONE dead run at a time; the
 *  server enforces its own anti-loop budget (max 2 explicit attempts) independently of this
 *  CLI. Prints ONE JSON line and exits per recoverExitCodeFor (observe-resume.ts) / 5 on a
 *  source-resolution failure (AWAIT_SOURCE_UNRESOLVED_EXIT_CODE, same as `await`). */
async function cmdResume(ctx: Ctx, runId: string | undefined, sourceFlag: string | undefined): Promise<number> {
  if (runId === undefined) throw new Error('usage: ' + SYNOPSIS.resume)
  const { port, token, health } = await requireOwnedServer(ctx)
  let resolved: ResolvedSource
  try {
    resolved = await resolveSourcePrefix(port, token, health, sourceFlag)
  } catch (err) {
    if (err instanceof SourceResolutionError) {
      // Same DISTINCT-from-"not found" outcome await's own source resolution carries (see
      // its own doc) — the run's existence is UNKNOWN, never conflated with a genuine
      // "no journal for this runId" (RECOVER_NOT_FOUND_EXIT_CODE below).
      process.stdout.write(`${JSON.stringify({ runId, error: 'source-unresolved', message: err.message })}\n`)
      return AWAIT_SOURCE_UNRESOLVED_EXIT_CODE
    }
    throw err
  }
  if (resolved.label !== '') process.stderr.write(`recovering under source ${resolved.label}\n`)
  // 30s, same budget as cmdLaunch's own POST /api/launch call — the endpoint resolves as
  // soon as the launch tool_result yields a runId (well before the recovered run itself
  // completes), never waiting out the whole workflow.
  const res = await api(port, token, `${resolved.prefix}/api/runs/${encodeURIComponent(runId)}/recover`, { method: 'POST' }, 30_000)
  const body: unknown = await res.json().catch(() => null)
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const code = typeof record['code'] === 'string' ? record['code'] : undefined
  if (res.ok) {
    process.stdout.write(`${JSON.stringify(body)}\n`)
  } else {
    const errorMsg = typeof record['error'] === 'string' ? record['error'] : `http ${res.status}`
    process.stdout.write(`${JSON.stringify({ runId, error: errorMsg, ...(code !== undefined ? { code } : {}) })}\n`)
  }
  return recoverExitCodeFor(res.status, res.ok, code)
}

// ── config verb: manage the persistent source list ──────────────────────────────

/** `wt-observe config show` — the config-file path, its current sources, and what
 *  auto-discovery currently finds (so the user sees both, and understands precedence:
 *  a non-empty configured list wins over discovery outright for `start`). */
async function cmdConfigShow(): Promise<void> {
  const configRoot = observeConfigRoot(process.env, homedir(), process.platform)
  const configPath = join(configRoot, 'config.json')
  const { sources, remotes } = readObserveConfig(configRoot)
  // discoverConfigDirCandidates is deliberately RAW/undeduped (dedup is resolveHubSources'
  // job) — e.g. an explicit $CLAUDE_CONFIG_DIR that also matches the glob shows up twice.
  // Canonicalize + dedupe here purely for a clean user-facing list (mirrors what `start`
  // would actually resolve to, without changing the shared discovery function's contract).
  const discovered = [...new Set(discoverConfigDirCandidates(process.env, homedir()).map(resolveDir))]
  process.stdout.write(`config file : ${configPath}\n`)
  process.stdout.write(`configured  : ${sources.length > 0 ? sources.join(', ') : '(none — start falls through to auto-discovery)'}\n`)
  process.stdout.write(`discovered  : ${discovered.length > 0 ? discovered.join(', ') : '(none found)'}\n`)
  process.stdout.write(`remotes     : ${remotes.length > 0 ? remotes.map(describeRemote).join(', ') : '(none configured)'}\n`)
  if (sources.length > 0) {
    process.stdout.write('note        : a non-empty configured list WINS over discovery outright for `start` — the discovered list above is informational only.\n')
  }
}

/** `wt-observe config add-source <dir>` — validates the dir exists (hard error on a typo),
 *  appends it to the persistent list if not already present (canonical dedupe), writes back. */
async function cmdConfigAddSource(dirRaw: string): Promise<void> {
  const dir = resolveDir(dirRaw)
  if (!existsSync(dir)) throw new Error(`config add-source ${dirRaw}: directory does not exist (resolved to ${dir})`)
  const configRoot = observeConfigRoot(process.env, homedir(), process.platform)
  const config = readObserveConfig(configRoot)
  const already = config.sources.some((s) => resolveDir(s) === dir)
  const next = already ? config.sources : [...config.sources, dir]
  writeObserveConfig(configRoot, { ...config, sources: next })
  process.stdout.write(`sources: ${next.join(', ')}\n`)
}

/** `wt-observe config remove-source <dir>` — removes a matching (canonical) entry, writes
 *  back. Removing an absent entry is a no-op (still prints the resulting list). */
async function cmdConfigRemoveSource(dirRaw: string): Promise<void> {
  const dir = resolveDir(dirRaw)
  const configRoot = observeConfigRoot(process.env, homedir(), process.platform)
  const config = readObserveConfig(configRoot)
  const next = config.sources.filter((s) => resolveDir(s) !== dir)
  writeObserveConfig(configRoot, { ...config, sources: next })
  process.stdout.write(`sources: ${next.length > 0 ? next.join(', ') : '(none configured)'}\n`)
}

/** One-line human description of a remote entry (config show / add/remove output). */
function describeRemote(remote: RemoteEntry): string {
  const label = remote.label !== undefined ? ` (${remote.label})` : ''
  const cred = remote.token !== undefined ? ' [token]' : remote.tokenFile !== undefined ? ` [token-file: ${remote.tokenFile}]` : ''
  return `${remote.url}${label}${cred}`
}

/** `wt-observe config add-remote <url> [--token|--token-file|--label]` — canonicalizes the
 *  URL (hard error on a non-http(s)/unparseable one), then ADDS OR REPLACES the entry with
 *  the same canonical URL (an add-remote with new credentials is how you rotate them). */
async function cmdConfigAddRemote(remote: { url: string; token?: string; tokenFile?: string; label?: string }): Promise<void> {
  const url = normalizeRemoteUrl(remote.url)
  if (url === null) throw new Error(`config add-remote ${remote.url}: not a usable http(s) URL`)
  const configRoot = observeConfigRoot(process.env, homedir(), process.platform)
  const config = readObserveConfig(configRoot)
  // --token puts the remote credential in argv (visible via `ps` / `/proc/<pid>/cmdline` and
  // shell history on a shared machine). The rest of federation is careful with secrets (0600
  // files, per-request lazy tokenFile reads, the proxy stripping the hub token) — steer to
  // --token-file, which the pairing pidfile form also makes restart-durable.
  if (remote.token !== undefined) {
    process.stderr.write(
      `[wt-observe] warning: --token exposes the remote credential in argv (ps / shell history on a shared host). Prefer --token-file pointing at the remote's server.json — see docs/public/observe-federation.md.\n`,
    )
  }
  const entry: RemoteEntry = { url }
  if (remote.token !== undefined) entry.token = remote.token
  if (remote.tokenFile !== undefined) entry.tokenFile = remote.tokenFile
  if (remote.label !== undefined) entry.label = remote.label
  const wasNoRemotes = config.remotes.length === 0
  const kept = config.remotes.filter((r) => normalizeRemoteUrl(r.url) !== url)
  const next = [...kept, entry]
  writeObserveConfig(configRoot, { ...config, remotes: next })
  process.stdout.write(`remotes: ${next.map(describeRemote).join(', ')}\n`)
  // The first remote flips a single-source server into HUB mode: bare /api/* routes move
  // under /s/<key>/api/*. The bundled `wt-observe launch|await` resolve the prefix
  // automatically; direct /api/* callers (scripts, bookmarks) must add it.
  if (wasNoRemotes) {
    process.stderr.write(
      `[wt-observe] note: with a remote configured the server runs in HUB mode — bare /api/* routes are now served under /s/<key>/api/*. wt-observe launch|await handle this; direct /api/* scripts must add the source prefix.\n`,
    )
  }
}

/** `wt-observe config remove-remote <url>` — removes the canonical match; removing an
 *  absent entry is a no-op (still prints the resulting list), same as remove-source. */
async function cmdConfigRemoveRemote(urlRaw: string): Promise<void> {
  const url = normalizeRemoteUrl(urlRaw)
  if (url === null) throw new Error(`config remove-remote ${urlRaw}: not a usable http(s) URL`)
  const configRoot = observeConfigRoot(process.env, homedir(), process.platform)
  const config = readObserveConfig(configRoot)
  const next = config.remotes.filter((r) => normalizeRemoteUrl(r.url) !== url)
  writeObserveConfig(configRoot, { ...config, remotes: next })
  process.stdout.write(`remotes: ${next.length > 0 ? next.map(describeRemote).join(', ') : '(none configured)'}\n`)
}

/** The value following `--<name>` in argv, undefined when absent. */
function flagValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

/** EVERY value following a `--<name>` occurrence, in order — unlike flagValue (first only),
 *  needed for `--source <dir>`, which repeats. */
function flagValues(argv: readonly string[], name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] !== undefined) out.push(argv[i + 1]!)
  }
  return out
}

/** Impure scan: every workflow run recorded on disk under the given config dirs, as
 *  PruneRunRecords. A run's completion record is `<cfg>/projects/<slug>/<session>/workflows/
 *  <runId>.json` (what the timeline lists); its NAME comes from the sibling script
 *  `.../workflows/scripts/<name>-<runId>.js`, whose project slug can DIFFER from the json's
 *  (run-attach.ts) — so scripts are mapped per config dir across ALL slugs first. Tolerant
 *  throughout: a vanished/unreadable dir is skipped, never thrown.
 *
 *  LIVE-RUN SAFETY (load-bearing): a record is emitted ONLY when the completion `<runId>.json`
 *  exists — and the harness writes that json ONLY at run completion, never mid-run (see the
 *  workflow-harness-disk-layout ground truth). So an in-flight run (script + a growing sidecar,
 *  no json yet) is INVISIBLE to prune and can never be deleted while running. If a future harness
 *  ever wrote a provisional json mid-run, this invariant — and prune's live-safety — would break;
 *  observe-prune-scan.test.ts pins the no-json → no-record contract. Note the sidecar is ALWAYS
 *  co-located with the JSON's session (siblings under one sessionDir); only the SCRIPT can live
 *  under a different slug, which the pass-1 map resolves. */
export function scanRunsForPrune(configDirs: readonly string[]): PruneRunRecord[] {
  const subdirs = (p: string): string[] => {
    try {
      return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      return []
    }
  }
  const filesIn = (p: string): string[] => {
    try {
      return readdirSync(p, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
    } catch {
      return []
    }
  }
  const RUNID_IN_SCRIPT = /-(wf_[A-Za-z0-9_-]+)\.js$/
  const RUN_JSON = /^(wf_[A-Za-z0-9_-]+)\.json$/
  const records: PruneRunRecord[] = []
  const seen = new Set<string>() // config-dir globs can overlap → dedupe by json path
  for (const configDir of new Set(configDirs)) {
    const projectsDir = join(configDir, 'projects')
    // pass 1: runId -> {name, scriptPath} across every slug/session in this config dir
    const scriptByRun = new Map<string, { name: string | null; scriptPath: string }>()
    for (const slug of subdirs(projectsDir)) {
      for (const session of subdirs(join(projectsDir, slug))) {
        const scriptsDir = join(projectsDir, slug, session, 'workflows', 'scripts')
        for (const f of filesIn(scriptsDir)) {
          const m = RUNID_IN_SCRIPT.exec(f)
          if (m) scriptByRun.set(m[1]!, { name: runNameFromScript(f, m[1]!), scriptPath: join(scriptsDir, f) })
        }
      }
    }
    // pass 2: the completion records the timeline lists
    for (const slug of subdirs(projectsDir)) {
      for (const session of subdirs(join(projectsDir, slug))) {
        const wfDir = join(projectsDir, slug, session, 'workflows')
        for (const f of filesIn(wfDir)) {
          const m = RUN_JSON.exec(f)
          if (!m) continue
          const runId = m[1]!
          const jsonPath = join(wfDir, f)
          if (seen.has(jsonPath)) continue
          seen.add(jsonPath)
          let mtimeMs: number
          try {
            mtimeMs = statSync(jsonPath).mtimeMs
          } catch {
            continue // vanished between readdir and stat
          }
          const sc = scriptByRun.get(runId)
          records.push({
            runId,
            name: sc?.name ?? null,
            mtimeMs,
            jsonPath,
            scriptPath: sc?.scriptPath ?? null,
            sidecarDir: join(projectsDir, slug, session, 'subagents', 'workflows', runId),
          })
        }
      }
    }
  }
  return records
}

/** `wt-observe prune` — delete test/probe workflow run records so they stop lingering in the
 *  observe "recent runs". Dry-run by DEFAULT (lists matches); pass `--yes` to actually delete.
 *  Selection (see observe-prune.selectRuns): `--run <id>` exact; else `--name-prefix <p>`
 *  (repeatable; defaults to the reserved test prefixes) AND optional `--older-than <dur>`. */
async function cmdPrune(argv: readonly string[]): Promise<number> {
  const runId = flagValue(argv, 'run')
  const explicitPrefixes = flagValues(argv, 'name-prefix')
  const olderThanRaw = flagValue(argv, 'older-than')
  const execute = argv.includes('--yes') || argv.includes('--force')

  let olderThanMs: number | null = null
  if (olderThanRaw !== undefined) {
    olderThanMs = parseDurationMs(olderThanRaw)
    if (olderThanMs === null) {
      process.stderr.write(`prune: invalid --older-than '${olderThanRaw}' (use e.g. 45s, 30m, 2h, 7d)\n`)
      return 2
    }
  }

  const configDirs = [...new Set(discoverConfigDirCandidates(process.env, homedir()).map(resolveDir))]
  const records = scanRunsForPrune(configDirs)
  const selected = selectRuns(records, {
    runId: runId ?? null,
    namePrefixes: explicitPrefixes.length > 0 ? explicitPrefixes : null,
    olderThanMs,
    nowMs: Date.now(),
  })

  const scope = runId
    ? `run ${runId}`
    : `name-prefix [${(explicitPrefixes.length > 0 ? explicitPrefixes : DEFAULT_TEST_PREFIXES).join(', ')}]` +
      (olderThanMs !== null ? ` older than ${olderThanRaw}` : '')
  if (selected.length === 0) {
    process.stdout.write(`prune: no runs match (${scope}) across ${configDirs.length} config dir(s).\n`)
    return 0
  }

  const verb = execute ? 'Deleting' : 'Would delete (dry-run — pass --yes to apply)'
  process.stdout.write(`${verb} ${selected.length} run(s) — ${scope}:\n`)
  for (const r of selected) {
    process.stdout.write(`  ${r.runId}  ${r.name ?? '(no name)'}\n`)
    if (execute) for (const p of pathsToDelete(r)) rmSync(p, { recursive: true, force: true })
  }
  if (!execute) process.stdout.write('(nothing deleted — re-run with --yes)\n')
  return 0
}

// ── entry ───────────────────────────────────────────────────────────────────────

// ── usage / help ─────────────────────────────────────────────────────────────
// ONE source of truth for every verb's synopsis: the per-verb missing-arg throws,
// the top-level dispatch fallback, and the `--help` / `<verb> --help` handler all
// read from here, so the synopsis a user is shown can never drift between them.
const SYNOPSIS = {
  start: 'wt-observe start [--source <dir>]... [--watch] [--enable-launch]',
  stop: 'wt-observe stop',
  status: 'wt-observe status',
  prune: 'wt-observe prune [--run <id> | --name-prefix <p>]... [--older-than <dur>] [--yes]',
  launch: 'wt-observe launch <workflow.js> [--args <json>] [--source <label|dir>] [--launch-timeout-s <N>] [--comm-root <dir>]',
  await: 'wt-observe await <runId> [--timeout-s N] [--poll-s N] [--source <label|dir>]',
  resume: 'wt-observe resume <runId> [--source <label|dir>]',
  config:
    'wt-observe config [show | add-source <dir> | remove-source <dir> | ' +
    'add-remote <url> [--token <t> | --token-file <p>] [--label <l>] | remove-remote <url>]',
} as const
type Verb = keyof typeof SYNOPSIS

// Extended per-verb help, printed under the synopsis by `<verb> --help` only (the
// terse missing-arg throw stays a single line). launch documents the capability
// wiring the one-line synopsis cannot carry: the auto-detected sidecar + registry.
const HELP_DETAIL: Partial<Record<Verb, string>> = {
  launch:
    "  <workflow.js> is resolved by NAME against the server's OBSERVE_WORKFLOWS_DIR\n" +
    '  (a registered artifact name, not an arbitrary path).\n' +
    '  Capabilities: an adjacent <workflow>.capabilities.json sidecar is auto-detected\n' +
    '  and its declared needs are resolved against the machine capability registry\n' +
    '  (WT_CAPABILITY_REGISTRY, else the XDG default). --args may carry a capabilities\n' +
    '  or observers section that composes over the sidecar resolution.\n' +
    '  --comm-root <dir> sets the wt-comm ROOT for a hint-emitting observer (the server\n' +
    '  appends the runId and validates the root against its OBSERVE_COMM_ALLOWED_ROOTS);\n' +
    '  absent = wt-comm hint delivery is not enabled.',
}

/** Usage text. No verb → the global multi-verb synopsis; a known verb → that verb's
 *  synopsis plus any extended detail. The caller picks the stream + exit code
 *  (stdout/0 for --help, stderr/2 for an unknown command). */
function usageText(verb?: Verb): string {
  if (verb) {
    const detail = HELP_DETAIL[verb]
    return `usage: ${SYNOPSIS[verb]}\n` + (detail ? `${detail}\n` : '')
  }
  const verbs = (Object.keys(SYNOPSIS) as Verb[]).map((v) => `  ${SYNOPSIS[v]}`).join('\n')
  return (
    'usage: wt-observe <command> [options]\n\n' +
    `Commands:\n${verbs}\n\n` +
    'Run `wt-observe <command> --help` for command-specific help.\n'
  )
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const cmd = argv[0] ?? 'status'
  // `--help` / `-h`: global when it leads, per-verb when it follows a known verb.
  // Detected as FLAGS (matched on argv, not as a dispatched verb) so they resolve
  // BEFORE dispatch — `launch --help` must print usage, never attempt a launch — and
  // so they do not register as pseudo-verbs in the docs-contract verb gate.
  if (argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(usageText())
    return 0
  }
  if ((argv.includes('--help') || argv.includes('-h')) && cmd in SYNOPSIS) {
    process.stdout.write(usageText(cmd as Verb))
    return 0
  }
  const ctx = makeCtx()
  try {
    if (cmd === 'start') {
      const sourceDirs = resolveStartSources(flagValues(argv, 'source'))
      const remotes = resolveStartRemotes()
      await cmdStart(ctx, sourceDirs, remotes, { watch: argv.includes('--watch'), enableLaunch: argv.includes('--enable-launch') })
    } else if (cmd === 'stop') await cmdStop(ctx)
    else if (cmd === 'status') await cmdStatus(ctx)
    else if (cmd === 'prune') return await cmdPrune(argv)
    else if (cmd === 'launch')
      await cmdLaunch(
        ctx,
        argv[1],
        flagValue(argv, 'args'),
        flagValue(argv, 'source'),
        resolveLaunchTimeoutMs(flagValue(argv, 'launch-timeout-s'), process.env['OBSERVE_LAUNCH_TIMEOUT_MS']),
        flagValue(argv, 'comm-root'),
      )
    else if (cmd === 'await') {
      const timeoutS = Number(flagValue(argv, 'timeout-s') ?? AWAIT_DEFAULT_TIMEOUT_S) || AWAIT_DEFAULT_TIMEOUT_S
      const pollS = Number(flagValue(argv, 'poll-s') ?? AWAIT_DEFAULT_POLL_S) || AWAIT_DEFAULT_POLL_S
      return await cmdAwait(ctx, argv[1], timeoutS, pollS, flagValue(argv, 'source'))
    } else if (cmd === 'resume') {
      return await cmdResume(ctx, argv[1], flagValue(argv, 'source'))
    } else if (cmd === 'config') {
      const parsed = parseConfigAction(argv.slice(1))
      if (parsed.action === 'invalid') {
        process.stderr.write(`${parsed.message}\n`)
        return 2
      }
      if (parsed.action === 'show') await cmdConfigShow()
      else if (parsed.action === 'add-source') await cmdConfigAddSource(parsed.dir)
      else if (parsed.action === 'remove-source') await cmdConfigRemoveSource(parsed.dir)
      else if (parsed.action === 'add-remote') await cmdConfigAddRemote(parsed)
      else await cmdConfigRemoveRemote(parsed.url)
    } else {
      process.stderr.write(usageText())
      return 2
    }
    return 0
  } catch (err) {
    process.stderr.write(`wt-observe ${cmd}: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

// Realpath-compare the entry guard (bin symlinks NO-OP a naive === — see
// bin-symlink-entry-guard): run main() only when executed directly.
const argv1 = process.argv[1]
if (argv1 !== undefined) {
  let same = false
  try {
    const { realpathSync } = await import('node:fs')
    same = import.meta.url === pathToFileURL(realpathSync(argv1)).href
  } catch {
    same = import.meta.url === pathToFileURL(argv1).href
  }
  if (same) {
    process.exitCode = await main()
  }
}
