import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { isInvokedDirectly } from '../../../../plugin/bin/lib/host/entry-guard.mjs'

const SERVER = fileURLToPath(new URL('../../../../plugin/bin/wt-artifact-server.mjs', import.meta.url))
const RAW = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'"
const RICH = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; img-src data:; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'"
const ANNOTATABLE = "default-src 'none'; script-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const MARKER = '<!-- wt-artifact-server: annotatable -->'
let directory
let child
let origin

async function freePort() {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const { port } = reservation.address()
  await new Promise((resolve) => reservation.close(resolve))
  return port
}

async function waitForDiscovery(file) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(readFileSync(file, 'utf8'))
      if (state.pid === child.pid && state.roots.length === 1) return
    } catch { /* Discovery is published atomically after registration. */ }
    assert.equal(child.exitCode, null, 'artifact server exited during startup')
    await delay(25)
  }
  assert.fail('artifact server did not publish its registered root within 15000 ms')
}

async function startServer() {
  directory = mkdtempSync(join(tmpdir(), 'wt-artifact-csp-'))
  const registrations = join(directory, 'state', 'wt-artifact-server', 'registrations')
  mkdirSync(registrations, { recursive: true, mode: 0o700 })
  mkdirSync(join(directory, 'artifacts'))
  writeFileSync(join(registrations, 'review.json'), JSON.stringify({
    pid: process.pid, startedAt: new Date().toISOString(), deny: [],
    roots: [{ name: 'review', path: join(directory, 'artifacts') }],
  }), { mode: 0o600 })
  const port = await freePort()
  origin = `http://localhost:${port}`
  child = spawn(process.execPath, [SERVER, 'serve'], {
    cwd: directory, stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env, CLAUDE_CONFIG_DIR: join(directory, 'config'),
      XDG_STATE_HOME: join(directory, 'state'), WT_ARTIFACT_SERVER_PORT: String(port),
      WT_ARTIFACT_SERVER_TAILSCALE_BINARY: process.execPath,
      WT_ARTIFACT_SERVER_IDLE_GRACE_S: '600',
    },
  })
  await waitForDiscovery(join(registrations, '..', 'server.json'))
}

async function stopServer() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
  }
  if (directory) rmSync(directory, { recursive: true, force: true })
}

async function page(file, source, method = 'GET') {
  writeFileSync(join(directory, 'artifacts', file), source)
  const response = await fetch(`${origin}/review/${file}`, { method, headers: { Connection: 'close' } })
  const body = await response.text()
  assert.equal(response.status, 200, file)
  return { headers: response.headers, body }
}

async function exactPolicies() {
  for (const [name, marker, expected] of [
    ['plain', '', RAW], ['rich', '<!-- wt-artifact-server: rich -->', RICH],
    ['annotatable', MARKER, ANNOTATABLE],
  ]) {
    const response = await page(`${name}.html`, `${marker}<title>Review</title>`)
    assert.equal(response.headers.get('content-security-policy'), expected, `${name} CSP`)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  }
}

async function annotatableResponses() {
  const source = `${MARKER}<title>Review</title><script>document.title='RAN'</script><details><summary>More</summary>Notes</details>`
  for (const method of ['GET', 'HEAD']) {
    const response = await page('review.htm', source, method)
    const policy = response.headers.get('content-security-policy')
    assert.doesNotMatch(policy, /\bsandbox\b/)
    assert.match(policy, /(?:^|;\s*)script-src 'none'(?:;|$)/)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(response.body, method === 'HEAD' ? '' : source)
  }
}

async function markerDetection() {
  const cases = [
    [' \n\t<!-- WT-ARTIFACT-SERVER: ANNOTATABLE -->', ANNOTATABLE],
    [' '.repeat(256 - Buffer.byteLength(MARKER)) + MARKER, ANNOTATABLE],
    [' '.repeat(257 - Buffer.byteLength(MARKER)) + MARKER, RAW],
    [' '.repeat(256) + MARKER, RAW],
    ['\u2003'.repeat(80) + MARKER, RAW],
    ['<html>' + MARKER, RAW],
    ['<!-- another comment -->' + MARKER, RAW],
    ['<!-- wt-artifact-server: annotatable-rich -->', RAW],
    [' \n<!-- WT-ARTIFACT-SERVER: RICH -->', RICH],
    [' '.repeat(256) + '<!-- wt-artifact-server: rich -->', RAW],
  ]
  for (const [index, [prefix, expected]] of cases.entries()) {
    const response = await page(`prefix-${index}.html`, `${prefix}<p>Review</p>`)
    assert.equal(response.headers.get('content-security-policy'), expected, `prefix case ${index}`)
  }
  const svg = await page('review.svg', `${MARKER}<svg></svg>`)
  assert.equal(svg.headers.get('content-security-policy'), RAW, 'only HTML may opt in')
}

export function registerArtifactCspTests({ before, after, test }) {
  before(startServer)
  after(stopServer)
  test('plain, rich, and annotatable HTML produce their exact CSP headers', exactPolicies)
  test('a real server serves annotatable GET and HEAD without sandbox or page-script permission', annotatableResponses)
  test('HTML opt-ins require a complete first-content marker within the first 256 bytes', markerDetection)
}

if (isInvokedDirectly(import.meta.url)) registerArtifactCspTests(await import('node:test'))
