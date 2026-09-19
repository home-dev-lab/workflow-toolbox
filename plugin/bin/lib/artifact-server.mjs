import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'
import { processEvidenceStatus } from './lane-supervisor-core.mjs'
import { resolveWorkflowToolboxOption } from './plugin-options.mjs'

export const ARTIFACT_SERVER_ID = 'workflow-toolbox-artifact-server'
export const ARTIFACT_SERVER_VERSION = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version
export const ARTIFACT_PORT_BASE = 48_000
export const ARTIFACT_PORT_RANGE = 1_000
export const ARTIFACT_PORT_ATTEMPTS = 21
export const DEFAULT_DENY_PATTERNS = Object.freeze([
  '.git', '.env*', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', 'credentials*', '*.secret*',
])

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function artifactStateDir(env = process.env, home = homedir(), platform = process.platform) {
  const xdg = nonEmpty(env.XDG_STATE_HOME)
  const base = xdg ?? (platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support')
    : platform === 'win32'
      ? nonEmpty(env.LOCALAPPDATA) ?? path.join(home, 'AppData', 'Local')
      : path.join(home, '.local', 'state'))
  return path.join(base, 'wt-artifact-server')
}

export function artifactDiscoveryPath(env = process.env, home = homedir(), platform = process.platform) {
  return path.join(artifactStateDir(env, home, platform), 'server.json')
}

export function artifactRegistrationsDir(env = process.env, home = homedir(), platform = process.platform) {
  return path.join(artifactStateDir(env, home, platform), 'registrations')
}

export function artifactIntentPath(env = process.env, home = homedir(), platform = process.platform) {
  return path.join(artifactStateDir(env, home, platform), 'intent.json')
}

export function artifactStartupClaimPath(env = process.env, home = homedir(), platform = process.platform) {
  return path.join(artifactStateDir(env, home, platform), 'startup.claim')
}

export function artifactUid() {
  return typeof process.getuid === 'function' ? process.getuid() : userInfo().username
}

// POSIX mode bits are a POSIX contract. On win32 Node reports a synthetic mode (0o666-shaped) with the
// group/other write bits set for every directory, so the `& 0o022` check refused the state directory on
// every Windows machine and the server never started there (measured 2026-09-17, cross-os run 33: the
// monitor's stderr read `artifact server state directory is group- or world-writable`). Ownership and
// access on Windows are ACLs the profile directory already carries; the mode check is not enforced
// there, and that is stated rather than silently passed.
function stateDirModeBitsEnforced(platform = process.platform) {
  return platform !== 'win32'
}

export function ensureSecureStateDir(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const enforceModes = stateDirModeBitsEnforced(platform)
  const stateDir = artifactStateDir(env, options.home, platform)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const info = statSync(stateDir)
  if (!info.isDirectory()) throw new Error('artifact server state path is not a directory')
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error(`artifact server state directory is owned by uid ${info.uid}, expected ${process.getuid()}`)
  }
  if (enforceModes && (info.mode & 0o022) !== 0) throw new Error('artifact server state directory is group- or world-writable')
  if (enforceModes) chmodSync(stateDir, 0o700)
  const registrations = artifactRegistrationsDir(env, options.home, platform)
  mkdirSync(registrations, { recursive: true, mode: 0o700 })
  const registrationInfo = statSync(registrations)
  if (typeof process.getuid === 'function' && registrationInfo.uid !== process.getuid()) {
    throw new Error('artifact server registrations directory is owned by another uid')
  }
  if (enforceModes && (registrationInfo.mode & 0o022) !== 0) throw new Error('artifact server registrations directory is group- or world-writable')
  if (enforceModes) chmodSync(registrations, 0o700)
  return stateDir
}

export function atomicWriteJson(destination, value) {
  const dir = path.dirname(destination)
  const temporary = path.join(dir, `.${path.basename(destination)}.tmp-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, destination)
}

export function deriveArtifactPort(username = userInfo().username) {
  const digest = createHash('sha256').update(username).digest()
  return ARTIFACT_PORT_BASE + (digest.readUInt32BE(0) % ARTIFACT_PORT_RANGE)
}

function artifactPathHash(canonical) {
  return createHash('sha256').update(canonical).digest('hex')
}

export function assignArtifactMounts(roots, assignments = new Map(), hash = artifactPathHash) {
  const usedNames = new Map()
  for (const [canonical, name] of assignments) {
    const previous = usedNames.get(name)
    if (previous && previous !== canonical) throw new Error(`duplicate persisted artifact mount name: ${name}`)
    usedNames.set(name, canonical)
  }

  const uniqueRoots = new Map()
  for (const root of roots) {
    const current = uniqueRoots.get(root.canonical)
    if (current) {
      if (Array.isArray(current.deny) && Array.isArray(root.deny)) current.deny = [...new Set([...current.deny, ...root.deny])]
    } else {
      uniqueRoots.set(root.canonical, { ...root })
    }
  }

  for (const root of uniqueRoots.values()) {
    if (assignments.has(root.canonical)) continue
    let name = root.name
    if (usedNames.has(name)) {
      const digest = hash(root.canonical)
      if (typeof digest !== 'string' || digest.length < 6 || !/^[A-Za-z0-9._-]+$/.test(digest)) {
        throw new Error(`cannot assign artifact mount for ${root.canonical}: invalid path hash`)
      }
      let length = 6
      do {
        name = `${root.name}-${digest.slice(0, length)}`
        length += 1
      } while (usedNames.has(name) && length <= digest.length)
      if (usedNames.has(name)) throw new Error(`cannot assign unique artifact mount for ${root.canonical}`)
    }
    assignments.set(root.canonical, name)
    usedNames.set(name, root.canonical)
  }

  return [...uniqueRoots.values()]
    .map((root) => ({ ...root, name: assignments.get(root.canonical) }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function configuredArtifactPort(env = process.env) {
  const raw = resolveWorkflowToolboxOption('artifact_server_port', { env }).value
  const port = raw === null ? deriveArtifactPort() : Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('WT_ARTIFACT_SERVER_PORT must be an integer from 1 to 65535')
  }
  return port
}

export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export function registrationPidStatus(pid, options = {}) {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    const signal = options.signal ?? process.kill.bind(process)
    let signalResult = 'returned'
    try { signal(pid, 0) } catch (error) {
      signalResult = `threw:${error?.code ?? 'unknown'}`
      if (error?.code === 'ESRCH') {
        options.diagnostic?.({ signal: signalResult, processTable: { status: 'not-read', raw: null, elapsedMs: 0 } })
        return 'gone'
      }
    }
    let processTable
    const status = processEvidenceStatus(pid, { ...options, platform, diagnostic: (value) => { processTable = value } })
    options.diagnostic?.({ signal: signalResult, processTable })
    return status
  }
  return pidAlive(pid) ? 'running' : 'gone'
}

export function pathIsUnder(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function validRoot(value) {
  return value && typeof value === 'object' && typeof value.name === 'string' &&
    /^[A-Za-z0-9._-]+$/.test(value.name) && typeof value.path === 'string' && path.isAbsolute(value.path)
}

export function normalizeRoots(roots) {
  const names = new Set()
  return roots.map((root) => {
    if (!validRoot(root)) throw new Error('root names may contain only letters, numbers, dot, underscore, and dash')
    if (names.has(root.name)) throw new Error(`duplicate root name: ${root.name}`)
    names.add(root.name)
    return { name: root.name, path: path.resolve(root.path) }
  })
}

function projectRoot(cwd, env) {
  const testRoot = env.WT_ARTIFACT_SERVER_TEST_MODE === '1' ? nonEmpty(env.WT_ARTIFACT_SERVER_TEST_GIT_ROOT) : null
  if (testRoot) return realpathSync(testRoot)
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  return result.status === 0 && path.isAbsolute(result.stdout.trim()) ? result.stdout.trim() : path.resolve(cwd)
}

export function configuredRoots(env = process.env, cwd = process.cwd()) {
  const configured = resolveWorkflowToolboxOption('artifact_server_roots', { env })
  if (configured.value !== null) {
    const separator = configured.source === 'plugin option' ? /[\n,]/ : path.delimiter
    const entries = configured.value.split(separator).map((entry) => entry.trim()).filter(Boolean)
    return normalizeRoots(entries.map((entry) => {
      const equals = entry.indexOf('=')
      const rawPath = equals < 0 ? entry : entry.slice(equals + 1)
      const resolved = path.resolve(cwd, rawPath)
      return { name: equals < 0 ? path.basename(resolved) : entry.slice(0, equals), path: resolved }
    }))
  }
  const root = projectRoot(cwd, env)
  const projectName = path.basename(root).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
  return normalizeRoots([
    { name: `${projectName}-reports`, path: path.join(root, '.claude', 'reports') },
    { name: `${projectName}-worktrees`, path: path.join(root, '.claude', 'worktrees') },
  ].filter((entry) => existsSync(entry.path)))
}

function parseDiscovery(text) {
  let value
  try { value = JSON.parse(text) } catch { return null }
  if (!value || typeof value !== 'object' || typeof value.version !== 'string') return null
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) return null
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return null
  if (value.baseUrl !== `http://localhost:${value.port}`) return null
  if (value.remoteUrl !== null && typeof value.remoteUrl !== 'string') return null
  if (!Array.isArray(value.roots) || !value.roots.every(validRoot)) return null
  if (typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))) return null
  return value
}

export function readArtifactDiscovery(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  try {
    const discoveryPath = artifactDiscoveryPath(env, options.home, options.platform)
    const info = statSync(discoveryPath)
    if (!info.isFile() || (platform !== 'win32' && (info.mode & 0o777) !== 0o600)) return null
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return null
    return parseDiscovery(readFileSync(discoveryPath, 'utf8'))
  } catch {
    return null
  }
}

export function parseTailscaleServeUrl(served, dnsName, port) {
  if (!dnsName || !Number.isInteger(port)) return null
  let endpoint = null
  const candidates = new Set()
  for (const line of served.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('https://')) {
      try {
        const parsed = new URL(trimmed.split(/\s+/, 1)[0])
        endpoint = parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === dnsName.toLowerCase() &&
          parsed.pathname === '/' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
          ? parsed.origin
          : null
      } catch { endpoint = null }
      continue
    }
    const mapping = /^\|--\s+(\/\S*)\s+proxy\s+(http:\/\/127\.0\.0\.1:\d+)\/?\s*$/.exec(trimmed)
    if (!endpoint || !mapping || mapping[2] !== `http://127.0.0.1:${port}`) continue
    try {
      const mounted = new URL(mapping[1], `${endpoint}/`)
      if (mounted.origin !== endpoint || mounted.search || mounted.hash || mounted.pathname.split('/').includes('..')) continue
      candidates.add(mounted.pathname === '/' ? endpoint : `${endpoint}${mounted.pathname.replace(/\/$/, '')}`)
    } catch {}
  }
  return candidates.size === 1 ? [...candidates][0] : null
}

export function artifactUrlResult(absPath, options = {}) {
  if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) return { url: null, reason: 'path must be absolute' }
  const discovery = readArtifactDiscovery(options)
  if (discovery === null) return { url: null, reason: 'artifact server discovery file is absent or invalid' }
  if (!pidAlive(discovery.pid)) return { url: null, reason: 'artifact server discovery file is stale' }
  let candidate
  try { candidate = realpathSync(absPath) } catch { return { url: null, reason: 'artifact path does not exist' } }
  const matching = discovery.roots
    .map((root) => {
      try { return { ...root, real: root.path } } catch { return null }
    })
    .filter(Boolean)
    .filter((root) => pathIsUnder(root.real, candidate))
    .sort((left, right) => right.real.length - left.real.length)
  if (matching.length === 0) return { url: null, reason: 'path is outside every artifact server root' }
  const root = matching[0]
  const relative = path.relative(root.real, candidate)
  const encoded = relative === '' ? '' : `/${relative.split(path.sep).map(encodeURIComponent).join('/')}`
  const base = options.remote ? discovery.remoteUrl : discovery.baseUrl
  if (!base) return { url: null, reason: 'artifact server has no remote URL' }
  return { url: `${base}/${encodeURIComponent(root.name)}${encoded}`, reason: null }
}

export function artifactUrl(absPath, options = {}) {
  return artifactUrlResult(absPath, options).url
}

export function detectTailscale(port) {
  const commandTimeoutMs = 5_000
  const run = (command, args) => execFileSync(command, args, {
    encoding: 'utf8', timeout: commandTimeoutMs, stdio: ['ignore', 'pipe', 'ignore'],
  })
  const failureReason = (error, elapsedMs) => {
    const timeout = error?.code === 'ETIMEDOUT' || error?.killed === true ? String(commandTimeoutMs) + 'ms' : 'no'
    const fields = [
      `exit=${Number.isInteger(error?.status) ? error.status : 'none'}`,
      `signal=${error?.signal ?? 'none'}`,
      `code=${error?.code ?? 'none'}`,
      `timeout=${timeout}`,
    ]
    return `configured tailscale binary failed after ${elapsedMs} ms: ${fields.join(', ')}`
  }
  // Tests and managed launchers can pin the binary instead of relying on PATH discovery.
  const configuredCommand = process.env.WT_ARTIFACT_SERVER_TAILSCALE_BINARY
  let command = configuredCommand || 'tailscale'
  let ipOutput
  const startedAt = Date.now()
  let initialError = null
  try {
    ipOutput = run(command, ['ip', '-4'])
  } catch (error) {
    initialError = error
  }
  if (initialError) {
    if (configuredCommand) return {
      ip: null, dnsName: null, remoteUrl: null,
      detection: { status: 'unavailable', reason: failureReason(initialError, Date.now() - startedAt) },
    }
    try {
      const windowsPath = run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        '(Get-Command tailscale.exe -ErrorAction SilentlyContinue).Source',
      ]).trim()
      if (!windowsPath) throw new Error('PowerShell did not resolve tailscale.exe')
      command = process.platform === 'win32' ? windowsPath : run('wslpath', ['-u', windowsPath]).trim()
      if (!command) throw new Error('wslpath did not resolve the Windows executable')
      ipOutput = run(command, ['ip', '-4'])
    } catch {
      return {
        ip: null, dnsName: null, remoteUrl: null,
        detection: { status: 'unavailable', reason: 'could not run tailscale or resolve it through Windows interop' },
      }
    }
  }
  try {
    const ip = ipOutput.trim().split(/\s+/)[0]
    if (!ip) return {
      ip: null, dnsName: null, remoteUrl: null,
      detection: { status: 'no-tailnet', reason: 'tailscale reported no IPv4 address' },
    }
    let dnsName = null
    try {
      const status = JSON.parse(run(command, ['status', '--json']))
      dnsName = typeof status?.Self?.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '') : null
    } catch {}
    let httpsUrl = null
    try {
      httpsUrl = parseTailscaleServeUrl(run(command, ['serve', 'status']), dnsName, port)
    } catch {}
    return {
      ip, dnsName, remoteUrl: httpsUrl ?? `http://${ip}:${port}`,
      detection: { status: 'available', reason: null },
    }
  } catch {
    return {
      ip: null, dnsName: null, remoteUrl: null,
      detection: { status: 'unavailable', reason: 'tailscale returned an unreadable IPv4 result' },
    }
  }
}

export async function probeArtifactServer(port, timeout = process.platform === 'win32' ? 10_000 : 750, expectedUid = artifactUid()) {
  const { request } = await import('node:http')
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/__wt-artifact-server/health', method: 'GET', headers: { Host: `localhost:${port}` }, timeout }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { if (body.length < 16_384) body += chunk })
      response.on('end', () => {
        try {
          const health = JSON.parse(body)
          resolve(response.statusCode === 200 && health.service === ARTIFACT_SERVER_ID && health.uid === expectedUid ? { kind: 'ours', health } : { kind: 'foreign' })
        } catch { resolve({ kind: 'foreign' }) }
      })
    })
    req.once('timeout', () => { req.destroy(); resolve({ kind: 'unknown' }) })
    req.once('error', (error) => resolve(error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH' ? { kind: 'free' } : { kind: 'unknown' }))
    req.end()
  })
}

function globRegex(pattern) {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${source}$`, 'i')
}

export function configuredDenyPatterns(env = process.env) {
  const custom = resolveWorkflowToolboxOption('artifact_server_deny', { env }).value.split(/[\n,]/).map((value) => value.trim()).filter(Boolean)
  return env.WT_ARTIFACT_SERVER_ALLOW_UNSAFE_DENYLIST === '1' ? custom : [...DEFAULT_DENY_PATTERNS, ...custom]
}

export function pathIsDenied(segments, patterns) {
  const matchers = patterns.map(globRegex)
  return segments.filter(Boolean).some((name) => matchers.some((matcher) => matcher.test(name)))
}

export function removeArtifactState(env = process.env) {
  for (const file of [artifactDiscoveryPath(env), artifactIntentPath(env)]) rmSync(file, { force: true })
}
