#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ARTIFACT_SERVER_ID,
  ARTIFACT_SERVER_VERSION,
  artifactDiscoveryPath,
  artifactIntentPath,
  artifactRegistrationsDir,
  artifactUid,
  artifactUrlResult,
  assignArtifactMounts,
  atomicWriteJson,
  configuredArtifactPort,
  detectTailscale,
  ensureSecureStateDir,
  normalizeRoots,
  pathIsDenied,
  pathIsUnder,
  probeArtifactServer,
  readArtifactDiscovery,
} from './lib/artifact-server.mjs'
import { handleHelpFlag } from './lib/cli-help.mjs'
import { resolveWorkflowToolboxOption } from './lib/plugin-options.mjs'

const HELP = `wt-artifact-server - serve registered artifacts through local or tailnet URLs

Usage:
  wt-artifact-server serve
  wt-artifact-server url <path> [--remote]
  wt-artifact-server status
  wt-artifact-server stop [--force]
  wt-artifact-server restart [--force]

Configuration:
  WT_ARTIFACT_SERVER=0              disable the session monitor
  WT_ARTIFACT_SERVER_PORT           first candidate port (default: per-user 48000-48999)
  WT_ARTIFACT_SERVER_ROOTS          path-delimited name=path or bare-path list
  WT_ARTIFACT_SERVER_IDLE_GRACE_S   dead-session grace (default: 600)
  WT_ARTIFACT_SERVER_DENY           comma-separated additional denied basename patterns

Options:
  --force     stop or restart despite registered sessions
  --remote    print the tailnet URL
  --help, -h  print this text and exit 0
`

const CONTENT_TYPES = new Map(Object.entries({
  '.css': 'text/css; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.pdf': 'application/pdf', '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8', '.webp': 'image/webp', '.xml': 'application/xml; charset=utf-8',
  '.zip': 'application/zip',
}))

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function inlineMarkdown(value) {
  return value.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, '<a href="$2">$1</a>')
}

function tableCells(line) {
  const value = line.trim()
  const cells = []
  let cell = ''
  let delimiterCount = 0
  let inCode = false
  let endedWithDelimiter = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === '\\' && value[index + 1] === '|') {
      cell += '|'
      index += 1
      endedWithDelimiter = false
    } else if (character === '`') {
      cell += character
      inCode = !inCode
      endedWithDelimiter = false
    } else if (character === '|' && !inCode) {
      cells.push(cell.trim())
      cell = ''
      delimiterCount += 1
      endedWithDelimiter = true
    } else {
      cell += character
      endedWithDelimiter = false
    }
  }
  cells.push(cell.trim())
  if (delimiterCount === 0) return null
  if (value.startsWith('|')) cells.shift()
  if (endedWithDelimiter) cells.pop()
  return cells
}

function htmlPage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#202124}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f5f5;padding:1rem;border-radius:.35rem}code{font-family:ui-monospace,monospace}a{color:#0759b6}.table-scroll{overflow-x:auto}table{border-collapse:collapse;min-width:max-content}th,td{border:1px solid #bbb;padding:.35rem .6rem;text-align:left}</style></head><body>${body}</body></html>`
}

function renderMarkdown(source) {
  const lines = escapeHtml(source).split(/\r?\n/)
  const output = []
  let paragraph = []
  let listOpen = false
  let fenceOpen = false
  const flushParagraph = () => {
    if (paragraph.length > 0) output.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`)
    paragraph = []
  }
  const closeList = () => {
    if (listOpen) output.push('</ul>')
    listOpen = false
  }
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    if (/^```/.test(line)) {
      flushParagraph(); closeList(); output.push(fenceOpen ? '</code></pre>' : '<pre><code>'); fenceOpen = !fenceOpen
      continue
    }
    if (fenceOpen) { output.push(`${line}\n`); continue }
    const headers = tableCells(line)
    const separators = tableCells(lines[lineIndex + 1] ?? '')
    if (headers && separators && headers.length === separators.length &&
      separators.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      flushParagraph(); closeList()
      const body = []
      lineIndex += 2
      while (lineIndex < lines.length) {
        const cells = tableCells(lines[lineIndex])
        if (!cells || cells.length > headers.length) break
        while (cells.length < headers.length) cells.push('')
        body.push(`<tr>${cells.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`)
        lineIndex += 1
      }
      output.push(`<div class="table-scroll"><table><thead><tr>${headers.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${body.join('')}</tbody></table></div>`)
      lineIndex -= 1
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      flushParagraph(); closeList(); output.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`)
      continue
    }
    const item = /^[-*+]\s+(.+)$/.exec(line)
    if (item) {
      flushParagraph(); if (!listOpen) output.push('<ul>'); listOpen = true; output.push(`<li>${inlineMarkdown(item[1])}</li>`)
      continue
    }
    if (line.trim() === '') { flushParagraph(); closeList() } else paragraph.push(line)
  }
  flushParagraph(); closeList(); if (fenceOpen) output.push('</code></pre>')
  return htmlPage('Markdown artifact', output.join('\n'))
}

function decodeRequestPath(rawUrl) {
  const rawPath = rawUrl.split('?', 1)[0]
  const segments = []
  try {
    for (const rawSegment of rawPath.split('/')) {
      let decoded = rawSegment
      for (let pass = 0; pass < 3; pass += 1) {
        const next = decodeURIComponent(decoded)
        if (next === decoded) break
        decoded = next
      }
      if (decoded.includes('\0')) return null
      for (const segment of decoded.split(/[\\/]/)) {
        if (segment === '..') return null
        if (segment !== '' && segment !== '.') segments.push(segment)
      }
    }
  } catch { return undefined }
  return segments
}

function send(response, method, statusCode, body, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body)
  response.writeHead(statusCode, {
    'Content-Type': contentType, 'Content-Length': buffer.length, 'X-Content-Type-Options': 'nosniff', ...extraHeaders,
  })
  response.end(method === 'HEAD' ? undefined : buffer)
}

const GENERATED_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
const RAW_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'"
const RICH_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; img-src data:; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'"
const REGISTRATION_OWNERSHIP_MISS_LIMIT = 3

function fileContentType(file) {
  return CONTENT_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream'
}

function richHtml(file) {
  return /^\s*<!--\s*wt-artifact-server:\s*rich\s*-->/i.test(file.toString('utf8', 0, 256))
}

async function directoryPage(root, target, urlSegments) {
  const entries = await readdir(target, { withFileTypes: true })
  const visible = []
  for (const entry of entries) {
    try {
      const canonical = realpathSync(path.join(target, entry.name))
      const relative = path.relative(root.canonical, canonical)
      if (!pathIsUnder(root.canonical, canonical) || pathIsDenied([path.basename(root.canonical), ...relative.split(path.sep)], root.deny)) continue
      visible.push(entry)
    } catch {}
  }
  visible.sort((left, right) => left.name.localeCompare(right.name))
  const requestPath = `/${urlSegments.map(encodeURIComponent).join('/')}/`
  const parent = target === root.canonical ? '' : '<li><a href="../">../</a></li>'
  const items = visible.map((entry) => {
    const suffix = entry.isDirectory() ? '/' : ''
    return `<li><a href="${requestPath}${encodeURIComponent(entry.name)}${suffix}">${escapeHtml(entry.name)}${suffix}</a></li>`
  }).join('\n')
  return htmlPage(`Index of ${requestPath}`, `<h1>Index of ${escapeHtml(requestPath)}</h1><ul>${parent}${items}</ul>`)
}

function idleGraceMs() {
  const seconds = Number(resolveWorkflowToolboxOption('artifact_server_idle_grace_s').value)
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('WT_ARTIFACT_SERVER_IDLE_GRACE_S must be a non-negative number')
  return seconds * 1_000
}

async function serve() {
  ensureSecureStateDir()
  const requestedPort = configuredArtifactPort()
  const tailscale = detectTailscale(requestedPort)
  const registrations = new Map()
  const mountAssignments = new Map()
  let shuttingDown = false
  let discovery
  let pollTimer
  let ownershipMisses = 0
  let noLiveSince = Date.now()
  const servers = []

  const liveRoots = () => {
    const candidates = []
    for (const [registrationId, registration] of registrations) {
      if (!registration.live) continue
      for (const root of registration.roots) candidates.push({ ...root, registrationId, deny: registration.deny })
    }
    return assignArtifactMounts(candidates, mountAssignments)
  }

  const writeDiscovery = (roots = liveRoots()) => {
    if (!discovery) return
    discovery.roots = roots.map((root) => ({ name: root.name, path: root.canonical }))
    discovery.mounts = [...mountAssignments].map(([canonical, name]) => ({ name, path: canonical }))
    atomicWriteJson(artifactDiscoveryPath(), discovery)
  }

  const readRegistration = (file) => {
    const registrationPath = path.join(artifactRegistrationsDir(), file)
    const info = statSync(registrationPath)
    if (!info.isFile() || (info.mode & 0o777) !== 0o600) throw new Error('registration must be a mode-0600 file')
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('registration is owned by another uid')
    const value = JSON.parse(readFileSync(registrationPath, 'utf8'))
    if (!value || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !Array.isArray(value.roots) ||
      !Array.isArray(value.deny) || !value.deny.every((item) => typeof item === 'string') ||
      typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))) throw new Error('invalid registration')
    const roots = normalizeRoots(value.roots).map((root) => ({
      name: root.name, declared: root.path, canonical: realpathSync(root.path),
    }))
    return { pid: value.pid, roots, deny: value.deny, live: false, deadAt: null }
  }

  const scanRegistrations = async () => {
    if (shuttingDown) return
    const files = new Set(readdirSync(artifactRegistrationsDir()).filter((file) => file.endsWith('.json')))
    let cleanRemoval = false
    for (const [file, registration] of registrations) {
      if (!files.has(file)) {
        if (registration.live) cleanRemoval = true
        registrations.delete(file)
      }
    }
    for (const file of files) {
      if (!registrations.has(file)) {
        try { registrations.set(file, readRegistration(file)) } catch {}
      }
    }
    const now = Date.now()
    let liveCount = 0
    let nextDeadline = Infinity
    for (const [file, registration] of registrations) {
      registration.live = false
      try {
        process.kill(registration.pid, 0)
        registration.live = true
        registration.deadAt = null
        liveCount += 1
      } catch (error) {
        if (error?.code === 'EPERM') {
          registration.live = true
          registration.deadAt = null
          liveCount += 1
        } else {
          registration.deadAt ??= now
          nextDeadline = Math.min(nextDeadline, registration.deadAt + idleGraceMs())
          if (now >= registration.deadAt + idleGraceMs()) {
            rmSync(path.join(artifactRegistrationsDir(), file), { force: true })
            registrations.delete(file)
          }
        }
      }
    }
    if (liveCount > 0) noLiveSince = null
    else noLiveSince ??= now
    writeDiscovery()
    if (liveCount === 0 && (cleanRemoval || now >= noLiveSince + idleGraceMs() || (nextDeadline !== Infinity && now >= nextDeadline))) await shutdown('idle')
  }

  const handler = async (request, response) => {
    const method = request.method ?? ''
    const host = request.headers.host?.toLowerCase()
    const allowedHosts = new Set([`localhost:${requestedPort}`, `127.0.0.1:${requestedPort}`])
    if (tailscale.ip) { allowedHosts.add(tailscale.ip); allowedHosts.add(`${tailscale.ip}:${requestedPort}`) }
    if (tailscale.dnsName) { allowedHosts.add(tailscale.dnsName.toLowerCase()); allowedHosts.add(`${tailscale.dnsName.toLowerCase()}:${requestedPort}`) }
    if (!host || !allowedHosts.has(host)) { send(response, method, 421, 'Misdirected Request\n'); return }
    if (method !== 'GET' && method !== 'HEAD') {
      send(response, method, 405, 'Method Not Allowed\n', 'text/plain; charset=utf-8', { Allow: 'GET, HEAD' }); return
    }
    let requestUrl
    try { requestUrl = new URL(request.url ?? '/', `http://localhost:${requestedPort}`) } catch {
      send(response, method, 400, 'Bad Request\n'); return
    }
    if (requestUrl.pathname === '/__wt-artifact-server/health') {
      send(response, method, 200, `${JSON.stringify({
        service: ARTIFACT_SERVER_ID, version: ARTIFACT_SERVER_VERSION, pid: process.pid,
        uid: artifactUid(), port: requestedPort,
        registeredSessions: [...registrations.values()].filter((registration) => registration.live).length,
      })}\n`, 'application/json; charset=utf-8')
      return
    }
    const segments = decodeRequestPath(request.url ?? '/')
    if (segments === undefined) { send(response, method, 400, 'Bad Request\n'); return }
    if (segments === null) { send(response, method, 403, 'Forbidden\n'); return }
    const roots = liveRoots()
    if (segments.length === 0) {
      const links = roots.map((root) => `<li><a href="/${encodeURIComponent(root.name)}/">${escapeHtml(root.name)}/</a></li>`).join('')
      send(response, method, 200, htmlPage('Artifact roots', `<h1>Artifact roots</h1><ul>${links}</ul>`), 'text/html; charset=utf-8', { 'Content-Security-Policy': GENERATED_CSP })
      return
    }
    const rootRecord = roots.find((root) => root.name === segments[0])
    if (!rootRecord) { send(response, method, 404, 'Not Found\n'); return }
    const fileSegments = segments.slice(1)
    if (pathIsDenied([path.basename(rootRecord.canonical), ...fileSegments], rootRecord.deny)) { send(response, method, 403, 'Forbidden\n'); return }
    try {
      if (realpathSync(rootRecord.declared) !== rootRecord.canonical) { send(response, method, 403, 'Forbidden\n'); return }
    } catch { send(response, method, 403, 'Forbidden\n'); return }
    const lexicalTarget = path.resolve(rootRecord.canonical, ...fileSegments)
    if (!pathIsUnder(rootRecord.canonical, lexicalTarget)) { send(response, method, 403, 'Forbidden\n'); return }
    let target
    try { target = realpathSync(lexicalTarget) } catch { send(response, method, 404, 'Not Found\n'); return }
    if (!pathIsUnder(rootRecord.canonical, target)) { send(response, method, 403, 'Forbidden\n'); return }
    const canonicalSegments = path.relative(rootRecord.canonical, target).split(path.sep)
    if (pathIsDenied([path.basename(rootRecord.canonical), ...canonicalSegments], rootRecord.deny)) { send(response, method, 403, 'Forbidden\n'); return }
    try {
      const info = await stat(target)
      if (info.isDirectory()) {
        send(response, method, 200, await directoryPage(rootRecord, target, segments), 'text/html; charset=utf-8', { 'Content-Security-Policy': GENERATED_CSP }); return
      }
      if (!info.isFile()) { send(response, method, 404, 'Not Found\n'); return }
      const extension = path.extname(target).toLowerCase()
      const file = await readFile(target)
      if (extension === '.md') send(response, method, 200, renderMarkdown(file.toString('utf8')), 'text/html; charset=utf-8', { 'Content-Security-Policy': GENERATED_CSP })
      else if (['.txt', '.log', '.json'].includes(extension)) send(response, method, 200, htmlPage(path.basename(target), `<pre>${escapeHtml(file.toString('utf8'))}</pre>`), 'text/html; charset=utf-8', { 'Content-Security-Policy': GENERATED_CSP })
      else if (extension === '.html' || extension === '.htm') send(response, method, 200, file, 'text/html; charset=utf-8', { 'Content-Security-Policy': richHtml(file) ? RICH_CSP : RAW_CSP })
      else send(response, method, 200, file, fileContentType(target), { 'Content-Security-Policy': RAW_CSP })
    } catch { send(response, method, 500, 'Internal Server Error\n') }
  }

  const listen = (host) => new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      Promise.resolve(handler(request, response)).catch(() => {
        if (!response.headersSent) send(response, request.method ?? '', 500, 'Internal Server Error\n')
        else response.end()
      })
    })
    server.once('error', reject)
    server.listen(requestedPort, host, () => {
      server.removeListener('error', reject)
      server.on('error', (error) => process.stderr.write(`wt-artifact-server: ${error.message}\n`))
      servers.push(server)
      resolve(server)
    })
  })

  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    if (pollTimer) clearInterval(pollTimer)
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
    const current = readArtifactDiscovery()
    if (current?.pid === process.pid) rmSync(artifactDiscoveryPath(), { force: true })
    rmSync(artifactIntentPath(), { force: true })
    process.exit(0)
  }

  const ownsRegistrationState = () => {
    try {
      if (!statSync(artifactRegistrationsDir()).isDirectory()) return false
      return readArtifactDiscovery()?.pid === process.pid
    } catch {
      return false
    }
  }

  const pollRegistrations = async () => {
    if (!ownsRegistrationState()) {
      ownershipMisses += 1
      if (ownershipMisses >= REGISTRATION_OWNERSHIP_MISS_LIMIT) await shutdown('unregistered')
      return
    }
    ownershipMisses = 0
    await scanRegistrations()
  }

  try {
    await listen('127.0.0.1')
  } catch (error) {
    if (error?.code === 'EADDRINUSE') process.exit(0)
    throw error
  }
  if (tailscale.ip && tailscale.ip !== '127.0.0.1') {
    try { await listen(tailscale.ip) } catch { tailscale.remoteUrl = null }
  }
  discovery = {
    version: ARTIFACT_SERVER_VERSION, pid: process.pid, port: requestedPort,
    baseUrl: `http://localhost:${requestedPort}`, remoteUrl: tailscale.remoteUrl,
    tailnetDetection: tailscale.detection,
    roots: [], mounts: [], startedAt: new Date().toISOString(),
  }
  await scanRegistrations()
  writeDiscovery()
  const pollMs = Number(process.env.WT_ARTIFACT_SERVER_REGISTRATION_POLL_MS ?? 2_000)
  if (!Number.isFinite(pollMs) || pollMs < 10) throw new Error('WT_ARTIFACT_SERVER_REGISTRATION_POLL_MS must be at least 10')
  pollTimer = setInterval(() => { pollRegistrations().catch((error) => process.stderr.write(`wt-artifact-server: ${error.message}\n`)) }, pollMs)
  pollTimer.unref()
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

function urlCommand(args) {
  const remote = args.includes('--remote')
  const argument = args.find((value) => value !== '--remote')
  if (!argument) { process.stderr.write('url requires a path\n'); process.exitCode = 3; return }
  const result = artifactUrlResult(path.resolve(argument), { remote })
  if (result.url === null) { process.stderr.write(`${result.reason}\n`); process.exitCode = 3; return }
  process.stdout.write(`${result.url}\n`)
}

async function stopRunning(action, force) {
  const state = readArtifactDiscovery()
  if (!state) return { ok: true, message: 'artifact server: stopped' }
  const probe = await probeArtifactServer(state.port)
  if (probe.kind !== 'ours' || probe.health.pid !== state.pid || probe.health.port !== state.port) {
    return { ok: false, message: 'artifact server: refusing to signal because state and health identity mismatch' }
  }
  if (!Number.isInteger(probe.health.registeredSessions) || probe.health.registeredSessions < 0) {
    return { ok: false, message: 'artifact server: refusing because registered session count cannot be measured' }
  }
  if (!force && probe.health.registeredSessions > 0) {
    return { ok: false, message: `artifact server: refusing with ${probe.health.registeredSessions} registered session(s); use --force` }
  }
  if (process.platform === 'linux') {
    let commandLine = ''
    try { commandLine = readFileSync(`/proc/${state.pid}/cmdline`, 'utf8') } catch {}
    if (!commandLine.includes('wt-artifact-server.mjs')) {
      return { ok: false, message: 'artifact server: refusing because PID command identity does not match wt-artifact-server.mjs' }
    }
  } else if (!force) {
    return { ok: false, message: 'artifact server: process identity check is weaker on this platform; use --force' }
  }
  atomicWriteJson(artifactIntentPath(), { pid: state.pid, action })
  try { process.kill(state.pid, 'SIGTERM') } catch (error) {
    return { ok: false, message: `artifact server: failed to signal verified PID ${state.pid}: ${error.message}` }
  }
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    const current = await probeArtifactServer(state.port, 200)
    if (current.kind !== 'ours' || current.health.pid !== state.pid) return { ok: true, message: `artifact server: ${action === 'restart' ? 'stopped for restart' : 'stopped'}` , port: state.port }
  }
  return { ok: false, message: `artifact server: verified PID ${state.pid} did not stop` }
}

function spawnServer(port) {
  const script = fileURLToPath(import.meta.url)
  const child = spawn(process.execPath, [script, 'serve'], {
    detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, WT_ARTIFACT_SERVER_PORT: String(port) },
  })
  child.unref()
}

async function controlCommand(command, force) {
  if (command === 'stop') return stopRunning('stop', force)
  const old = readArtifactDiscovery()
  const stopped = await stopRunning('restart', force)
  if (!stopped.ok) return stopped
  const port = stopped.port ?? old?.port ?? configuredArtifactPort()
  spawnServer(port)
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const probe = await probeArtifactServer(port, 200)
    if (probe.kind === 'ours') return { ok: true, message: `artifact server: restarted on ${port}` }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return { ok: false, message: `artifact server: restart failed on ${port}` }
}

async function statusCommand() {
  const state = readArtifactDiscovery()
  if (!state) return 'artifact server: stopped'
  const probe = await probeArtifactServer(state.port)
  if (probe.kind !== 'ours' || probe.health.pid !== state.pid) return 'artifact server: stopped (stale state)'
  const roots = state.roots.map((root) => `${root.name}=${root.path}`).join(', ') || '(none)'
  const tailnet = state.tailnetDetection
    ? `${state.tailnetDetection.status}${state.tailnetDetection.reason ? ` (${state.tailnetDetection.reason})` : ''}`
    : 'unknown (server predates tailnet detection status)'
  return `artifact server: running\nport: ${state.port}\nbaseUrl: ${state.baseUrl}\nremoteUrl: ${state.remoteUrl ?? 'null'}\ntailnetDetection: ${tailnet}\nroots: ${roots}`
}

const argv = process.argv.slice(2)
handleHelpFlag(argv, HELP)
const [command, ...args] = argv
if (command === undefined || command === 'serve') await serve()
else if (command === 'url') urlCommand(args)
else if (command === 'status' && args.length === 0) process.stdout.write(`${await statusCommand()}\n`)
else if ((command === 'stop' || command === 'restart') && args.every((arg) => arg === '--force')) {
  const result = await controlCommand(command, args.includes('--force'))
  ;(result.ok ? process.stdout : process.stderr).write(`${result.message}\n`)
  if (!result.ok) process.exitCode = 1
} else {
  process.stderr.write('usage: wt-artifact-server [serve | url <path> [--remote] | status | stop [--force] | restart [--force]]\n')
  process.exitCode = 2
}
