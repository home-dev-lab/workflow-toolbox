import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import os from 'node:os'
// POSIX paths, not the host's native ones: every path here names a location inside a Linux bwrap
// sandbox or on the Linux host that builds it. The plan is never built elsewhere (see
// sandboxAvailability), and on a Windows host `node:path` would rewrite `/home/x` into `\\home\\x`.
import { posix as path } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJsonc } from './jsonc.mjs'
import { processStartTime } from './pid-namespace.mjs'

// External lanes (opencode, codex) run as the owner with a shell. The environment allow-list keeps
// secrets out of their ENVIRONMENT; this sandbox keeps them out of their FILESYSTEM, process table
// and NETWORK. It is built from an allow-list of binds on an empty root, never by masking secret
// paths on top of the whole filesystem: a path nobody named is absent by construction. The lane
// runs in its own network namespace (--unshare-net) with two routes out, both chosen by its MODEL: a
// loopback provider endpoint through a socat relay over a unix socket, and a remote provider's own
// hostnames through a host-side HTTPS CONNECT proxy (lane-egress-proxy.mjs) that checks the CONNECT
// host against an exact allow-list and the TLS SNI against the CONNECT host. No other host loopback
// service is reachable, and no other internet NAME can be tunnelled. Not covered, by design: HTTP
// Host-header fronting inside the encrypted stream to another site on the same CDN, and the allowed
// provider account itself, which is a place a lane can send data. The allow-list is derived only
// from configuration the lane cannot write (see opencodeModelNetwork).

const LANE_SANDBOX_READ_ENV = 'WT_LANE_SANDBOX_READ'
const LANE_SANDBOX_WRITE_ENV = 'WT_LANE_SANDBOX_WRITE'
// `off` runs lanes unsandboxed, and every such launch still says so in one line.
const LANE_SANDBOX_SWITCH_ENV = 'WT_LANE_SANDBOX'
// Optional host path where the egress proxy appends one JSON line per request (host, decision). The
// lane never sees it: it is written by the host-side proxy, outside the sandbox.
const LANE_EGRESS_LOG_ENV = 'WT_LANE_EGRESS_LOG'
const EGRESS_PROXY = fileURLToPath(new URL('./lane-egress-proxy.mjs', import.meta.url))
const EGRESS_PROXY_PORT = 3128
// A built-in provider's own hosts, by credential kind. Measured 2026-09-26 through the proxy with an
// empty allow-list: an `openai/*` OpenCode lane on OAuth contacts chatgpt.com only; the token refresh
// goes to auth.openai.com (the OAuth token URL compiled into OpenCode 1.18.32); an API key goes to
// api.openai.com.
const PROVIDER_EGRESS = {
  openai: { oauth: ['chatgpt.com', 'auth.openai.com'], api: ['api.openai.com'] },
}
// OpenCode's global home: without its installed plugin packages OpenCode (not --pure) tries an
// `npm install @opencode-ai/plugin` there on every start. They are bound READ-ONLY: never the whole
// directory (it also holds an old session database), never writable.
const OPENCODE_HOME_READ_ONLY = ['node_modules', 'package.json', 'package-lock.json']

// /sys is deliberately NOT bound: it would expose host PIDs via cgroup.procs (LOW 5). The lanes do
// not need it. /proc is a fresh --unshare-pid proc, so it shows only the sandbox's own processes.
const SYSTEM_READ_ONLY = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/etc', '/nix/store']
// /etc entries that are commonly symlinks into /run or /mnt (WSL writes resolv.conf under /mnt/wsl).
const ETC_LINK_TARGETS = ['/etc/resolv.conf', '/etc/hosts', '/etc/ssl/certs/ca-certificates.crt']
// In OpenCode's own load order (measured, OpenCode 1.18.32 debug log): a later file overrides an earlier one.
const OPENCODE_GLOBAL_CONFIGS = ['config.json', 'opencode.json', 'opencode.jsonc']
const FILE_REFERENCE = /\{file:([^}]+)\}/g
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
const probeCache = new Map()

export class LaneSandboxRefusal extends Error {}

const realFs = {
  exists: (file) => existsSync(file),
  realpath: (file) => { try { return realpathSync(file) } catch { return null } },
  isFile: (file) => { try { return statSync(file).isFile() } catch { return false } },
  isDir: (file) => { try { return statSync(file).isDirectory() } catch { return false } },
  readText: (file) => { try { return readFileSync(file, 'utf8') } catch { return null } },
  ensureDir: (directory) => { try { mkdirSync(directory, { recursive: true, mode: 0o700 }) } catch { /* bind-try then leaves it private */ } },
  ensureFile: (file) => { try { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600 }) } catch { /* overlay is skipped if the source is absent */ } },
  copy: (from, to) => { try { mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 }); copyFileSync(from, to) } catch { /* a missing source leaves no copy; the ro overlay is then skipped */ } },
  writeText: (file, text) => { try { writeFileSync(file, text, { mode: 0o600 }) } catch { /* best effort writeback */ } },
}

function probeBwrap(bwrap) {
  if (!probeCache.has(bwrap)) {
    const result = spawnSync(bwrap, ['--ro-bind', '/', '/', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--', 'true'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'ignore', 'pipe'] })
    if (result.status === 0) { probeCache.set(bwrap, { ok: true }); return probeCache.get(bwrap) }
    // A present-but-failing bwrap is NOT cached: a transient failure (load, namespace exhaustion)
    // must not turn every later launch in this process into an unsandboxed run (M3).
    const detail = result.error?.message ?? String(result.stderr ?? '').trim().split(/\r?\n/)[0]
    const cause = detail || `exit ${String(result.status)}`
    return { ok: false, reason: `${bwrap} cannot create a sandbox here (${cause})` }
  }
  return probeCache.get(bwrap)
}

function findOnPath(name, searchPath, fs) {
  for (const directory of String(searchPath ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue
    const candidate = path.join(directory, name)
    if (fs.isFile(candidate)) return candidate
  }
  return null
}

const home = (env) => env.HOME || '/nonexistent'
const xdg = (env, name, fallback) => (path.isAbsolute(env[name] ?? '') ? env[name] : path.join(home(env), fallback))
const absolute = (value) => (path.isAbsolute(value ?? '') ? [value] : [])

function executableBinds(invoked, fs) {
  if (!invoked || !path.isAbsolute(invoked)) return []
  const real = fs.realpath(invoked) ?? invoked
  return [...new Set([path.dirname(real), invoked])]
}

// Values of the named flags, resolved to absolute against `base` (the working directory). A relative
// --dir or -f must be bound, not dropped (LOW 8): opencode resolves them against its cwd, so we do too.
function argumentValues(args, flags, base) {
  return args.flatMap((value, index) => {
    if (!flags.includes(args[index - 1])) return []
    const raw = String(value)
    if (path.isAbsolute(raw)) return [raw]
    return base ? [path.resolve(base, raw)] : []
  })
}

// The filesystem root, the home directory, and every ancestor of home would re-expose what the
// sandbox exists to hide. Symlinks are resolved so a link to $HOME cannot slip past (LOW 4). This
// is applied to EVERY computed bind, not only the operator extras (H2).
function isForbiddenPath(candidate, env, fs) {
  if (!candidate || !path.isAbsolute(candidate)) return true
  const target = fs.realpath(candidate) ?? path.resolve(candidate)
  const homeDir = fs.realpath(home(env)) ?? path.resolve(home(env))
  if (target === path.parse(target).root) return true
  return homeDir === target || homeDir.startsWith(`${target}${path.sep}`)
}

// The global OpenCode config names the files it substitutes with {file:...} (API keys among them).
// Only the GLOBAL config is followed: it is read-only inside the sandbox, so a lane cannot append a
// reference that the next launch would honour. Project configs live in the writable worktree.
function opencodeConfigReferences(configDir, env, fs) {
  const references = []
  for (const name of OPENCODE_GLOBAL_CONFIGS) {
    const text = fs.readText(path.join(configDir, name))
    for (const match of text?.matchAll(FILE_REFERENCE) ?? []) {
      const raw = match[1].trim()
      const expanded = raw.startsWith('~/') ? path.join(home(env), raw.slice(2)) : path.resolve(configDir, raw)
      if (fs.exists(expanded)) references.push(expanded)
    }
  }
  return references
}

const readJson = (file, fs) => parseJsonc(fs.readText(file))

// The provider hosts a credential kind needs; an unknown provider gets none (stated in the line).
function builtInProviderHosts(provider, kinds) {
  const table = PROVIDER_EGRESS[provider]
  return table ? [...new Set(kinds.flatMap((kind) => table[kind] ?? []))] : []
}

// The last defined value along the load order wins, as in OpenCode's own merge.
const lastDefined = (configs, read) => configs.map(read).filter((value) => typeof value === 'string').at(-1)

function endpointsFromBaseURL(provider, baseURL) {
  try {
    const url = new URL(baseURL)
    if (LOOPBACK_HOSTS.has(url.hostname)) return { provider, endpoints: [{ host: url.hostname === 'localhost' ? '127.0.0.1' : url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) }], hosts: [] }
    return { provider, endpoints: [], hosts: url.protocol === 'https:' ? [url.hostname.toLowerCase()] : [] }
  } catch { return { provider, endpoints: [], hosts: [] } }
}

// A lane's network needs, from ITS model only (`provider/model`): a configured baseURL on loopback
// becomes a relayed endpoint, a remote baseURL becomes that one host, and a built-in provider gets
// its own hosts for the credential kind the OpenCode auth store holds. No model → no network.
//
// OpenCode's documented precedence (opencode.ai/docs/config, "Precedence order"): remote config,
// then the global config, then OPENCODE_CONFIG, then the project config, then `.opencode`
// directories, then OPENCODE_CONFIG_CONTENT, later sources overriding earlier ones key by key. In
// the global directory OpenCode 1.18.32 loads config.json, opencode.json, opencode.jsonc in that
// order (measured, its own debug log). Only sources the lane CANNOT write feed the allow-list: the
// global files (bound read-only) and OPENCODE_CONFIG when it lies outside every writable bind. The
// project config and `.opencode` live in the writable worktree, so trusting them would let one lane
// widen the next lane's egress; OpenCode may still honour them, and a host they name is then
// refused by the proxy (fail closed). OPENCODE_CONFIG_CONTENT never reaches a lane (the environment
// allow-list strips OPENCODE_CONFIG_*). A file that exists but does not parse is named in the
// launch line: it can only make the allow-list SMALLER, never larger.
function opencodeModelNetwork({ configDir, model, authFile, configFile, fs }) {
  const files = [...OPENCODE_GLOBAL_CONFIGS.map((name) => path.join(configDir, name)), ...(configFile ? [configFile] : [])]
  const unreadable = files.filter((file) => fs.readText(file) !== null && readJson(file, fs) === null)
  const configs = files.map((file) => readJson(file, fs)).filter(Boolean)
  const chosen = model || lastDefined(configs, (config) => config.model)
  const provider = typeof chosen === 'string' && chosen.includes('/') ? chosen.slice(0, chosen.indexOf('/')) : null
  if (!provider) return { provider: null, endpoints: [], hosts: [], unreadable }
  const baseURL = lastDefined(configs, (config) => config?.provider?.[provider]?.options?.baseURL)
  if (baseURL) return { ...endpointsFromBaseURL(provider, baseURL), unreadable }
  const kind = readJson(authFile, fs)?.[provider]?.type === 'oauth' ? 'oauth' : 'api'
  return { provider, endpoints: [], hosts: builtInProviderHosts(provider, [kind]), unreadable }
}

// Codex always talks to OpenAI: ChatGPT sign-in (tokens) and/or an API key in the auth store of the
// home codex will actually read (CODEX_HOME when set, else ~/.codex).
function codexNetwork(codexHome, fs) {
  const file = path.join(codexHome, 'auth.json')
  const auth = readJson(file, fs)
  const kinds = [...(auth?.tokens ? ['oauth'] : []), ...(auth?.OPENAI_API_KEY ? ['api'] : [])]
  const unreadable = fs.readText(file) !== null && auth === null ? [file] : []
  return { provider: 'openai', endpoints: [], hosts: builtInProviderHosts('openai', kinds.length ? kinds : ['oauth']), unreadable }
}

// `--model x`, `-m x`, `--model=x` and `-m=x`.
const modelArgument = (args) => {
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index])
    if ((value === '--model' || value === '-m') && typeof args[index + 1] === 'string') return args[index + 1]
    const inline = /^(?:--model|-m)=(.+)$/.exec(value)
    if (inline) return inline[1]
  }
  return null
}

// A per-run OpenCode home: auth.json and the provider packages/bin are copied or bound read-only, so
// a lane cannot alter the shared cache (775 packages every run loads) or swap the shared auth (M1).
function opencodePrivateHome({ env, fs, runtimeDir, model }) {
  const shareDir = path.join(xdg(env, 'XDG_DATA_HOME', '.local/share'), 'opencode')
  const cacheDir = path.join(xdg(env, 'XDG_CACHE_HOME', '.cache'), 'opencode')
  const stateDir = path.join(xdg(env, 'XDG_STATE_HOME', '.local/state'), 'opencode')
  const privShare = path.join(runtimeDir, 'oc-share')
  const privCache = path.join(runtimeDir, 'oc-cache')
  const privState = path.join(runtimeDir, 'oc-state')
  for (const dir of [privShare, privCache, privState]) fs.ensureDir(dir)
  fs.copy(path.join(shareDir, 'auth.json'), path.join(privShare, 'auth.json'))
  const readOnlyOverlays = []
  const writable = [{ inside: shareDir, outside: privShare }, { inside: cacheDir, outside: privCache }, { inside: stateDir, outside: privState }]
  // The shared provider packages and models cache are needed to run but must not be writable.
  for (const sub of ['packages', 'bin']) {
    const src = path.join(cacheDir, sub)
    if (fs.isDir(src)) readOnlyOverlays.push(path.join(privCache, sub) === src ? src : { inside: path.join(cacheDir, sub), outside: src })
  }
  fs.copy(path.join(cacheDir, 'models.json'), path.join(privCache, 'models.json'))
  const configDir = path.join(xdg(env, 'XDG_CONFIG_HOME', '.config'), 'opencode')
  const network = (laneWritable) => opencodeModelNetwork({ configDir, model, authFile: path.join(shareDir, 'auth.json'), configFile: absolute(env.OPENCODE_CONFIG).find((file) => !laneWritable(file)), fs })
  return { writable, readOnlyOverlays, network }
}

const PROFILES = {
  opencode({ env, args, fs, runtimeDir, readonlyCwd, base }) {
    const configDir = path.join(xdg(env, 'XDG_CONFIG_HOME', '.config'), 'opencode')
    const configFile = absolute(env.OPENCODE_CONFIG).map((file) => path.dirname(file))
    const priv = opencodePrivateHome({ env, fs, runtimeDir, model: modelArgument(args) })
    const dirArgs = argumentValues(args, ['--dir'], base)
    const opencodeHome = OPENCODE_HOME_READ_ONLY.map((name) => path.join(home(env), '.opencode', name))
    return {
      readable: [configDir, ...opencodeConfigReferences(configDir, env, fs), ...configFile, ...opencodeHome, ...argumentValues(args, ['-f', '--file'], base), ...(readonlyCwd ? dirArgs : [])],
      writableRemap: priv.writable,
      writable: [...(readonlyCwd ? [] : dirArgs)],
      readOnlyOverlaysRemap: priv.readOnlyOverlays.filter((entry) => typeof entry === 'object'),
      readOnlyOverlays: priv.readOnlyOverlays.filter((entry) => typeof entry === 'string'),
      network: priv.network,
      // Read-only binds land BEFORE writable ones, so a writable bind over these would win. They
      // hold what the next lane executes or trusts (config, allow-list source, plugin packages).
      protectedPaths: [configDir, path.join(home(env), '.opencode')],
    }
  },
  codex({ env, fs, runtimeDir, base: _base }) {
    const codexHome = path.join(home(env), '.codex')
    // A per-run CODEX_HOME: ~/.codex stays READ-ONLY (it holds hooks.json the unsandboxed codex runs,
    // H3), auth.json is copied into the private home and written back only if the token refreshed.
    const privHome = path.join(runtimeDir, 'codex-home')
    fs.ensureDir(privHome)
    fs.copy(path.join(codexHome, 'auth.json'), path.join(privHome, 'auth.json'))
    fs.copy(path.join(codexHome, 'config.toml'), path.join(privHome, 'config.toml'))
    return {
      readable: executableBinds(findOnPath('codex', env.PATH, fs), fs),
      writableRemap: [{ inside: codexHome, outside: privHome }],
      writable: [...absolute(env.CLAUDE_PLUGIN_DATA)],
      readOnlyOverlaysRemap: [],
      readOnlyOverlays: [],
      // The INSIDE path of the remap above. privHome lives under the runtime dir (/run/user/<uid>),
      // which the sandbox never binds, so naming it here made codex exit on a missing CODEX_HOME.
      codexHome: env.CODEX_HOME ? undefined : codexHome,
      authWriteback: { from: path.join(privHome, 'auth.json'), to: path.join(codexHome, 'auth.json') },
      network: () => codexNetwork(absolute(env.CODEX_HOME)[0] ?? codexHome, fs),
      protectedPaths: [codexHome, ...absolute(env.CODEX_HOME)],
    }
  },
}

// The machine-wide suite lock (lib/suite-lock.mjs, Linux default location) serialises every test
// suite on the host, a lane's included; it is shared read-write so a lane waits like anyone else.
const suiteLockDir = (env) => path.join(xdg(env, 'XDG_STATE_HOME', '.local/state'), 'wt-suite-lock')

/**
 * The suite-lock runner a lane's WT_SUITE_LOCK_CMD runs, as a host-native path: it ships in the plugin's
 * bin/, beside the lib/ this module lives in, so a launcher anywhere (the plugin's own, or an adopted
 * copy in a config dir) resolves the file of the plugin it loaded this module from. Throws when the
 * file is absent, so a lane is never handed a command that cannot run.
 */
export function suiteLockCli(fs = realFs) {
  const cli = fileURLToPath(new URL(`../../wt-suite-lock-run${process.platform === 'win32' ? '.cmd' : '.mjs'}`, import.meta.url))
  if (!fs.isFile(cli)) throw new Error(`the suite-lock CLI is missing at ${cli}; update or reinstall workflow-toolbox`)
  return cli
}

function toolchainPaths({ env, execPath, fs }) {
  const nodeReal = fs.realpath(execPath) ?? execPath
  return [
    path.dirname(path.dirname(nodeReal)),
    ...['node', 'pnpm', 'npm', 'git'].flatMap((name) => executableBinds(findOnPath(name, env.PATH, fs), fs)),
    ...(absolute(env.COREPACK_HOME).length ? absolute(env.COREPACK_HOME) : [path.join(xdg(env, 'XDG_CACHE_HOME', '.cache'), 'node', 'corepack')]),
    path.join(xdg(env, 'XDG_DATA_HOME', '.local/share'), 'pnpm'),
  ]
}

// A git worktree's `.git` is a FILE naming its private gitdir; the shared object store lives in the
// main repository's `.git`. The gitdir directory is writable (index/refs); the four pointer/config
// files that git would EXECUTE from (config.worktree, the gitdir back-pointer, commondir, and the
// worktree's own .git) are overlaid READ-ONLY so a lane cannot plant fsmonitor/hooksPath (H1). The
// realpath of the gitdir must lie under <common>/worktrees/, which refuses a .git rewritten to point
// at the main repository or a sibling private repo (H2).
function gitPaths(directory, env, fs) {
  const dotGit = path.join(directory, '.git')
  const line = (fs.readText(dotGit) ?? '').split('\n').find((entry) => entry.startsWith('gitdir:'))
  if (!line) return { readable: [], writable: [], overlaysRo: [], anchor: null }
  const gitdir = path.resolve(directory, line.slice('gitdir:'.length).trim())
  const gitdirReal = fs.realpath(gitdir)
  const commonText = fs.readText(path.join(gitdir, 'commondir'))
  const common = commonText ? path.resolve(gitdir, commonText.trim()) : null
  const commonReal = common ? fs.realpath(common) : null
  if (!gitdirReal || !commonReal) throw new LaneSandboxRefusal(`lane git pointers are unreadable (gitdir ${gitdir})`)
  const worktreesRoot = path.join(commonReal, 'worktrees')
  if (gitdirReal !== worktreesRoot && !gitdirReal.startsWith(`${worktreesRoot}${path.sep}`)) {
    throw new LaneSandboxRefusal(`lane gitdir ${gitdirReal} is not under ${worktreesRoot}; refusing to bind it`)
  }
  const overlaysRo = [dotGit, path.join(gitdir, 'gitdir'), path.join(gitdir, 'commondir'), path.join(gitdir, 'config.worktree')]
  return { readable: [common], writable: [gitdir], overlaysRo, anchor: { gitdir: gitdirReal, common: commonReal } }
}

function operatorExtras(optionEnv, env, fs) {
  const refused = []
  const accepted = (name) => String(optionEnv[name] ?? '').split(path.delimiter).map((item) => item.trim()).filter(Boolean)
    .map((item) => (item.startsWith('~/') ? path.join(home(env), item.slice(2)) : item))
    .filter((item) => {
      const ok = path.isAbsolute(item) && !isForbiddenPath(item, env, fs)
      if (!ok) refused.push(item)
      return ok
    })
  return { readable: accepted(LANE_SANDBOX_READ_ENV), writable: accepted(LANE_SANDBOX_WRITE_ENV), refused }
}

function bindArgs(flag, paths) {
  return [...new Set(paths)].flatMap((item) => [flag, item, item])
}

function remapArgs(flag, remaps) {
  return remaps.flatMap(({ inside, outside }) => [flag, outside, inside])
}

function sandboxArguments({ readable, writable, writableRemap, readOnlyOverlays, readOnlyOverlaysRemap, env, chdir, fs, socketDir }) {
  const etcTargets = ETC_LINK_TARGETS.map((file) => fs.realpath(file)).filter((file) => file && !file.startsWith('/etc/') && !file.startsWith('/usr/'))
  return [
    '--die-with-parent', '--unshare-all', '--new-session',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    ...bindArgs('--ro-bind-try', [...SYSTEM_READ_ONLY, ...etcTargets]),
    '--dir', home(env),
    ...bindArgs('--ro-bind-try', readable),
    ...bindArgs('--bind-try', writable),
    ...remapArgs('--bind-try', writableRemap),
    ...(socketDir ? ['--bind', socketDir, socketDir] : []),
    // Read-only overlays land AFTER the writable binds they sit inside, so they win.
    ...bindArgs('--ro-bind-try', readOnlyOverlays),
    ...remapArgs('--ro-bind-try', readOnlyOverlaysRemap),
    '--chdir', chdir,
    '--unsetenv', 'XDG_RUNTIME_DIR', '--unsetenv', 'DBUS_SESSION_BUS_ADDRESS', '--unsetenv', 'SSH_AUTH_SOCK',
    '--setenv', 'TMPDIR', '/tmp', '--setenv', 'TMP', '/tmp', '--setenv', 'TEMP', '/tmp',
    '--setenv', LANE_SANDBOX_SWITCH_ENV, 'bwrap',
  ]
}

function unsandboxed(reason) {
  return { kind: 'none', reason, line: `lane sandbox: none (${reason}); running with the environment allow-list only`, wrap: (bin, args) => [bin, args], dispose: () => {} }
}

// Returns { ok } to sandbox, { none: reason } to run unsandboxed with that reason, or
// { refuse: reason } to REFUSE the launch. A bwrap that is PRESENT but whose probe fails is a
// refusal, never a silent unsandboxed run (M3); only WT_LANE_SANDBOX=off runs unsandboxed here.
function sandboxAvailability({ optionEnv, platform, bwrap, probe, fs }) {
  if (optionEnv[LANE_SANDBOX_SWITCH_ENV] === 'off') return { none: `disabled by ${LANE_SANDBOX_SWITCH_ENV}=off` }
  if (platform !== 'linux') return { none: `bubblewrap sandbox is Linux-only; this host is ${platform}` }
  if (!bwrap || !fs.exists(bwrap)) return { none: 'bubblewrap (bwrap) is not installed' }
  const probed = probe(bwrap)
  return probed.ok ? { ok: true } : { refuse: probed.reason }
}

// Host-side bridges, each listening on a unix socket bound into the sandbox: a socat relay per
// allowed loopback endpoint, and the egress proxy when the model has remote hosts. The sandbox has
// its own empty loopback (--unshare-net), so nothing else on the host is reachable; the bootstrap
// inside re-listens on each bridge's loopback address (H4).
// The realpath of the deepest existing ancestor, with the rest appended: a path that does not exist
// yet (a log file) is still compared by where it would really land.
function canonicalPath(candidate, fs) {
  const suffix = []
  let probe = path.resolve(candidate)
  while (true) {
    const real = fs.realpath(probe)
    if (real) return path.join(real, ...suffix)
    const parent = path.dirname(probe)
    if (parent === probe) return path.resolve(candidate)
    suffix.unshift(path.basename(probe))
    probe = parent
  }
}

const within = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`)

function laneWritablePredicate(roots, fs) {
  const canonicalRoots = roots.map((root) => canonicalPath(root, fs))
  return (candidate) => canonicalRoots.some((root) => within(canonicalPath(candidate, fs), root))
}

// A writable bind that contains (or sits inside) a CLI's config/auth location would override its
// read-only bind: bwrap applies binds in order and the writable ones come after. Refused, never
// silently dropped, so the operator sees which entry did it.
function refuseProtectedOverlap(writable, protectedPaths, fs) {
  for (const bind of writable) {
    const root = canonicalPath(bind, fs)
    for (const guarded of protectedPaths) {
      const target = canonicalPath(guarded, fs)
      if (within(target, root) || within(root, target)) throw new LaneSandboxRefusal(`refusing writable bind ${bind}: it overlaps ${guarded}, which a lane must not be able to change`)
    }
  }
}

// The egress log is written by the host-side proxy; a path the lane can write (or plant a symlink
// in) would let it aim that write at any file of the owner.
function refuseLaneWritableLog(egressLog, laneWritable) {
  if (egressLog && laneWritable(egressLog)) throw new LaneSandboxRefusal(`refusing ${LANE_EGRESS_LOG_ENV}=${egressLog}: it lies under a path the lane can write`)
}

function reportBridgeExit(diagnostics, message) {
  try {
    if (typeof diagnostics === 'number') writeSync(diagnostics, message)
    else process.stderr.write(message)
  } catch { /* nowhere left to say it */ }
}

function networkBridges({ network, socketDir, socat, execPath, egressLog }) {
  const bridges = network.endpoints.map((endpoint, index) => {
    const sock = path.join(socketDir, `ep-${index}.sock`)
    return { sock, host: endpoint.host, port: endpoint.port, command: socat, args: [`UNIX-LISTEN:${sock},fork,mode=600`, `TCP4:${endpoint.host}:${endpoint.port}`] }
  })
  if (network.hosts.length) {
    const used = new Set(network.endpoints.map((endpoint) => endpoint.port))
    let port = EGRESS_PROXY_PORT
    while (used.has(port)) port += 1
    const sock = path.join(socketDir, 'egress.sock')
    const log = path.isAbsolute(egressLog ?? '') ? ['--log', egressLog] : []
    const parentStart = processStartTime(process.pid)
    bridges.push({ sock, host: '127.0.0.1', port, proxy: true, command: execPath, args: [EGRESS_PROXY, '--socket', sock, '--allow', network.hosts.join(','), '--parent', String(process.pid), ...(parentStart === null ? [] : ['--parent-start', String(parentStart)]), ...log] })
  }
  return bridges
}

// Starts every host bridge and waits for its socket. A bridge whose socket never appears REFUSES
// the launch (the lane would otherwise start with a launch line claiming a route that does not
// exist); a bridge that dies later says so on the lane's diagnostics stream (its run log).
function startBridges({ bridges, fs, spawnFn, socat, diagnostics, state }) {
  const relays = bridges.map((bridge) => {
    const relay = spawnFn(bridge.command, bridge.args, { stdio: ['ignore', 'ignore', typeof diagnostics === 'number' ? diagnostics : 'inherit'], detached: false })
    if (typeof relay?.once === 'function') {
      relay.once('exit', (code, signal) => {
        if (!state.disposed) reportBridgeExit(diagnostics, `workflow-toolbox: lane ${bridge.proxy ? 'egress proxy' : 'endpoint relay'} exited (code ${code ?? 'none'}, signal ${signal ?? 'none'}); the sandboxed lane has lost that route\n`)
      })
    }
    return relay
  })
  const insideCommands = bridges.map((bridge) => `${shPosix(socat)} TCP4-LISTEN:${bridge.port},bind=${bridge.host},fork,reuseaddr UNIX-CONNECT:${shPosix(bridge.sock)} >/dev/null 2>&1 &`)
  // A host bridge's unix socket appears asynchronously. Wait for it BEFORE the sandbox starts, or
  // the lane's first connection races the socket into existence and is refused (measured).
  const deadline = Date.now() + 3_000
  for (const { sock } of bridges) {
    while (!fs.exists(sock) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
  const missing = bridges.filter(({ sock }) => !fs.exists(sock))
  if (missing.length) {
    state.disposed = true
    for (const relay of relays) { try { relay.kill('SIGKILL') } catch { /* already gone */ } }
    const names = missing.map((bridge) => (bridge.proxy ? 'egress proxy' : 'relay to ' + bridge.host + ':' + bridge.port)).join(', ')
    throw new LaneSandboxRefusal(`lane ${names} did not start within 3 s; refusing to launch a lane whose route does not exist`)
  }
  return { relays, insideCommands }
}

// Inside the namespace, HTTP(S)_PROXY name the bridged proxy; loopback stays direct so a relayed
// loopback endpoint is not sent through it. Both cases: curl reads only the lower-case http_proxy.
function proxyEnvironment(proxy) {
  if (!proxy) return []
  const url = `http://${proxy.host}:${proxy.port}`
  return ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'].flatMap((name) => ['--setenv', name, url])
    .concat(['NO_PROXY', 'no_proxy'].flatMap((name) => ['--setenv', name, '127.0.0.1,localhost,::1']))
}

function networkNote({ network, bridges, socat }) {
  const endpointList = network.endpoints.map((e) => `${e.host}:${e.port}`).join(', ')
  const proxy = bridges.find((bridge) => bridge.proxy)
  const parts = []
  if (!socat) parts.push('network isolated (socat absent, no bridge)')
  else if (endpointList) parts.push(`network isolated, bridged to ${endpointList}`)
  else parts.push('network isolated (no loopback endpoint configured)')
  if (proxy) parts.push(`egress proxy to ${network.hosts.join(', ')} only (HTTPS CONNECT to port 443, TLS SNI must equal the CONNECT host; not covered: Host-header fronting inside TLS, and the provider account itself as a place to send data)`)
  else if (network.provider && socat && !endpointList) parts.push(`no egress: provider ${network.provider} has no known hosts`)
  if (network.unreadable?.length) parts.push(`config not parsed by the egress planner (allow-list may be smaller than OpenCode expects): ${network.unreadable.join(', ')}`)
  return parts.join('; ')
}

const SINGLE_QUOTE_ESCAPE = "'\\''"
const shPosix = (value) => `'${String(value).replaceAll("'", () => SINGLE_QUOTE_ESCAPE)}'`

/**
 * Decides how one external-lane child is started. On Linux with a working bubblewrap it returns a
 * plan whose `wrap` puts the command inside the sandbox and `dispose` tears down the network bridge;
 * anywhere else it returns `kind: 'none'` with the reason, never a silent pass-through. Throws
 * LaneSandboxRefusal on a security-invariant violation (a git pointer outside the worktrees dir, or
 * a working directory that is /, $HOME or an ancestor). `profile` names the CLI whose own config and
 * credentials are legitimately readable ('opencode' | 'codex'); `paths` adds caller-owned
 * directories (a probe fixture); WT_LANE_SANDBOX_READ/WRITE in `optionEnv` add the operator's.
 */
export function resolveLaneSandbox({ profile, bin, args = [], cwd, env = {}, optionEnv = process.env, paths = {}, platform = process.platform, execPath = process.execPath, bwrap, socat, probe = probeBwrap, fs = realFs, spawnFn = spawn, runtimeParent, readonlyCwd = false, diagnostics } = {}) {
  const bwrapPath = bwrap ?? findOnPath('bwrap', optionEnv.PATH, fs) ?? '/usr/bin/bwrap'
  const socatPath = socat ?? findOnPath('socat', optionEnv.PATH, fs) ?? (fs.isFile('/usr/bin/socat') ? '/usr/bin/socat' : null)
  const availability = sandboxAvailability({ optionEnv, platform, bwrap: bwrapPath, probe, fs })
  if (availability.none) return unsandboxed(availability.none)
  if (availability.refuse) throw new LaneSandboxRefusal(`bubblewrap is present but its probe failed (${availability.refuse}); refusing to launch a lane unsandboxed — set ${LANE_SANDBOX_SWITCH_ENV}=off to override deliberately`)

  // A relative working directory is resolved, not dropped (LOW 8): the lane must land in a real tree.
  const base = cwd ? path.resolve(cwd) : null
  const workdir = base ? [base] : []
  if (workdir.length && isForbiddenPath(workdir[0], env, fs)) throw new LaneSandboxRefusal(`refusing to run a lane with working directory ${workdir[0]} (/, $HOME or an ancestor)`)
  for (const dir of argumentValues(args, ['--dir'], base)) {
    if (isForbiddenPath(dir, env, fs)) throw new LaneSandboxRefusal(`refusing a lane --dir of ${dir} (/, $HOME or an ancestor)`)
  }

  const parent = runtimeParent ?? (path.isAbsolute(optionEnv.XDG_RUNTIME_DIR ?? '') ? optionEnv.XDG_RUNTIME_DIR : os.tmpdir())
  fs.ensureDir(parent)
  const runtimeDir = path.join(parent, `wt-lane-sandbox-${process.pid}-${randomUUID().slice(0, 8)}`)
  fs.ensureDir(runtimeDir)

  const selected = PROFILES[profile]({ env, args, fs, runtimeDir, readonlyCwd, base })
  const extras = operatorExtras(optionEnv, env, fs)
  const git = workdir.length ? gitPaths(workdir[0], env, fs) : { readable: [], writable: [], overlaysRo: [] }
  for (const overlay of git.overlaysRo) fs.ensureFile(overlay)

  fs.ensureDir(suiteLockDir(env))
  // A read-only role (observer, second-opinion) gets its working directory bound read-only (H5).
  const rawReadable = [...toolchainPaths({ env, execPath, fs }), ...executableBinds(bin, fs), ...selected.readable, ...git.readable, ...(readonlyCwd ? workdir : []), ...(paths.readable ?? []), ...extras.readable]
  const rawWritable = [...(readonlyCwd ? [] : workdir), ...selected.writable, ...git.writable, suiteLockDir(env), ...(paths.writable ?? []), ...extras.writable]
  // The root/$HOME/ancestor refusal covers EVERY computed bind, not only the operator extras (H2).
  const readable = rawReadable.filter((item) => item && !isForbiddenPath(item, env, fs))
  const writable = rawWritable.filter((item) => item && !isForbiddenPath(item, env, fs))
  refuseProtectedOverlap(writable, selected.protectedPaths ?? [], fs)
  // Everything the lane can write: its writable binds and the per-run runtime dir (private remaps,
  // bridge sockets). Configuration found there never feeds the allow-list, and no log goes there.
  const laneWritable = laneWritablePredicate([...writable, runtimeDir], fs)
  const egressLog = optionEnv[LANE_EGRESS_LOG_ENV]
  refuseLaneWritableLog(egressLog, laneWritable)

  const planned = selected.network(laneWritable)
  const network = socatPath ? planned : { ...planned, endpoints: [], hosts: [] }
  const { endpoints } = network
  const socketDir = endpoints.length || network.hosts.length ? path.join(runtimeDir, 'net') : null
  if (socketDir) fs.ensureDir(socketDir)
  const bridges = socketDir ? networkBridges({ network, socketDir, socat: socatPath, execPath, egressLog }) : []
  const bridgeState = { disposed: false }
  let bridge
  try { bridge = startBridges({ bridges, fs, spawnFn, socat: socatPath, diagnostics, state: bridgeState }) } catch (error) {
    try { rmSync(runtimeDir, { recursive: true, force: true }) } catch { /* best effort */ }
    throw error
  }

  const prefix = sandboxArguments({
    readable, writable, writableRemap: selected.writableRemap ?? [],
    // git pointer/config overlays (H1) land read-only on top of the writable gitdir.
    readOnlyOverlays: [...(selected.readOnlyOverlays ?? []), ...git.overlaysRo],
    readOnlyOverlaysRemap: selected.readOnlyOverlaysRemap ?? [],
    env, chdir: workdir[0] ?? home(env), fs, socketDir,
  })
  if (selected.codexHome) prefix.push('--setenv', 'CODEX_HOME', selected.codexHome)
  prefix.push(...proxyEnvironment(bridges.find((item) => item.proxy)))

  const refusedNote = extras.refused.length ? `; refused ${LANE_SANDBOX_READ_ENV}/${LANE_SANDBOX_WRITE_ENV} entries ${extras.refused.join(', ')}` : ''
  const netNote = networkNote({ network, bridges, socat: socatPath })
  // Both the writable AND the readable sets are recorded: a secret leak would come from a readable
  // bind, so a reader can audit exactly what was exposed (LOW 2).
  const line = `lane sandbox: bwrap (${profile}; writable ${[...new Set(writable)].join(', ')}; readable ${[...new Set(readable)].join(', ')}; ${netNote}; extra paths via ${LANE_SANDBOX_READ_ENV}/${LANE_SANDBOX_WRITE_ENV}${refusedNote})`

  // Write the CLI's refreshed credential back to the shared home only if it actually changed inside
  // the per-run home; the shared file stayed read-only during the run (H3). Lives here (host
  // perimeter) so the fs I/O does not count against a non-host module's primitive ratchet.
  const writeBackAuth = () => {
    const wb = selected.authWriteback
    if (!wb) return
    const fresh = fs.readText(wb.from)
    if (fresh !== null && fresh !== fs.readText(wb.to)) fs.writeText?.(wb.to, fresh)
  }

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    bridgeState.disposed = true
    for (const relay of bridge.relays) { try { relay.kill('SIGKILL') } catch { /* already gone */ } }
    try { rmSync(runtimeDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }

  const wrap = (command, commandArgs) => {
    if (!bridge.insideCommands.length) return [bwrapPath, [...prefix, '--', command, ...commandArgs]]
    // A bootstrap starts the inside socat relays, then runs the real command in the FOREGROUND (not
    // exec) so the relays stay children of the running shell for the command's whole life, and the
    // shell exits with the command's own status. "$@" carries the command and its arguments.
    const bootstrap = `${bridge.insideCommands.join('\n')}\nsleep 0.5\n"$@"\nec=$?\nexit "$ec"`
    return [bwrapPath, [...prefix, '--', '/bin/sh', '-c', bootstrap, 'wt-lane-net', command, ...commandArgs]]
  }

  return { kind: 'bwrap', line, readable, writable, endpoints, egressHosts: bridges.some((item) => item.proxy) ? network.hosts : [], anchor: git.anchor ?? null, authWriteback: selected.authWriteback ?? null, writeBackAuth, wrap, dispose }
}

const announced = new Set()

// One line per process for an unsandboxed lane, so a reader can always tell sandboxed from not.
export function announceUnsandboxedLane(sandbox, write = (text) => process.stderr.write(text)) {
  if (sandbox.kind !== 'none' || announced.has(sandbox.line)) return
  announced.add(sandbox.line)
  write(`workflow-toolbox: ${sandbox.line}\n`)
}

// Am I running inside a bwrap-style sandbox? Mechanical, from the user namespace map rather than an
// environment variable (M4): the initial user namespace has the identity map `0 0 4294967295`; a
// bwrap sandbox has a restricted map (e.g. `1000 1000 1`). Returns null off Linux / unreadable.
export function insideChildUserNamespace(fs = realFs) {
  const map = fs.readText('/proc/self/uid_map')
  if (map === null) return null
  return !/^\s*0\s+0\s+4294967295\s*$/.test(map.trim())
}
