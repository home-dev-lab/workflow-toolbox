import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const INTERACTIVE = "default-src 'none'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"
const GENERATED = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
const INTERACTIVE_MARKER = '<!-- wt-artifact-server: interactive -->'
const MERMAID_PATH = '/__wt-artifact-server/mermaid.min.js'
const MERMAID_INIT = "mermaid.initialize({ startOnLoad: true, theme: 'neutral', securityLevel: 'strict' });"
const MERMAID_STUB = '/* test Mermaid build */'
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
  // Copy the installed server and its helpers; only the browser bundle is stubbed.
  const bin = join(directory, 'plugin', 'bin')
  mkdirSync(bin, { recursive: true })
  cpSync(new URL('../../../../plugin/bin/lib/', import.meta.url), join(bin, 'lib'), { recursive: true })
  cpSync(new URL('../../../../plugin/.claude-plugin/', import.meta.url), join(directory, 'plugin', '.claude-plugin'), { recursive: true })
  copyFileSync(SERVER, join(bin, 'wt-artifact-server.mjs'))
  const assets = join(directory, 'plugin', 'skills', 'artifact-server', 'assets', 'mermaid')
  mkdirSync(assets, { recursive: true })
  writeFileSync(join(assets, 'mermaid.min.js'), MERMAID_STUB)
  child = spawn(process.execPath, [join(bin, 'wt-artifact-server.mjs'), 'serve'], {
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

async function interactiveResponses() {
  const source = `${INTERACTIVE_MARKER}<script>document.title='RAN'</script>`
  for (const method of ['GET', 'HEAD']) {
    const response = await page('interactive.htm', source, method)
    const policy = response.headers.get('content-security-policy')
    assert.equal(policy, INTERACTIVE, `interactive ${method} CSP`)
    assert.doesNotMatch(policy, /\bsandbox\b/)
    assert.match(policy, /(?:^|;\s*)script-src 'self' 'unsafe-inline'(?:;|$)/)
    for (const directive of ['connect-src', 'form-action', 'object-src', 'frame-ancestors', 'base-uri']) {
      assert.ok(policy.split('; ').includes(`${directive} 'none'`), directive)
    }
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(response.body, method === 'HEAD' ? '' : source)
  }
}

async function interactiveMarkers() {
  for (const [prefix, expected] of [
    [' \n<!-- WT-ARTIFACT-SERVER: INTERACTIVE -->', INTERACTIVE],
    [' '.repeat(256 - Buffer.byteLength(INTERACTIVE_MARKER)) + INTERACTIVE_MARKER, INTERACTIVE],
    [' '.repeat(257 - Buffer.byteLength(INTERACTIVE_MARKER)) + INTERACTIVE_MARKER, RAW],
    [' '.repeat(250) + INTERACTIVE_MARKER, RAW],
    ['\u2003'.repeat(80) + INTERACTIVE_MARKER, RAW],
    ['<html>' + INTERACTIVE_MARKER, RAW],
    ['<!-- earlier -->' + INTERACTIVE_MARKER, RAW],
  ]) {
    const response = await page('interactive-prefix.html', `${prefix}<p>Report</p>`)
    assert.equal(response.headers.get('content-security-policy'), expected, `interactive marker ${JSON.stringify(prefix)}`)
  }
}

async function nonHtmlPolicies() {
  for (const [extension, expected] of [['svg', RAW], ['txt', GENERATED]]) {
    const response = await page(`interactive.${extension}`, `${INTERACTIVE_MARKER}<svg></svg>`)
    assert.equal(response.headers.get('content-security-policy'), expected, `${extension} cannot opt in`)
  }
}

async function javascriptResponses() {
  for (const extension of ['js', 'mjs']) {
    const response = await page(`bundle.${extension}`, 'globalThis.loaded = true')
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8', extension)
    assert.equal(response.headers.get('content-security-policy'), RAW, `${extension} retains raw CSP`)
  }
}

function mermaidPolicy() {
  const hash = createHash('sha256').update(MERMAID_INIT).digest('base64')
  return `${GENERATED}; script-src 'self' 'sha256-${hash}'; connect-src 'none'; object-src 'none'; frame-ancestors 'none'`
}

async function mermaidMarkdown() {
  const source = '# Diagram\n\n```mermaid\nflowchart LR\nA-->B\n```\n\n```mermaid\nB-->C\n```'
  for (const method of ['GET', 'HEAD']) {
    const response = await page('diagrams.md', source, method)
    assert.equal(response.headers.get('content-security-policy'), mermaidPolicy(), `Mermaid ${method} CSP`)
    assert.doesNotMatch(response.headers.get('content-security-policy'), /script-src[^;]*'unsafe-inline'/)
    if (method === 'HEAD') { assert.equal(response.body, ''); continue }
    assert.equal((response.body.match(/<pre class="mermaid">/g) ?? []).length, 2)
    assert.equal((response.body.match(/<script src=/g) ?? []).length, 1, 'one vendored build per page')
    assert.ok(response.body.includes(`<script src="../__wt-artifact-server/mermaid.min.js"></script>`))
    assert.ok(response.body.includes(`<script>${MERMAID_INIT}</script>`), 'hash matches exact init bytes')
    assert.equal((response.body.match(/<script>/g) ?? []).length, 1, 'one fixed init per page')
  }
}

async function escapedMermaid() {
  const source = '```mermaid\n<script>alert("x")</script></pre>&\n```'
  const response = await page('escape.md', source)
  assert.ok(response.body.includes('<pre class="mermaid">\n&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;/pre&gt;&amp;\n\n</pre>'), 'Mermaid source remains escaped text')
  assert.doesNotMatch(response.body, /<script>alert|<\/pre>&/)
}

async function ordinaryMarkdown() {
  for (const source of ['# Plain\n\nParagraph', '```js\nconst x = 1\n```', '```mermaid extra\nA-->B\n```', '```Mermaid\nA-->B\n```', '```\n```mermaid\n```']) {
    const response = await page('ordinary.md', source)
    assert.equal(response.headers.get('content-security-policy'), GENERATED, `no Mermaid opt-in: ${JSON.stringify(source)}`)
    assert.doesNotMatch(response.body, /<script\b|<pre class="mermaid">/)
  }
}

async function mermaidAsset() {
  mkdirSync(join(directory, 'artifacts', '__wt-artifact-server'), { recursive: true })
  writeFileSync(join(directory, 'artifacts', '__wt-artifact-server', 'mermaid.min.js'), 'SHADOW')
  // Mount a root at the reserved name too: even a directly conflicting mount cannot win.
  const registration = join(directory, 'state', 'wt-artifact-server', 'registrations', 'shadow.json')
  writeFileSync(registration, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), deny: [],
    roots: [{ name: '__wt-artifact-server', path: join(directory, 'artifacts', '__wt-artifact-server') }],
  }), { mode: 0o600 })
  const discovery = join(directory, 'state', 'wt-artifact-server', 'server.json')
  const deadline = Date.now() + 15_000
  while (!JSON.parse(readFileSync(discovery, 'utf8')).roots.some((root) => root.name === '__wt-artifact-server')) {
    assert.ok(Date.now() < deadline, 'shadow root registered within 15000 ms')
    assert.equal(child.exitCode, null)
    await delay(25)
  }
  for (const method of ['GET', 'HEAD']) {
    const response = await fetch(`${origin}${MERMAID_PATH}`, { method, headers: { Connection: 'close' } })
    assert.equal(response.status, 200, 'reserved Mermaid asset is served')
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8')
    assert.equal(response.headers.get('content-security-policy'), RAW, 'asset retains raw resource CSP')
    assert.equal(await response.text(), method === 'HEAD' ? '' : MERMAID_STUB, 'registered roots cannot shadow Mermaid')
  }
}

export function registerArtifactCspTests({ before, after, test }) {
  before(startServer)
  after(stopServer)
  test('plain, rich, and annotatable HTML produce their exact CSP headers', exactPolicies)
  test('a real server serves annotatable GET and HEAD without sandbox or page-script permission', annotatableResponses)
  test('HTML opt-ins require a complete first-content marker within the first 256 bytes', markerDetection)
  test('interactive HTML has the exact script-enabled unsandboxed GET and HEAD policy', interactiveResponses)
  test('interactive markers must be complete first content within 256 bytes', interactiveMarkers)
  test('non-HTML extensions cannot activate the interactive policy', nonHtmlPolicies)
  test('JavaScript extensions keep their JavaScript MIME type and raw policy', javascriptResponses)
  test('Mermaid Markdown gets one local build, fixed init, and exact narrow GET and HEAD policy', mermaidMarkdown)
  test('Mermaid fence source is HTML-escaped including script and pre closing tags', escapedMermaid)
  test('ordinary Markdown and non-exact Mermaid info strings stay script-free', ordinaryMarkdown)
  test('the reserved Mermaid asset has JavaScript MIME and cannot be shadowed by roots', mermaidAsset)
}

if (isInvokedDirectly(import.meta.url)) registerArtifactCspTests(await import('node:test'))
