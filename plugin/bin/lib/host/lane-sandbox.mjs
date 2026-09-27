import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import os from 'node:os'
// POSIX paths, not the host's native ones: every path here names a location inside a Linux bwrap
// sandbox or on the Linux host that builds it. The plan is never built elsewhere (see
// sandboxAvailability), and on a Windows host `node:path` would rewrite `/home/x` into `\\home\\x`.
import { posix as path, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJsonc } from './jsonc.mjs'
import { processStartTime } from './pid-namespace.mjs'
import { sandboxExtraPaths } from './sandbox-extra-paths.mjs'
import { laneHostStateRoot } from './lane-host-dir.mjs'

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
const CODEX_PATH_DIR = '/run/wt-lane/bin'
const probeCache = new Map()
const SYSTEM_BIN_DIRS = ['/usr/bin', '/bin', '/usr/local/bin', '/run/current-system/sw/bin']

function trustedSystemExecutable(name, searchPath) {
  for (const directory of SYSTEM_BIN_DIRS) {
    const candidate = path.join(directory, name)
    let target
    try { target = realpathSync.native(candidate) } catch { continue }
    try {
      const file = statSync(target)
      accessSync(target, constants.X_OK)
      if (!file.isFile() || file.uid !== 0 || (file.mode & 0o022)) continue
      let child = target
      for (let parent = path.dirname(child); ; child = parent, parent = path.dirname(parent)) {
        const info = lstatSync(parent)
        // NixOS: root-owned sticky /nix/store can be group-writable when the next entry is root-owned.
        const entry = lstatSync(child)
        if (info.uid !== 0 || ((info.mode & 0o022) && !((info.mode & 0o1000) && entry.uid === 0))) throw new Error('untrusted ancestor')
        if (parent === '/') break
      }
      return target
    } catch { /* try the next system location */ }
  }
  const found = findOnPath(name, searchPath, realFs)
  if (found) throw new LaneSandboxRefusal(`untrusted ${name} at ${found}; install it root-owned or set WT_LANE_SANDBOX=off`)
  return null
}

export class LaneSandboxRefusal extends Error {}

const realFs = {
  exists: (file) => existsSync(file),
  realpath: (file) => { try { return realpathSync.native(file) } catch { return null } },
  isFile: (file) => { try { return statSync(file).isFile() } catch { return false } },
  // Windows has no execute bit to check (a .cmd is invoked by name resolution, never by mode); the
  // check is POSIX-only, and always true on win32.
  isExecutable: (file) => { if (process.platform === 'win32') { return true } try { accessSync(file, constants.X_OK); return true } catch { return false } },
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
    if (fs.isFile(candidate) && (fs.isExecutable?.(candidate) ?? true)) return candidate
  }
  return null
}

const home = (env) => env.HOME || '/nonexistent'
const xdg = (env, name, fallback) => (path.isAbsolute(env[name] ?? '') ? env[name] : path.join(home(env), fallback))
const absolute = (value) => (path.isAbsolute(value ?? '') ? [value] : [])

function executableMount(invoked, fs) {
  if (!invoked || !path.isAbsolute(invoked)) return []
  const target = fs.realpath(invoked) ?? invoked
  return [{ directory: path.dirname(target), fallback: [target], executable: invoked }]
}

function executableSymlinks(invoked, fs) {
  if (!invoked || !path.isAbsolute(invoked)) return []
  const real = fs.realpath(invoked) ?? invoked
  return real === invoked ? [] : [{ target: real, link: invoked }]
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
  if (homeDir === target || homeDir.startsWith(`${target}${path.sep}`)) return true
  // Host-owned lane state (records, decisions, logs) must never be visible to a lane: its root, an
  // ancestor that would contain it, or anything beneath it.
  const hostRoot = hostStateRootOf(env, fs)
  return hostRoot !== null && (within(target, hostRoot) || within(hostRoot, target))
}

function hostStateRootOf(env, fs) {
  try {
    const root = laneHostStateRoot({ env })
    return fs.realpath(root) ?? path.resolve(root)
  } catch { return null }
}

// The global OpenCode config names the files it substitutes with {file:...} (API keys among them).
// Only the GLOBAL config is followed: it is read-only inside the sandbox, so a lane cannot append a
// reference that the next launch would honour. Project configs live in the writable worktree.
function opencodeConfigReferences(configDir, env, fs, trustedRead) {
  const references = []
  for (const name of OPENCODE_GLOBAL_CONFIGS) {
    const text = trustedRead(path.join(configDir, name))
    for (const match of text?.matchAll(FILE_REFERENCE) ?? []) {
      const raw = match[1].trim()
      const expanded = raw.startsWith('~/') ? path.join(home(env), raw.slice(2)) : path.resolve(configDir, raw)
      if (trustedRead(expanded) !== null) references.push(expanded)
    }
  }
  return references
}

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
function opencodeModelNetwork({ configDir, model, authFile, configFile, trustedRead }) {
  const files = [...OPENCODE_GLOBAL_CONFIGS.map((name) => path.join(configDir, name)), ...(configFile ? [configFile] : [])]
  const unreadable = files.filter((file) => trustedRead(file) !== null && parseJsonc(trustedRead(file)) === null)
  const configs = files.map((file) => parseJsonc(trustedRead(file))).filter(Boolean)
  const chosen = model || lastDefined(configs, (config) => config.model)
  const provider = typeof chosen === 'string' && chosen.includes('/') ? chosen.slice(0, chosen.indexOf('/')) : null
  if (!provider) return { provider: null, endpoints: [], hosts: [], unreadable }
  const baseURL = lastDefined(configs, (config) => config?.provider?.[provider]?.options?.baseURL)
  if (baseURL) return { ...endpointsFromBaseURL(provider, baseURL), unreadable }
  const auth = trustedRead(authFile)
  let kind = null
  if (auth !== null) kind = parseJsonc(auth)?.[provider]?.type === 'oauth' ? 'oauth' : 'api'
  return { provider, endpoints: [], hosts: kind ? builtInProviderHosts(provider, [kind]) : [], unreadable }
}

// Codex always talks to OpenAI: ChatGPT sign-in (tokens) and/or an API key in the auth store of the
// home codex will actually read (CODEX_HOME when set, else ~/.codex).
function codexNetwork(codexHome, trustedRead) {
  const file = path.join(codexHome, 'auth.json')
  const auth = parseJsonc(trustedRead(file))
  const kinds = [...(auth?.tokens ? ['oauth'] : []), ...(auth?.OPENAI_API_KEY ? ['api'] : [])]
  const unreadable = trustedRead(file) !== null && auth === null ? [file] : []
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
function opencodePrivateHome({ env, fs, runtimeDir, model, trustedRead, trustedAuthRead }) {
  const shareDir = path.join(xdg(env, 'XDG_DATA_HOME', '.local/share'), 'opencode')
  const cacheDir = path.join(xdg(env, 'XDG_CACHE_HOME', '.cache'), 'opencode')
  const stateDir = path.join(xdg(env, 'XDG_STATE_HOME', '.local/state'), 'opencode')
  const privShare = path.join(runtimeDir, 'oc-share')
  const privCache = path.join(runtimeDir, 'oc-cache')
  const privState = path.join(runtimeDir, 'oc-state')
  const readOnlyOverlays = []
  const writable = [{ inside: shareDir, outside: privShare }, { inside: cacheDir, outside: privCache }, { inside: stateDir, outside: privState }]
  // The shared provider packages and models cache are needed to run but must not be writable.
  for (const sub of ['packages', 'bin']) {
    const src = path.join(cacheDir, sub)
    if (fs.isDir(src)) readOnlyOverlays.push(path.join(privCache, sub) === src ? src : { inside: path.join(cacheDir, sub), outside: src })
  }
  const prepare = () => {
    for (const dir of [privShare, privCache, privState]) fs.ensureDir(dir)
    fs.copy(path.join(shareDir, 'auth.json'), path.join(privShare, 'auth.json'))
    fs.copy(path.join(cacheDir, 'models.json'), path.join(privCache, 'models.json'))
  }
  const configDir = path.join(xdg(env, 'XDG_CONFIG_HOME', '.config'), 'opencode')
   const network = () => opencodeModelNetwork({ configDir, model, authFile: path.join(shareDir, 'auth.json'), configFile: absolute(env.OPENCODE_CONFIG)[0], trustedRead: (file) => file === path.join(shareDir, 'auth.json') ? trustedAuthRead(file) : trustedRead(file) })
  return { writable, readOnlyOverlays, network, prepare }
}

const PROFILES = {
   opencode({ env, args, fs, runtimeDir, readonlyCwd, base, trustedRead, trustedAuthRead }) {
    const configDir = path.join(xdg(env, 'XDG_CONFIG_HOME', '.config'), 'opencode')
    const configFile = absolute(env.OPENCODE_CONFIG).map((file) => path.dirname(file))
     const priv = opencodePrivateHome({ env, fs, runtimeDir, model: modelArgument(args), trustedRead, trustedAuthRead })
    const dirArgs = argumentValues(args, ['--dir'], base)
    const opencodeHome = OPENCODE_HOME_READ_ONLY.map((name) => path.join(home(env), '.opencode', name))
    return {
      readable: () => [configDir, ...opencodeConfigReferences(configDir, env, fs, trustedRead), ...configFile.filter((dir) => trustedRead(path.join(dir, path.basename(env.OPENCODE_CONFIG))) !== null), ...opencodeHome, ...argumentValues(args, ['-f', '--file'], base), ...(readonlyCwd ? dirArgs : [])],
      prepare: priv.prepare,
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
  codex({ env, fs, runtimeDir, base: _base, trustedRead }) {
    const codexHome = path.join(home(env), '.codex')
    // A per-run CODEX_HOME: ~/.codex stays READ-ONLY (it holds hooks.json the unsandboxed codex runs,
    // H3), auth.json is copied into the private home and written back only if the token refreshed.
    const privHome = path.join(runtimeDir, 'codex-home')
    return {
      prepare: () => {
        fs.ensureDir(privHome)
        if (fs === realFs) {
          try {
            const text = guardedAuthRead(path.join(codexHome, 'auth.json'))
            writeFileSync(path.join(privHome, 'auth.json'), text, { mode: 0o600, flag: 'wx' })
          } catch { /* never copy a symlinked or non-regular credential into a lane */ }
        } else fs.copy(path.join(codexHome, 'auth.json'), path.join(privHome, 'auth.json'))
        fs.copy(path.join(codexHome, 'config.toml'), path.join(privHome, 'config.toml'))
      },
      writableRemap: [{ inside: codexHome, outside: privHome }],
      writable: [...absolute(env.CLAUDE_PLUGIN_DATA)],
      readOnlyOverlaysRemap: [],
      readOnlyOverlays: [],
      // The INSIDE path of the remap above. privHome lives under the runtime dir (/run/user/<uid>),
      // which the sandbox never binds, so naming it here made codex exit on a missing CODEX_HOME.
      codexHome: env.CODEX_HOME ? undefined : codexHome,
      authWriteback: { from: path.join(privHome, 'auth.json'), to: path.join(codexHome, 'auth.json') },
       network: () => codexNetwork(absolute(env.CODEX_HOME)[0] ?? codexHome, trustedRead),
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
  // POSIX only: a checkout that lost its execute bit (e.g. an archive extracted with the bit
  // stripped) spawns ENOEXEC/EACCES deep inside a lane instead of failing here with a clear cause.
  // A fake fs without isExecutable (existing callers) is treated as "unknown", never refused.
  if (fs.isExecutable && !fs.isExecutable(cli)) throw new Error(`the suite-lock CLI at ${cli} is not executable; update or reinstall workflow-toolbox`)
  return cli
}

function toolchainPaths({ env, execPath, fs }) {
  const nodeReal = fs.realpath(execPath) ?? execPath
  const executables = ['node', 'pnpm', 'npm', 'git'].map((name) => findOnPath(name, env.PATH, fs))
  return {
    executableMounts: [
      { directory: path.dirname(path.dirname(nodeReal)), fallback: ['bin', 'lib'].map((sub) => path.join(path.dirname(path.dirname(nodeReal)), sub)), executable: execPath },
      ...executables.flatMap((invoked) => executableMount(invoked, fs)),
    ],
    readable: [
      ...(absolute(env.COREPACK_HOME).length ? absolute(env.COREPACK_HOME) : [path.join(xdg(env, 'XDG_CACHE_HOME', '.cache'), 'node', 'corepack')]),
      path.join(xdg(env, 'XDG_DATA_HOME', '.local/share'), 'pnpm'),
    ],
    executableSymlinks: executables.flatMap((invoked) => executableSymlinks(invoked, fs)),
  }
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
  const accepted = (name) => sandboxExtraPaths(optionEnv[name])
    .map((item) => (item.startsWith('~/') ? path.join(home(env), item.slice(2)) : item))
    .filter((item) => {
      const ok = path.isAbsolute(item) && !isForbiddenPath(item, env, fs)
      if (!ok) refused.push(item)
      return ok
    })
  return { readable: accepted(LANE_SANDBOX_READ_ENV), writable: accepted(LANE_SANDBOX_WRITE_ENV), refused }
}

function bindPath(item) {
  if (typeof item !== 'string' || !path.isAbsolute(item) || item.split('/').includes('..')) {
    throw new LaneSandboxRefusal(`refusing path ${String(item)}: non-absolute path or parent traversal in a bind cannot be checked safely`)
  }
  return item
}

function bindArgs(flag, paths) {
  return [...new Set(paths)].flatMap((item) => [flag, bindPath(item), bindPath(item)])
}

function remapArgs(flag, remaps) {
  return remaps.flatMap(({ inside, outside }) => [flag, bindPath(outside), bindPath(inside)])
}

function socketMasks(bindings, socketDir, fs, searchPath, injectedFind) {
  if (fs !== realFs) return [] // injected fixture has no host pathname sockets
  const find = injectedFind ?? trustedSystemExecutable('find', searchPath)
  if (!find) throw new LaneSandboxRefusal('trusted find is required to mask unix sockets')
  const sockets = new Set()
  for (const { outside, inside } of bindings) {
    const source = fs.realpath(outside) ?? outside
    if (!fs.isDir(source) && !isSocketSource(source)) continue
    if (outside === socketDir || SYSTEM_READ_ONLY.some((root) => withinOnDisk(source, root))) continue
    const result = spawnSync(find, [source, '-type', 's', '-print0'], { encoding: 'buffer', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 })
    if (result.error || result.signal || (result.status !== 0 && !String(result.stderr).split('\n').every((line) => !line || line.includes('Permission denied')))) {
      throw new LaneSandboxRefusal(`cannot enumerate unix sockets under ${outside}: ${result.error?.message ?? String(result.stderr).trim()}`)
    }
    for (const item of result.stdout.toString().split('\0').filter(Boolean)) {
      const destination = path.join(inside, path.relative(source, item))
      if (!socketDir || !withinOnDisk(destination, socketDir)) sockets.add(destination)
    }
  }
  return [...sockets].flatMap((destination) => ['--ro-bind', '/dev/null', destination])
}

function isSocketSource(file) {
  try { return lstatSync(file).isSocket() } catch { return false }
}

function sandboxArguments({ readable, writable, writableRemap, readOnlyOverlays, readOnlyOverlaysRemap, executableSymlinks, codexReal, codexPath, env, chdir, fs, socketDir, masks }) {
  const etcTargets = ETC_LINK_TARGETS.map((file) => fs.realpath(file)).filter((file) => file && !file.startsWith('/etc/') && !file.startsWith('/usr/'))
  const mounted = [...SYSTEM_READ_ONLY, ...readable, ...writable, ...writableRemap.map(({ inside }) => inside)]
  const uniqueSymlinks = [...new Map(executableSymlinks.map((entry) => [entry.link, entry])).values()]
  const symlinks = uniqueSymlinks.filter(({ link }) => !mounted.some((root) => link === root || link.startsWith(`${root}${path.sep}`)))
  return [
    '--die-with-parent', '--unshare-all', '--new-session',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    ...bindArgs('--ro-bind-try', [...SYSTEM_READ_ONLY, ...etcTargets]),
    '--dir', home(env),
    ...[...new Set(symlinks.map(({ link }) => path.dirname(link)))].flatMap((directory) => ['--dir', directory]),
    ...symlinks.flatMap(({ target, link }) => ['--symlink', target, link]),
    ...bindArgs('--ro-bind-try', readable),
    ...bindArgs('--bind-try', writable),
    ...remapArgs('--bind-try', writableRemap),
    ...(socketDir ? ['--bind', socketDir, socketDir] : []),
    // Read-only overlays land AFTER the writable binds they sit inside, so they win.
    ...bindArgs('--ro-bind-try', readOnlyOverlays),
    ...remapArgs('--ro-bind-try', readOnlyOverlaysRemap),
    ...masks,
    ...(codexReal ? ['--dir', CODEX_PATH_DIR, '--symlink', codexReal, `${CODEX_PATH_DIR}/codex`] : []),
    '--chdir', chdir,
    '--unsetenv', 'XDG_RUNTIME_DIR', '--unsetenv', 'DBUS_SESSION_BUS_ADDRESS', '--unsetenv', 'SSH_AUTH_SOCK',
    '--setenv', 'TMPDIR', '/tmp', '--setenv', 'TMP', '/tmp', '--setenv', 'TEMP', '/tmp',
    '--setenv', LANE_SANDBOX_SWITCH_ENV, 'bwrap',
    ...(codexReal ? ['--setenv', 'PATH', codexPath] : []),
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

export function laneUnsandboxedAtStart(optionEnv = process.env, platform = process.platform) {
  if (optionEnv[LANE_SANDBOX_SWITCH_ENV] === 'off' || platform !== 'linux') return true
  try { return !trustedSystemExecutable('bwrap', optionEnv.PATH) }
  catch (error) {
    if (error instanceof LaneSandboxRefusal) return false
    throw error
  }
}

function hostSandboxExecutables(platform, optionEnv, bwrap, socat) {
  if (platform !== 'linux' || optionEnv[LANE_SANDBOX_SWITCH_ENV] === 'off') return { bwrapPath: bwrap, socatPath: socat }
  return {
    bwrapPath: bwrap ?? trustedSystemExecutable('bwrap', optionEnv.PATH),
    socatPath: socat === undefined ? trustedSystemExecutable('socat', optionEnv.PATH) : socat,
  }
}

// Host-side bridges, each listening on a unix socket bound into the sandbox: a socat relay per
// allowed loopback endpoint, and the egress proxy when the model has remote hosts. The sandbox has
// its own empty loopback (--unshare-net), so nothing else on the host is reachable; the bootstrap
// inside re-listens on each bridge's loopback address (H4).
// The realpath of the deepest existing ancestor, with the rest appended: a path that does not exist
// yet (a log file) is still compared by where it would really land.
function canonicalPath(candidate, fs, hostPath = path) {
  if (hostPath === path) bindPath(candidate)
  else if (typeof candidate !== 'string' || !hostPath.isAbsolute(candidate) || candidate.split(/[\\/]/).includes('..')) {
    throw new LaneSandboxRefusal(`refusing path ${String(candidate)}: non-absolute path or parent traversal in a bind cannot be checked safely`)
  }
  const suffix = []
  let probe = candidate
  while (true) {
    const real = fs.realpath(probe)
    if (real) return hostPath.join(real, ...suffix)
    const parent = hostPath.dirname(probe)
    if (parent === probe) return hostPath.resolve(candidate)
    suffix.unshift(hostPath.basename(probe))
    probe = parent
  }
}

function registeredLaneRoots(optionEnv) {
  // The host-owned index is optional for older installations; without it the worktree-segment
  // and current-launch checks still apply. One unreadable entry skips only itself: stopping at the
  // first failure would silently drop every later root and widen what is trusted.
  const base = laneHostStateRoot({ env: optionEnv })
  const roots = []
  const present = existsSync(base)
  let entries = []
  try { entries = readdirSync(base) } catch { /* no registry on pre-upgrade installations */ }
  for (const entry of entries) {
    try {
      const fd = openSync(path.join(base, entry, 'worktree'), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
      try { if (fstatSync(fd).isFile()) roots.push(readFileSync(fd, 'utf8').trim()) } finally { closeSync(fd) }
    } catch { /* this entry has no readable index file */ }
  }
  return { roots: roots.filter((root) => path.isAbsolute(root)), present }
}

function checkedConfigRead(file, fs, writable, registered, rejected) {
  const canonical = canonicalPath(file, fs)
  const blocked = writable(file) || writable(canonical) || registered.some((root) => withinOnDisk(canonical, root)) || canonical.includes('/.claude/worktrees/')
  if (blocked) { rejected.add(file); return null }
  if (fs !== realFs) return fs.readText(file)
  let fd
  try {
    fd = openSync(canonical, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    if (!fstatSync(fd).isFile()) return null
    return readFileSync(fd, 'utf8')
  } catch { return null } finally { if (fd !== undefined) closeSync(fd) }
}

const within = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`)
const withinOnDisk = (child, parent, separator = path.sep) => child.toLowerCase() === parent.toLowerCase() || child.toLowerCase().startsWith(`${parent.toLowerCase()}${separator}`)

function laneWritablePredicate(roots, fs, hostPath = path) {
  const canonicalRoots = roots.map((root) => canonicalPath(root, fs, hostPath))
  return (candidate) => {
    const canonical = canonicalPath(candidate, fs, hostPath)
    return canonicalRoots.some((root, index) => withinOnDisk(canonical, root, hostPath.sep) || withinOnDisk(hostPath.resolve(candidate), hostPath.resolve(roots[index]), hostPath.sep))
  }
}

function effectiveWritableRoots({ workdir, selected, git, env, paths, extras, runtimeDir, readonlyCwd, suiteLock = suiteLockDir(env) }) {
  return [...(readonlyCwd ? [] : workdir), ...(selected.writable ?? []), ...git.writable, suiteLock, ...(paths.writable ?? []), ...extras.writable, ...(selected.writableRemap ?? []).map(({ inside }) => inside), runtimeDir]
}

// The Linux planner deliberately uses POSIX paths. On Windows no bwrap plan is built, but the
// launcher's host-output preflight still needs the corresponding native writable locations.
function windowsWritableRoots({ cwd, args, profile, env, optionEnv, paths, readonlyCwd, fs }) {
  const homeDir = env.USERPROFILE || env.HOME || os.homedir()
  const base = win32.resolve(cwd)
  const xdgDir = (name, fallback) => win32.isAbsolute(env[name] ?? '') ? env[name] : win32.join(homeDir, fallback)
  const state = win32.isAbsolute(env.XDG_STATE_HOME ?? '') ? env.XDG_STATE_HOME : env.LOCALAPPDATA || win32.join(homeDir, 'AppData', 'Local')
  const hostState = win32.isAbsolute(env.WT_LANE_HOST_STATE ?? '') ? env.WT_LANE_HOST_STATE : win32.join(env.LOCALAPPDATA || win32.join(homeDir, 'AppData', 'Local'), 'wt-lane-host')
  const forbidden = (item) => {
    const target = canonicalPath(item, fs, win32)
    const homeReal = canonicalPath(homeDir, fs, win32)
    const hostReal = canonicalPath(hostState, fs, win32)
    return target === win32.parse(target).root || withinOnDisk(homeReal, target, win32.sep) || withinOnDisk(target, hostReal, win32.sep) || withinOnDisk(hostReal, target, win32.sep)
  }
  const dirArgs = args.flatMap((value, index) => args[index - 1] === '--dir' ? [win32.resolve(base, value)] : [])
  const codexHome = win32.join(homeDir, '.codex')
  const selected = profile === 'codex'
    ? { writable: [env.CLAUDE_PLUGIN_DATA].filter((item) => win32.isAbsolute(item ?? '')), writableRemap: [{ inside: codexHome }] }
    : { writable: readonlyCwd ? [] : dirArgs, writableRemap: ['share', 'cache', 'state'].map((kind) => ({ inside: win32.join(xdgDir(`XDG_${kind.toUpperCase()}_HOME`, kind === 'cache' ? '.cache' : '.local/' + kind), 'opencode') })) }
  const dotGit = fs.readText(win32.join(base, '.git'))?.split('\n').find((line) => line.startsWith('gitdir:'))
  const git = { writable: dotGit ? [win32.resolve(base, dotGit.slice('gitdir:'.length).trim())] : [] }
  const extras = { writable: String(optionEnv[LANE_SANDBOX_WRITE_ENV] ?? '').split(win32.delimiter).filter(Boolean).map((item) => item.startsWith('~/') ? win32.join(homeDir, item.slice(2)) : item).filter((item) => win32.isAbsolute(item)) }
  const runtimeDir = win32.isAbsolute(os.tmpdir()) ? win32.join(os.tmpdir(), 'wt-lane-sandbox-preflight') : null
  const roots = effectiveWritableRoots({ workdir: [base], selected, git, env, paths, extras, runtimeDir, readonlyCwd, suiteLock: win32.join(state, 'wt-suite-lock') })
  return roots.filter((item) => item && win32.isAbsolute(item) && !forbidden(item))
}

// Preflight for host output paths, using exactly the same root collector as the final sandbox plan.
export function laneWritableForLaunch({ cwd, args = [], profile = 'opencode', env = process.env, optionEnv = process.env, paths = {}, readonlyCwd = false, fs = realFs, platform = process.platform } = {}) {
  if (platform === 'win32') return laneWritablePredicate(windowsWritableRoots({ cwd, args, profile, env, optionEnv, paths, readonlyCwd, fs }), fs, win32)
  const base = path.resolve(cwd)
  const runtimeDir = path.join(os.tmpdir(), 'wt-lane-sandbox-preflight')
  const selected = PROFILES[profile]({ env, args, fs, runtimeDir, readonlyCwd, base, trustedRead: () => null })
  const git = gitPaths(base, env, fs)
  const extras = operatorExtras(optionEnv, env, fs)
  const roots = effectiveWritableRoots({ workdir: [base], selected, git, env, paths, extras, runtimeDir, readonlyCwd })
    .filter((item) => item && !isForbiddenPath(item, env, fs))
  return laneWritablePredicate(roots, fs)
}

// A writable bind that contains (or sits inside) a CLI's config/auth location would override its
// read-only bind: bwrap applies binds in order and the writable ones come after. Refused, never
// silently dropped, so the operator sees which entry did it.
function refuseProtectedOverlap(writable, protectedPaths, fs) {
  for (const bind of writable) {
    const root = canonicalPath(bind, fs)
    for (const guarded of protectedPaths) {
      const target = canonicalPath(guarded, fs)
      if (withinOnDisk(target, root) || withinOnDisk(root, target)) throw new LaneSandboxRefusal(`refusing writable bind ${bind}: it overlaps ${guarded}, which a lane must not be able to change`)
    }
  }
}

// Late mounts override earlier binds. A directory overlay must never contain a writable mount,
// private remap target, or protected location. Narrow only executable mounts; other late overlays
// (git pointer files and private cache packages) must already satisfy the same invariant.
function safeLateOverlays(executableMounts, otherOverlays, guarded, env, fs) {
  const collision = (overlay) => guarded.find((target) => withinOnDisk(canonicalPath(target, fs), canonicalPath(overlay, fs)))
  for (const overlay of otherOverlays) {
    const target = collision(overlay)
    if (target) throw new LaneSandboxRefusal(`refusing late read-only overlay ${overlay}: it covers ${target}`)
  }
  return executableMounts.flatMap(({ directory, fallback, executable }) => {
    if (isForbiddenPath(directory, env, fs)) throw new LaneSandboxRefusal(`refusing executable ${executable}: target directory ${directory} cannot be mounted`)
    const target = collision(directory)
    if (!target) return [directory]
    for (const narrowed of fallback) {
      const blocker = collision(narrowed)
      if (blocker || isForbiddenPath(narrowed, env, fs)) throw new LaneSandboxRefusal(`refusing executable ${executable}: overlay ${narrowed} collides with ${blocker ?? target ?? home(env)}`)
    }
    return fallback
  })
}

// A bind at the real target does not recreate an invocation beneath a private remap (nor
// beneath an aliased HOME). Mount the selected entry point at its PATH spelling last.
// Only the real target matters: the plan creates its own first PATH entry. Confirm the last
// covering bind still exposes the real file at its original spelling, then create the link AFTER
// all binds. Unlike a simulation of shell lookup, this has no symlink-chain or PATH fallback case.
function refuseCoveredCodex(prefix, real, fs) {
  let source = null
  for (let i = 0; i < prefix.length; i += 1) {
    if (!['--bind', '--bind-try', '--ro-bind', '--ro-bind-try'].includes(prefix[i])) continue
    const from = prefix[i + 1]; const to = prefix[i + 2]
    if (withinOnDisk(real, to) && (fs.isFile(from) || fs.isDir(from) || SYSTEM_READ_ONLY.includes(from))) {
      source = path.join(from, path.relative(to, real))
    }
  }
  if (source !== real) throw new LaneSandboxRefusal(`refusing executable ${real}: its realpath is covered by a later bind or is not mounted`)
}

// The egress log is written by the host-side proxy; a path the lane can write (or plant a symlink
// in) would let it aim that write at any file of the owner.
function refuseLaneWritableLog(egressLog, laneWritable, roots, fs) {
  if (!egressLog) return null
  const lexical = path.resolve(egressLog)
  const canonical = canonicalPath(egressLog, fs)
  if (roots.some((root) => withinOnDisk(lexical, path.resolve(root))) || laneWritable(egressLog) || laneWritable(canonical) || canonical.includes('/.claude/worktrees/')) {
    throw new LaneSandboxRefusal(`refusing ${LANE_EGRESS_LOG_ENV}=${egressLog}: it lies under a path the lane can write`)
  }
  if (fs === realFs) {
    for (let component = path.dirname(lexical); component !== '/'; component = path.dirname(component)) {
      if (existsSync(path.join(component, '.git'))) throw new LaneSandboxRefusal(`refusing ${LANE_EGRESS_LOG_ENV}=${egressLog}: log lies inside a working tree`)
      let info
      try { info = lstatSync(component) } catch { continue }
      if (info.isSymbolicLink()) {
        const parent = statSync(path.dirname(component))
        if (parent.uid !== 0 || (parent.mode & 0o022)) throw new LaneSandboxRefusal(`refusing ${LANE_EGRESS_LOG_ENV}=${egressLog}: writable parent symlink ${component}`)
      }
    }
  }
  return canonical
}

function reportBridgeExit(diagnostics, message) {
  try {
    if (typeof diagnostics === 'number') writeSync(diagnostics, message)
    else process.stderr.write(message)
  } catch { /* nowhere left to say it */ }
}

function authClaims(token) {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const account = claims['https://api.openai.com/auth']?.chatgpt_account_id ?? claims.chatgpt_account_id
    return typeof account === 'string' && typeof claims.sub === 'string' ? `${account}:${claims.sub}` : null
  } catch { return null }
}

function guardedAuthRead(file) {
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) throw new Error('protected auth read unavailable')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || stat.size > 65_536) throw new Error('auth is not a private regular file <= 64 KiB')
    return readFileSync(fd, 'utf8')
  } finally { closeSync(fd) }
}

function writeBackCodexAuth(wb, snapshot, diagnostics) {
  const reject = (reason) => reportBridgeExit(diagnostics, `workflow-toolbox: codex auth writeback skipped (${reason})\n`)
  try {
    if (!snapshot) return reject('no prepare-time auth snapshot')
    const freshText = guardedAuthRead(wb.from)
    if (freshText === snapshot) return
    const original = JSON.parse(snapshot)
    const fresh = JSON.parse(freshText)
    const host = JSON.parse(guardedAuthRead(wb.to))
    if (!host.tokens || !original.tokens || !fresh.tokens) return reject('missing token set')
    for (const key of ['id_token', 'access_token']) {
      const identity = authClaims(original.tokens[key])
      if (!identity || authClaims(fresh.tokens[key]) !== identity || authClaims(host.tokens[key]) !== identity) return reject(`${key} identity changed`)
    }
    if (!constants.O_NOFOLLOW) return reject('protected auth write unavailable')
    const merged = { ...host, tokens: { ...host.tokens } }
    for (const key of ['id_token', 'access_token', 'refresh_token']) {
      if (typeof fresh.tokens[key] === 'string') merged.tokens[key] = fresh.tokens[key]
    }
    if (fresh.last_refresh !== undefined) merged.last_refresh = fresh.last_refresh
    const fd = openSync(wb.to, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW)
    try { writeSync(fd, JSON.stringify(merged)) } finally { closeSync(fd) }
  } catch (error) { reject(error.message) }
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
  const relays = []
  try {
    for (const bridge of bridges) {
      const relay = spawnFn(bridge.command, bridge.args, { stdio: ['ignore', 'ignore', typeof diagnostics === 'number' ? diagnostics : 'inherit'], detached: false })
      relays.push(relay)
      if (typeof relay?.once === 'function') {
        relay.once('exit', (code, signal) => {
          if (!state.disposed) reportBridgeExit(diagnostics, `workflow-toolbox: lane ${bridge.proxy ? 'egress proxy' : 'endpoint relay'} exited (code ${code ?? 'none'}, signal ${signal ?? 'none'}); the sandboxed lane has lost that route\n`)
        })
      }
    }
    const insideCommands = bridges.map((bridge) => `${shPosix(socat)} TCP4-LISTEN:${bridge.port},bind=${bridge.host},fork,reuseaddr UNIX-CONNECT:${shPosix(bridge.sock)} >/dev/null 2>&1 &`)
  // A host bridge's unix socket appears asynchronously. Wait for it BEFORE the sandbox starts, or
  // the lane's first connection races the socket into existence and is refused (measured).
    const deadline = Date.now() + 3_000
    for (const { sock } of bridges) {
      while (!fs.exists(sock) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
    const missing = bridges.filter(({ sock }) => !fs.exists(sock))
    if (missing.length) {
      const names = missing.map((bridge) => (bridge.proxy ? 'egress proxy' : 'relay to ' + bridge.host + ':' + bridge.port)).join(', ')
      throw new LaneSandboxRefusal(`lane ${names} did not start within 3 s; refusing to launch a lane whose route does not exist`)
    }
    return { relays, insideCommands }
  } catch (error) {
    state.disposed = true
    for (const relay of relays) { try { relay.kill('SIGKILL') } catch { /* already gone */ } }
    throw error
  }
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
export function resolveLaneSandbox({ profile, bin, args = [], cwd, env = {}, optionEnv = process.env, paths = {}, platform = process.platform, execPath = process.execPath, bwrap, socat, find, probe = probeBwrap, fs = realFs, spawnFn = spawn, runtimeParent, readonlyCwd = false, diagnostics } = {}) {
  const { bwrapPath, socatPath } = hostSandboxExecutables(platform, optionEnv, bwrap, socat)
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
  const selectedCommand = profile === 'codex' ? findOnPath('codex', env.PATH, fs) : null
  if (profile === 'codex' && !selectedCommand) throw new LaneSandboxRefusal('refusing executable codex: no executable selected on an absolute PATH entry')
  const codexReal = selectedCommand ? fs.realpath(selectedCommand) : null
  if (selectedCommand && (!codexReal || !fs.isFile(codexReal) || (fs.isExecutable && !fs.isExecutable(codexReal)))) {
    throw new LaneSandboxRefusal(`refusing executable ${selectedCommand}: its realpath is missing or not executable`)
  }

  const parent = runtimeParent ?? (path.isAbsolute(optionEnv.XDG_RUNTIME_DIR ?? '') ? optionEnv.XDG_RUNTIME_DIR : os.tmpdir())
  fs.ensureDir(parent)
  const runtimeDir = path.join(parent, `wt-lane-sandbox-${process.pid}-${randomUUID().slice(0, 8)}`)
  const bridgeState = { disposed: false }
  let bridge
  try {
  fs.ensureDir(runtimeDir)
   const extras = operatorExtras(optionEnv, env, fs)
   const registry = fs === realFs ? registeredLaneRoots(optionEnv) : { roots: [], present: true }
   let laneWritable
   let sourceWritable
   const rejectedConfigs = new Set()
   const trustedRead = (file) => checkedConfigRead(file, fs, laneWritable, registry.roots, rejectedConfigs)
   const trustedAuthRead = (file) => checkedConfigRead(file, fs, sourceWritable, registry.roots, rejectedConfigs)
    const selected = PROFILES[profile]({ env, args, fs, runtimeDir, readonlyCwd, base, trustedRead, trustedAuthRead })
  const git = workdir.length ? gitPaths(workdir[0], env, fs) : { readable: [], writable: [], overlaysRo: [] }
  for (const overlay of git.overlaysRo) fs.ensureFile(overlay)

  fs.ensureDir(suiteLockDir(env))
  // A read-only role (observer, second-opinion) gets its working directory bound read-only (H5).
  const toolchain = toolchainPaths({ env, execPath, fs })
  const executableMounts = [...toolchain.executableMounts, ...executableMount(bin, fs), ...(codexReal ? [executableMount(codexReal, fs)[0]] : [])]
   const rawWritable = effectiveWritableRoots({ workdir, selected, git, env, paths, extras, runtimeDir, readonlyCwd })
   const writable = rawWritable.slice(0, -(selected.writableRemap?.length ?? 0) - 1).filter((item) => item && !isForbiddenPath(item, env, fs))
   laneWritable = laneWritablePredicate([...writable, ...(selected.writableRemap ?? []).map(({ inside }) => inside), runtimeDir], fs)
   sourceWritable = laneWritablePredicate([...writable, runtimeDir], fs)
   const rawReadable = [...toolchain.readable, ...(typeof selected.readable === 'function' ? selected.readable() : selected.readable ?? []), ...git.readable, ...(readonlyCwd ? workdir : []), ...(paths.readable ?? []), ...extras.readable]
  // Validate only paths that survive the same forbidden-path filtering as the bwrap argv.
  // Discarded paths (including a spelling that resolves to HOME) are not binds.
  const keptReadable = rawReadable.filter((item) => item && !isForbiddenPath(item, env, fs))
  for (const item of [...keptReadable, ...writable, ...(selected.writableRemap ?? []).flatMap(({ inside, outside }) => [inside, outside]), ...(selected.readOnlyOverlaysRemap ?? []).flatMap(({ inside, outside }) => [inside, outside]), ...(selected.readOnlyOverlays ?? []), ...git.overlaysRo]) {
    if (item) bindPath(item)
  }
  // The root/$HOME/ancestor refusal covers EVERY computed bind, not only the operator extras (H2).
  const executableLinks = [...toolchain.executableSymlinks, ...executableSymlinks(bin, fs)]
    .filter(({ target, link }) => {
      if (isForbiddenPath(link, env, fs)) return false
      if (isForbiddenPath(target, env, fs)) throw new LaneSandboxRefusal(`refusing executable ${link}: link target ${target} cannot be mounted`)
      return true
    })
  refuseProtectedOverlap(writable, selected.protectedPaths ?? [], fs)
  // Everything the lane can write: its writable binds and the per-run runtime dir (private remaps,
  // bridge sockets). Configuration found there never feeds the allow-list, and no log goes there.
  const egressLog = optionEnv[LANE_EGRESS_LOG_ENV]
   const canonicalLog = refuseLaneWritableLog(egressLog, laneWritable, [...writable, runtimeDir], fs)

  const planned = selected.network(laneWritable)
  const network = socatPath ? planned : { ...planned, endpoints: [], hosts: [] }
  const { endpoints } = network
  const socketDir = endpoints.length || network.hosts.length ? path.join(runtimeDir, 'net') : null
  if (socketDir) fs.ensureDir(socketDir)
  const otherOverlays = [...(selected.readOnlyOverlays ?? []), ...git.overlaysRo, ...(selected.readOnlyOverlaysRemap ?? []).map(({ inside }) => inside)]
  const guarded = [...writable, ...(selected.writableRemap ?? []).map(({ inside }) => inside), ...(selected.protectedPaths ?? []), ...(socketDir ? [socketDir] : [])]
  if (codexReal) {
    const collision = [...guarded, ...keptReadable, ...otherOverlays].find((item) => {
      const a = canonicalPath(item, fs); const b = canonicalPath(CODEX_PATH_DIR, fs)
      return withinOnDisk(a, b) || withinOnDisk(b, a)
    })
    if (collision) throw new LaneSandboxRefusal(`refusing executable ${codexReal}: dedicated PATH directory ${CODEX_PATH_DIR} overlaps ${collision}`)
  }
  const executableOverlays = safeLateOverlays(executableMounts, otherOverlays, guarded, env, fs)
  const readable = [...keptReadable, ...executableOverlays].filter((item) => item && !isForbiddenPath(item, env, fs))
  const bindings = [...readable, ...writable, ...(selected.readOnlyOverlays ?? []), ...git.overlaysRo].map((item) => ({ inside: item, outside: item }))
    .concat(selected.writableRemap ?? [], selected.readOnlyOverlaysRemap ?? [])
  const masks = socketMasks(bindings, socketDir, fs, optionEnv.PATH, find)
   const bridges = socketDir ? networkBridges({ network, socketDir, socat: socatPath, execPath, egressLog: canonicalLog }) : []
  const prefix = sandboxArguments({
    readable, writable, writableRemap: selected.writableRemap ?? [],
    executableSymlinks: executableLinks,
    // Executable directories land late only if they cannot cover a writable/private/protected path.
    readOnlyOverlays: [...(selected.readOnlyOverlays ?? []), ...git.overlaysRo, ...executableOverlays],
    readOnlyOverlaysRemap: selected.readOnlyOverlaysRemap ?? [],
    codexReal, codexPath: codexReal ? [CODEX_PATH_DIR, ...String(env.PATH ?? '').split(path.delimiter).filter((entry) => path.isAbsolute(entry))].join(path.delimiter) : null,
     env, chdir: workdir[0] ?? home(env), fs, socketDir, masks,
  })
  if (codexReal) refuseCoveredCodex(prefix, codexReal, fs)
  if (selected.codexHome) prefix.push('--setenv', 'CODEX_HOME', selected.codexHome)
  prefix.push(...proxyEnvironment(bridges.find((item) => item.proxy)))
  bridge = startBridges({ bridges, fs, spawnFn, socat: socatPath, diagnostics, state: bridgeState })
  // Bridge readiness needs only the network plan and socket directory, never a copied profile file.
  selected.prepare()
  let authSnapshot = null
  if (selected.authWriteback) {
    try { authSnapshot = guardedAuthRead(selected.authWriteback.to) } catch { /* writeback rejects later */ }
  }

  const refusedNote = extras.refused.length ? `; refused ${LANE_SANDBOX_READ_ENV}/${LANE_SANDBOX_WRITE_ENV} entries ${extras.refused.join(', ')}` : ''
   const netNote = networkNote({ network: { ...network, unreadable: [...(network.unreadable ?? []), ...rejectedConfigs] }, bridges, socat: socatPath })
   const registryNote = registry.present ? '' : '; registered lane worktree index absent (registered-root clause skipped)'
  // Both the writable AND the readable sets are recorded: a secret leak would come from a readable
  // bind, so a reader can audit exactly what was exposed (LOW 2).
   const line = `lane sandbox: bwrap (${profile}; writable ${[...new Set(writable)].join(', ')}; readable ${[...new Set(readable)].join(', ')}; masked ${masks.length / 3} unix sockets; ${netNote}${registryNote}; extra paths via ${LANE_SANDBOX_READ_ENV}/${LANE_SANDBOX_WRITE_ENV}${refusedNote})`

  // Write the CLI's refreshed credential back to the shared home only if it actually changed inside
  // the per-run home; the shared file stayed read-only during the run (H3). Lives here (host
  // perimeter) so the fs I/O does not count against a non-host module's primitive ratchet.
  const writeBackAuth = () => {
    const wb = selected.authWriteback
    if (!wb) return
    writeBackCodexAuth(wb, authSnapshot, diagnostics)
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

   return { kind: 'bwrap', line, readable, writable, laneWritable, endpoints, egressHosts: bridges.some((item) => item.proxy) ? network.hosts : [], anchor: git.anchor ?? null, authWriteback: selected.authWriteback ?? null, writeBackAuth, wrap, dispose }
  } catch (error) {
    bridgeState.disposed = true
    for (const relay of bridge?.relays ?? []) { try { relay.kill('SIGKILL') } catch { /* already gone */ } }
    try { rmSync(runtimeDir, { recursive: true, force: true }) } catch { /* best effort */ }
    throw error
  }
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
