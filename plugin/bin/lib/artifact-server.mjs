import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'
import { processEvidenceStatus } from './lane-supervisor-core.mjs'
import { retainProcessOwner, signalProcess } from './host/process-signal-boundary.mjs'
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
  return retainProcessOwner(pid)
}

export function registrationPidStatus(pid, options = {}) {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    const signal = options.signal ?? signalProcess
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
    } catch { /* an unparsable mapping is not a candidate */ }
  }
  return candidates.size === 1 ? [...candidates][0] : null
}

function noRemoteUrlReason(discovery) {
  const reason = discovery.tailnetDetection?.reason
  return typeof reason === 'string' && reason ? `artifact server has no remote URL: ${reason}` : 'artifact server has no remote URL'
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
  if (!base) return { url: null, reason: noRemoteUrlReason(discovery) }
  return { url: `${base}/${encodeURIComponent(root.name)}${encoded}`, reason: null, via: discovery.tailnetVia }
}

export function artifactUrl(absPath, options = {}) {
  return artifactUrlResult(absPath, options).url
}

const TAILSCALE_COMMAND_TIMEOUT_MS = 5_000
const UNAVAILABLE_TAILNET = Object.freeze({ ip: null, dnsName: null, remoteUrl: null })

function runTailscaleCommand(command, args, timeout = TAILSCALE_COMMAND_TIMEOUT_MS) {
  return execFileSync(command, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] })
}

function tailscaleFailureReason(error, elapsedMs) {
  const { status, signal, code, killed } = error ?? {}
  const timeout = code === 'ETIMEDOUT' || killed === true ? `${TAILSCALE_COMMAND_TIMEOUT_MS}ms` : 'no'
  const exit = Number.isInteger(status) ? status : 'none'
  return `configured tailscale binary failed after ${elapsedMs} ms: exit=${exit}, signal=${signal ?? 'none'}, code=${code ?? 'none'}, timeout=${timeout}`
}

function commandErrorCode(error) {
  return error?.code ?? `exit ${error?.status ?? 'none'}`
}

// Off win32, a Windows executable (`.exe`) runs on the Windows side through interop, wherever it was found:
// the configured binary, PATH, or PowerShell. A wrapper script that delegates to Windows cannot be told apart.
function tailscaleVia(command, platform) {
  return platform !== 'win32' && /\.exe$/i.test(command) ? 'windows-interop' : 'native'
}

function resolveWindowsTailscale(run, platform) {
  const windowsPath = run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '(Get-Command tailscale.exe -ErrorAction SilentlyContinue).Source',
  ]).trim()
  if (!windowsPath) throw new Error('PowerShell did not resolve tailscale.exe')
  if (platform === 'win32') return { command: windowsPath, via: 'native' }
  const command = run('wslpath', ['-u', windowsPath]).trim()
  if (!command) throw new Error('wslpath did not resolve the Windows executable')
  return { command, via: 'windows-interop' }
}

// The one place that decides how this host reaches tailscale: the configured binary or `tailscale` on PATH,
// else the Windows executable found through PowerShell. From WSL a Windows executable runs on the Windows side
// (`windows-interop`): its tailnet address and serve routes belong to Windows, not to WSL.
function resolveTailscale(run = runTailscaleCommand) {
  const platform = process.platform
  const configured = process.env.WT_ARTIFACT_SERVER_TAILSCALE_BINARY
  const startedAt = Date.now()
  try {
    const command = configured || 'tailscale'
    return { command, via: tailscaleVia(command, platform), ipOutput: run(command, ['ip', '-4']) }
  } catch (error) {
    if (configured) return { failure: tailscaleFailureReason(error, Date.now() - startedAt) }
  }
  try {
    const { command, via } = resolveWindowsTailscale(run, platform)
    return { command, via, ipOutput: run(command, ['ip', '-4']) }
  } catch {
    return { failure: 'could not run tailscale or resolve it through Windows interop' }
  }
}

// A WSL listener on the Windows tailnet address is not reached by tailnet peers: only a serve route on the
// Windows side forwards to it. So under Windows interop the http form is never offered. A route is called
// missing only when `serve status` was read; an unreadable status offers no URL and no route advice.
export function chooseRemoteUrl({ httpsUrl, readError = null, ip, port, via }) {
  if (httpsUrl) return { remoteUrl: httpsUrl, status: 'available', reason: null }
  if (via !== 'windows-interop') return { remoteUrl: `http://${ip}:${port}`, status: 'available', reason: null }
  if (readError) return { remoteUrl: null, status: 'unavailable', reason: `could not read ${readError}; no URL offered` }
  return {
    remoteUrl: null,
    status: 'no-serve-route',
    reason: `tailscale runs on Windows and has no serve route to this server; tailnet peers do not reach the WSL listener on ${ip}:${port} ` +
      `without a Windows-side forward. Create the route: tailscale serve --bg --set-path /artifacts http://127.0.0.1:${port}, ` +
      'then restart the artifact server (wt-artifact-server restart --force)',
  }
}

function readTailscaleOutput(command, run, args) {
  try {
    return { output: run(command, args) }
  } catch (error) {
    return { error: `tailscale ${args.join(' ')} (${commandErrorCode(error)})` }
  }
}

function readTailscaleDnsName(command, run) {
  const read = readTailscaleOutput(command, run, ['status', '--json'])
  if (read.error) return { dnsName: null, error: read.error }
  try {
    const name = JSON.parse(read.output)?.Self?.DNSName
    return typeof name === 'string' ? { dnsName: name.replace(/\.$/, ''), error: null } : { dnsName: null, error: 'tailscale status --json (no DNS name)' }
  } catch {
    return { dnsName: null, error: 'tailscale status --json (unparsable output)' }
  }
}

function readTailscaleServeRoute(command, run, dns, port) {
  if (dns.error) return { httpsUrl: null, readError: dns.error }
  const read = readTailscaleOutput(command, run, ['serve', 'status'])
  if (read.error) return { httpsUrl: null, readError: read.error }
  return { httpsUrl: parseTailscaleServeUrl(read.output, dns.dnsName, port), readError: null }
}

function detectionFromAddress({ command, via, ipOutput }, port, run) {
  if (typeof ipOutput !== 'string') {
    return { ...UNAVAILABLE_TAILNET, via, detection: { status: 'unavailable', reason: 'tailscale returned an unreadable IPv4 result' } }
  }
  const ip = ipOutput.trim().split(/\s+/)[0]
  if (!ip) return { ...UNAVAILABLE_TAILNET, via, detection: { status: 'no-tailnet', reason: 'tailscale reported no IPv4 address' } }
  const dns = readTailscaleDnsName(command, run)
  const choice = chooseRemoteUrl({ ...readTailscaleServeRoute(command, run, dns, port), ip, port, via })
  return { ip, dnsName: dns.dnsName, remoteUrl: choice.remoteUrl, via, detection: { status: choice.status, reason: choice.reason } }
}

export function detectTailscale(port, run = runTailscaleCommand) {
  const resolved = resolveTailscale(run)
  if (resolved.failure) return { ...UNAVAILABLE_TAILNET, via: null, detection: { status: 'unavailable', reason: resolved.failure } }
  return detectionFromAddress(resolved, port, run)
}

// The tailnet-address listener only matters for the `http://<ip>:<port>` form; an https serve route proxies to
// the loopback listener, so failing to bind the tailnet address never removes it.
export async function listenArtifactTailnet(listen, tailscale, port) {
  if (!tailscale.ip || tailscale.ip === '127.0.0.1') return
  try {
    await listen(tailscale.ip)
  } catch (error) {
    if (tailscale.remoteUrl !== `http://${tailscale.ip}:${port}`) return
    tailscale.remoteUrl = null
    tailscale.detection = { status: 'unavailable', reason: `could not listen on the tailnet address ${tailscale.ip}:${port} (${error?.code ?? 'error'})` }
  }
}

export const ARTIFACT_CHECK_EXIT_CODES = Object.freeze({ reachable: 0, unreachable: 4, unverified: 5 })
const CHECK_HTTP_TIMEOUT_S = 8
const CHECK_PROCESS_TIMEOUT_MS = 10_000

function httpVerdict(status, from) {
  return status >= 200 && status < 400
    ? { verdict: 'reachable', status, from }
    : { verdict: 'unreachable', reason: `HTTP ${status}`, from }
}

function fetchErrorReason(error) {
  if (error?.name === 'TimeoutError') return `no answer within ${CHECK_HTTP_TIMEOUT_S} s`
  const cause = error?.cause ?? {}
  return cause.code ?? cause.message ?? error?.message ?? 'request failed'
}

async function fetchInProcess(url, from) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(CHECK_HTTP_TIMEOUT_S * 1_000) })
    await response.body?.cancel()
    return httpVerdict(response.status, from)
  } catch (error) {
    return { verdict: 'unreachable', reason: fetchErrorReason(error), from }
  }
}

// The URL is a single-quoted PowerShell literal: inside one, only a quote character (ASCII or typographic, which
// PowerShell also treats as a quote) is special, and doubling it is the language's own escape.
export function windowsCheckScript(url, timeoutS = CHECK_HTTP_TIMEOUT_S) {
  const literal = `'${String(url).replace(/['‘’‚‛]/g, '$&$&')}'`
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    `try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec ${timeoutS} -Uri ${literal}; 'STATUS=' + [int]$r.StatusCode } ` +
      "catch { $s = $_.Exception.Response.StatusCode; if ($s) { 'STATUS=' + [int]$s } else { 'ERROR=' + $_.Exception.Message } }",
  ].join('\n')
}

export function parseWindowsCheck(output) {
  const status = /^STATUS=(\d+)\s*$/m.exec(output)
  if (status) return httpVerdict(Number(status[1]), 'windows')
  const failure = /^ERROR=(.*)$/m.exec(output)
  if (failure) return { verdict: 'unreachable', reason: failure[1].trim() || 'request failed', from: 'windows' }
  return { verdict: 'unverified', reason: 'powershell.exe printed no check result' }
}

function fetchThroughWindows(url, run) {
  let output
  try {
    output = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsCheckScript(url)], CHECK_PROCESS_TIMEOUT_MS)
  } catch (error) {
    return { verdict: 'unverified', reason: `powershell.exe did not complete the check (${commandErrorCode(error)})` }
  }
  return parseWindowsCheck(output)
}

const RECORDED_VIAS = new Set(['native', 'windows-interop'])

// Fetch the URL from the side tailscale runs on: a WSL-side request answers a different question than a peer's.
// The side the server recorded when it detected its URL wins; only an older state without it is re-resolved.
export async function checkArtifactUrl(url, options = {}) {
  if (!options.remote) return fetchInProcess(url, 'local')
  const run = options.run ?? runTailscaleCommand
  let via = RECORDED_VIAS.has(options.via) ? options.via : null
  if (via === null) {
    const resolved = resolveTailscale(run)
    if (resolved.failure) return { verdict: 'unverified', reason: `could not determine where tailscale runs: ${resolved.failure}` }
    via = resolved.via
  }
  return via === 'windows-interop' ? fetchThroughWindows(url, run) : fetchInProcess(url, 'native')
}

export function formatArtifactCheck(result) {
  if (result.verdict === 'reachable') return `check: reachable (HTTP ${result.status}, from ${result.from})`
  if (result.verdict === 'unreachable') return `check: unreachable (${result.reason}, from ${result.from})`
  return `check: unverified (${result.reason})`
}

// Keep loopback startup failure separate from the optional tailnet listener.
export async function listenArtifactLoopback(listen, port) {
  try {
    await listen('127.0.0.1')
    return true
  } catch (error) {
    if (error?.code !== 'EADDRINUSE') throw error
    process.stderr.write(`wt-artifact-server: port ${port} is already in use (EADDRINUSE)\n`)
    process.exitCode = 1
    return false
  }
}

export async function probeArtifactServer(port, timeout = process.platform === 'win32' ? 10_000 : 750, expectedUid = artifactUid()) {
  const { request } = await import('node:http')
  return new Promise((resolve) => {
    // agent: false — a probe never reuses a pooled keep-alive socket, which may belong to a server that has since died.
    const req = request({ host: '127.0.0.1', port, path: '/__wt-artifact-server/health', method: 'GET', headers: { Host: `localhost:${port}` }, timeout, agent: false }, (response) => {
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
