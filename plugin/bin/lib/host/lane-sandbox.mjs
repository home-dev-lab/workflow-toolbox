import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

// External lanes (opencode, codex) run as the owner with a shell. The environment allow-list keeps
// secrets out of their ENVIRONMENT; this sandbox keeps them out of their FILESYSTEM and process
// table. It is built from an allow-list of binds on an empty root, never by masking secret paths on
// top of the whole filesystem: a path nobody named is absent by construction.

const LANE_SANDBOX_READ_ENV = 'WT_LANE_SANDBOX_READ'
const LANE_SANDBOX_WRITE_ENV = 'WT_LANE_SANDBOX_WRITE'
// `off` runs lanes unsandboxed, and every such launch still says so in one line.
const LANE_SANDBOX_SWITCH_ENV = 'WT_LANE_SANDBOX'

const SYSTEM_READ_ONLY = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/etc', '/nix/store', '/sys']
// /etc entries that are commonly symlinks into /run or /mnt (WSL writes resolv.conf under /mnt/wsl).
const ETC_LINK_TARGETS = ['/etc/resolv.conf', '/etc/hosts', '/etc/ssl/certs/ca-certificates.crt']
const OPENCODE_GLOBAL_CONFIGS = ['opencode.json', 'opencode.jsonc', 'config.json']
const FILE_REFERENCE = /\{file:([^}]+)\}/g
const probeCache = new Map()

const realFs = {
  exists: (file) => existsSync(file),
  realpath: (file) => { try { return realpathSync(file) } catch { return null } },
  isFile: (file) => { try { return statSync(file).isFile() } catch { return false } },
  readText: (file) => { try { return readFileSync(file, 'utf8') } catch { return null } },
  ensureDir: (directory) => { try { mkdirSync(directory, { recursive: true, mode: 0o700 }) } catch { /* bind-try then leaves it private */ } },
}

function probeBwrap(bwrap) {
  if (!probeCache.has(bwrap)) {
    const result = spawnSync(bwrap, ['--ro-bind', '/', '/', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--', 'true'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'ignore', 'pipe'] })
    const detail = result.error?.message ?? String(result.stderr ?? '').trim().split(/\r?\n/)[0]
    const cause = detail || 'exit ' + String(result.status)
    probeCache.set(bwrap, result.status === 0 ? { ok: true } : { ok: false, reason: `${bwrap} cannot create a sandbox here (${cause})` })
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

function argumentValues(args, flags) {
  return args.filter((value, index) => flags.includes(args[index - 1]) && path.isAbsolute(String(value)))
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

const PROFILES = {
  opencode({ env, args, fs }) {
    const configDir = path.join(xdg(env, 'XDG_CONFIG_HOME', '.config'), 'opencode')
    const configFile = absolute(env.OPENCODE_CONFIG).map((file) => path.dirname(file))
    return {
      readable: [configDir, ...opencodeConfigReferences(configDir, env, fs), ...configFile, ...argumentValues(args, ['-f', '--file'])],
      writable: [
        path.join(xdg(env, 'XDG_DATA_HOME', '.local/share'), 'opencode'),
        path.join(xdg(env, 'XDG_CACHE_HOME', '.cache'), 'opencode'),
        path.join(xdg(env, 'XDG_STATE_HOME', '.local/state'), 'opencode'),
        ...argumentValues(args, ['--dir']),
      ],
      readOnlyOverlays: [],
    }
  },
  codex({ env, fs }) {
    const codexHome = path.join(home(env), '.codex')
    return {
      readable: executableBinds(findOnPath('codex', env.PATH, fs), fs),
      writable: [codexHome, ...absolute(env.CLAUDE_PLUGIN_DATA)],
      // Written back by a lane, these would run OUTSIDE the sandbox the next time the owner uses codex.
      readOnlyOverlays: [path.join(codexHome, 'packages'), path.join(codexHome, 'config.toml')],
    }
  },
}

// The machine-wide suite lock (lib/suite-lock.mjs, Linux default location) serialises every test
// suite on the host, a lane's included; it is shared read-write so a lane waits like anyone else.
// lane-sandbox.test.ts locks this path against readSuiteLock's own resolution.
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
// main repository's `.git`. The private gitdir is writable (index refresh), the shared store is not.
function gitPaths(directory, fs) {
  const line = (fs.readText(path.join(directory, '.git')) ?? '').split('\n').find((entry) => entry.startsWith('gitdir:'))
  if (!line) return { readable: [], writable: [] }
  const gitdir = path.resolve(directory, line.slice('gitdir:'.length).trim())
  const common = fs.readText(path.join(gitdir, 'commondir'))
  return { readable: common ? [path.resolve(gitdir, common.trim())] : [], writable: [gitdir] }
}

// An operator extra that is the filesystem root, the home directory or one of its ancestors would
// re-expose everything the sandbox exists to hide: it is refused and named, never applied.
function isRefusedExtra(candidate, env) {
  const target = path.resolve(candidate)
  const homeDir = path.resolve(home(env))
  return target === path.parse(target).root || homeDir === target || homeDir.startsWith(`${target}${path.sep}`)
}

function operatorExtras(optionEnv, env) {
  const refused = []
  const accepted = (name) => String(optionEnv[name] ?? '').split(path.delimiter).map((item) => item.trim()).filter(Boolean)
    .map((item) => (item.startsWith('~/') ? path.join(home(env), item.slice(2)) : item))
    .filter((item) => {
      const ok = path.isAbsolute(item) && !isRefusedExtra(item, env)
      if (!ok) refused.push(item)
      return ok
    })
  return { readable: accepted(LANE_SANDBOX_READ_ENV), writable: accepted(LANE_SANDBOX_WRITE_ENV), refused }
}

function bindArgs(flag, paths) {
  return [...new Set(paths)].flatMap((item) => [flag, item, item])
}

function sandboxArguments({ readable, writable, readOnlyOverlays, env, chdir, fs }) {
  const etcTargets = ETC_LINK_TARGETS.map((file) => fs.realpath(file)).filter((file) => file && !file.startsWith('/etc/') && !file.startsWith('/usr/'))
  return [
    '--die-with-parent', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    ...bindArgs('--ro-bind-try', [...SYSTEM_READ_ONLY, ...etcTargets]),
    '--dir', home(env),
    ...bindArgs('--ro-bind-try', readable),
    ...bindArgs('--bind-try', writable),
    ...bindArgs('--ro-bind-try', readOnlyOverlays),
    '--chdir', chdir,
    '--unsetenv', 'XDG_RUNTIME_DIR', '--unsetenv', 'DBUS_SESSION_BUS_ADDRESS', '--unsetenv', 'SSH_AUTH_SOCK',
    '--setenv', 'TMPDIR', '/tmp', '--setenv', 'TMP', '/tmp', '--setenv', 'TEMP', '/tmp',
    '--setenv', LANE_SANDBOX_SWITCH_ENV, 'bwrap',
  ]
}

function unsandboxed(reason) {
  return { kind: 'none', reason, line: `lane sandbox: none (${reason}); running with the environment allow-list only`, wrap: (bin, args) => [bin, args] }
}

function sandboxAvailability({ optionEnv, platform, bwrap, probe, fs }) {
  if (optionEnv[LANE_SANDBOX_SWITCH_ENV] === 'off') return `disabled by ${LANE_SANDBOX_SWITCH_ENV}=off`
  if (platform !== 'linux') return `bubblewrap sandbox is Linux-only; this host is ${platform}`
  if (!bwrap || !fs.exists(bwrap)) return 'bubblewrap (bwrap) is not installed'
  const probed = probe(bwrap)
  return probed.ok ? null : probed.reason
}

/**
 * Decides how one external-lane child is started. On Linux with a working bubblewrap it returns a
 * plan whose `wrap` puts the command inside the sandbox; anywhere else it returns `kind: 'none'`
 * with the reason, never a silent pass-through. `profile` names the CLI whose own config and
 * credentials are legitimately readable ('opencode' | 'codex'); `paths` adds caller-owned
 * directories (a probe fixture); WT_LANE_SANDBOX_READ / WT_LANE_SANDBOX_WRITE in `optionEnv` add
 * the operator's.
 */
export function resolveLaneSandbox({ profile, bin, args = [], cwd, env = {}, optionEnv = process.env, paths = {}, platform = process.platform, execPath = process.execPath, bwrap, probe = probeBwrap, fs = realFs } = {}) {
  const bwrapPath = bwrap ?? findOnPath('bwrap', optionEnv.PATH, fs) ?? '/usr/bin/bwrap'
  const unavailable = sandboxAvailability({ optionEnv, platform, bwrap: bwrapPath, probe, fs })
  if (unavailable) return unsandboxed(unavailable)
  const selected = PROFILES[profile]({ env, args, fs })
  const extras = operatorExtras(optionEnv, env)
  const workdir = absolute(cwd)
  const git = workdir.length ? gitPaths(workdir[0], fs) : { readable: [], writable: [] }
  const readable = [...toolchainPaths({ env, execPath, fs }), ...executableBinds(bin, fs), ...selected.readable, ...git.readable, ...(paths.readable ?? []), ...extras.readable]
  // Created up front: a bind of a missing directory is skipped, and a private lock serialises nothing.
  fs.ensureDir(suiteLockDir(env))
  const writable = [...workdir, ...selected.writable, ...git.writable, suiteLockDir(env), ...(paths.writable ?? []), ...extras.writable]
  const prefix = sandboxArguments({ readable, writable, readOnlyOverlays: selected.readOnlyOverlays, env, chdir: workdir[0] ?? home(env), fs })
  const refusedNote = extras.refused.length ? `; refused ${LANE_SANDBOX_READ_ENV}/${LANE_SANDBOX_WRITE_ENV} entries ${extras.refused.join(', ')}` : ''
  const line = `lane sandbox: bwrap (${profile}; writable ${[...new Set(writable)].join(', ')}; network shared; extra paths via ${LANE_SANDBOX_READ_ENV}/${LANE_SANDBOX_WRITE_ENV}${refusedNote})`
  return { kind: 'bwrap', line, readable, writable, wrap: (command, commandArgs) => [bwrapPath, [...prefix, '--', command, ...commandArgs]] }
}

const announced = new Set()

// One line per process for an unsandboxed lane, so a reader can always tell sandboxed from not.
export function announceUnsandboxedLane(sandbox, write = (text) => process.stderr.write(text)) {
  if (sandbox.kind !== 'none' || announced.has(sandbox.line)) return
  announced.add(sandbox.line)
  write(`workflow-toolbox: ${sandbox.line}\n`)
}
