import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// External lanes (opencode, codex) run as the owner with a shell. The environment allow-list keeps
// secrets out of their ENVIRONMENT; this sandbox keeps them out of their FILESYSTEM, process table
// and NETWORK. It is built from an allow-list of binds on an empty root, never by masking secret
// paths on top of the whole filesystem: a path nobody named is absent by construction. The lane
// runs in its own network namespace (--unshare-net); the one model endpoint it needs is restored by
// a socat relay over a unix socket, so no other host loopback service is reachable.

const LANE_SANDBOX_READ_ENV = 'WT_LANE_SANDBOX_READ'
const LANE_SANDBOX_WRITE_ENV = 'WT_LANE_SANDBOX_WRITE'
// `off` runs lanes unsandboxed, and every such launch still says so in one line.
const LANE_SANDBOX_SWITCH_ENV = 'WT_LANE_SANDBOX'

// /sys is deliberately NOT bound: it would expose host PIDs via cgroup.procs (LOW 5). The lanes do
// not need it. /proc is a fresh --unshare-pid proc, so it shows only the sandbox's own processes.
const SYSTEM_READ_ONLY = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/etc', '/nix/store']
// /etc entries that are commonly symlinks into /run or /mnt (WSL writes resolv.conf under /mnt/wsl).
const ETC_LINK_TARGETS = ['/etc/resolv.conf', '/etc/hosts', '/etc/ssl/certs/ca-certificates.crt']
const OPENCODE_GLOBAL_CONFIGS = ['opencode.json', 'opencode.jsonc', 'config.json']
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

// Loopback endpoints the lane legitimately needs, read from the OpenCode config's provider baseURLs.
function opencodeLoopbackEndpoints(configDir, fs) {
  const endpoints = []
  for (const name of OPENCODE_GLOBAL_CONFIGS) {
    const text = fs.readText(path.join(configDir, name))
    for (const match of text?.matchAll(/"baseURL"\s*:\s*"([^"]+)"/g) ?? []) {
      try {
        const url = new URL(match[1])
        if (LOOPBACK_HOSTS.has(url.hostname)) endpoints.push({ host: url.hostname === 'localhost' ? '127.0.0.1' : url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) })
      } catch { /* a non-URL baseURL is ignored */ }
    }
  }
  return endpoints
}

// A per-run OpenCode home: auth.json and the provider packages/bin are copied or bound read-only, so
// a lane cannot alter the shared cache (775 packages every run loads) or swap the shared auth (M1).
function opencodePrivateHome({ env, fs, runtimeDir }) {
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
  return { writable, readOnlyOverlays, endpoints: opencodeLoopbackEndpoints(path.join(xdg(env, 'XDG_CONFIG_HOME', '.config'), 'opencode'), fs) }
}

const PROFILES = {
  opencode({ env, args, fs, runtimeDir, readonlyCwd, base }) {
    const configDir = path.join(xdg(env, 'XDG_CONFIG_HOME', '.config'), 'opencode')
    const configFile = absolute(env.OPENCODE_CONFIG).map((file) => path.dirname(file))
    const priv = opencodePrivateHome({ env, fs, runtimeDir })
    const dirArgs = argumentValues(args, ['--dir'], base)
    return {
      readable: [configDir, ...opencodeConfigReferences(configDir, env, fs), ...configFile, ...argumentValues(args, ['-f', '--file'], base), ...(readonlyCwd ? dirArgs : [])],
      writableRemap: priv.writable,
      writable: [...(readonlyCwd ? [] : dirArgs)],
      readOnlyOverlaysRemap: priv.readOnlyOverlays.filter((entry) => typeof entry === 'object'),
      readOnlyOverlays: priv.readOnlyOverlays.filter((entry) => typeof entry === 'string'),
      endpoints: priv.endpoints,
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
      codexHome: env.CODEX_HOME ? undefined : privHome,
      authWriteback: { from: path.join(privHome, 'auth.json'), to: path.join(codexHome, 'auth.json') },
      endpoints: [],
    }
  },
}

// The machine-wide suite lock (lib/suite-lock.mjs, Linux default location) serialises every test
// suite on the host, a lane's included; it is shared read-write so a lane waits like anyone else.
const suiteLockDir = (env) => path.join(xdg(env, 'XDG_STATE_HOME', '.local/state'), 'wt-suite-lock')

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

// Host-side socat relays: one per allowed loopback endpoint, each listening on a unix socket bound
// into the sandbox. The sandbox has its own empty loopback (--unshare-net), so nothing else on the
// host loopback is reachable; the bootstrap inside re-listens on the endpoint's address (H4).
function startEndpointBridges({ endpoints, socketDir, fs, spawnFn, socat }) {
  const relays = []
  const insideCommands = []
  const sockets = []
  endpoints.forEach((endpoint, index) => {
    const sock = path.join(socketDir, `ep-${index}.sock`)
    sockets.push(sock)
    const child = spawnFn(socat, [`UNIX-LISTEN:${sock},fork,mode=600`, `TCP4:${endpoint.host}:${endpoint.port}`], { stdio: 'ignore', detached: false })
    relays.push(child)
    insideCommands.push(`${shPosix(socat)} TCP4-LISTEN:${endpoint.port},bind=${endpoint.host},fork,reuseaddr UNIX-CONNECT:${shPosix(sock)} >/dev/null 2>&1 &`)
  })
  // The host relay's UNIX-LISTEN socket appears asynchronously. Wait for it BEFORE the sandbox
  // starts, or the lane's first connection races the socket into existence and is refused (measured).
  const deadline = Date.now() + 3_000
  for (const sock of sockets) {
    while (!fs.exists(sock) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
  return { relays, insideCommands }
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
export function resolveLaneSandbox({ profile, bin, args = [], cwd, env = {}, optionEnv = process.env, paths = {}, platform = process.platform, execPath = process.execPath, bwrap, socat, probe = probeBwrap, fs = realFs, spawnFn = spawn, runtimeParent, readonlyCwd = false } = {}) {
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

  const endpoints = socatPath ? (selected.endpoints ?? []) : []
  const socketDir = endpoints.length ? path.join(runtimeDir, 'net') : null
  if (socketDir) fs.ensureDir(socketDir)
  const bridge = socketDir ? startEndpointBridges({ endpoints, socketDir, fs, spawnFn, socat: socatPath }) : { relays: [], insideCommands: [] }

  const prefix = sandboxArguments({
    readable, writable, writableRemap: selected.writableRemap ?? [],
    // git pointer/config overlays (H1) land read-only on top of the writable gitdir.
    readOnlyOverlays: [...(selected.readOnlyOverlays ?? []), ...git.overlaysRo],
    readOnlyOverlaysRemap: selected.readOnlyOverlaysRemap ?? [],
    env, chdir: workdir[0] ?? home(env), fs, socketDir,
  })
  if (selected.codexHome) prefix.push('--setenv', 'CODEX_HOME', selected.codexHome)

  const refusedNote = extras.refused.length ? `; refused ${LANE_SANDBOX_READ_ENV}/${LANE_SANDBOX_WRITE_ENV} entries ${extras.refused.join(', ')}` : ''
  const endpointList = endpoints.map((e) => `${e.host}:${e.port}`).join(', ')
  let netNote
  if (endpoints.length) netNote = `network isolated, bridged to ${endpointList}`
  else if (socatPath) netNote = 'network isolated (no loopback endpoint configured)'
  else netNote = 'network isolated (socat absent, no bridge)'
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

  return { kind: 'bwrap', line, readable, writable, endpoints, anchor: git.anchor ?? null, authWriteback: selected.authWriteback ?? null, writeBackAuth, wrap, dispose }
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
