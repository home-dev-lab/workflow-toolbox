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
import { HTML_PAGE_POLICIES } from '../../../../plugin/bin/lib/artifact-html-policy.mjs'

const SERVER = fileURLToPath(new URL('../../../../plugin/bin/wt-artifact-server.mjs', import.meta.url))
const RAW = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'"
const RICH = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; img-src data:; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'"
const ANNOTATABLE = "default-src 'none'; script-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const INTERACTIVE = "default-src 'none'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"
// Unmarked HTML: the sandbox allows scripts so the browser's own annotation injection can run, and CSP blocks every
// page script instead (the same no-script guarantee, with the opaque origin kept).
const DEFAULT_HTML = "sandbox allow-scripts; default-src 'none'; script-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'"
// Each HTML mode's policy before every mode became annotatable: no mode may change its page-script permission or
// lose the opaque-origin sandbox it had.
const POLICIES_BEFORE = new Map([['default', RAW], ['rich', RICH], ['annotatable', ANNOTATABLE], ['interactive', INTERACTIVE]])
const MODE_MARKERS = new Map([['default', '']])
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
    ['plain', '', DEFAULT_HTML], ['rich', '<!-- wt-artifact-server: rich -->', RICH],
    ['annotatable', MARKER, ANNOTATABLE],
  ]) {
    const response = await page(`${name}.html`, `${marker}<title>Review</title>`)
    assert.equal(response.headers.get('content-security-policy'), expected, `${name} CSP`)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  }
}

// Parsed like a browser: directive names and keyword sources compared case-insensitively, the first occurrence of a
// repeated directive wins.
function directives(policy) {
  const parsed = new Map()
  for (const [name, ...values] of policy.toLowerCase().split(';').map((part) => part.trim().split(/\s+/))) {
    if (name && !parsed.has(name)) parsed.set(name, values)
  }
  return parsed
}

// Directives a mode may gain over its baseline: each only in its most restrictive form.
const RESTRICTIVE_ADDITIONS = new Map([['script-src', ["'none'"]], ['connect-src', ["'none'"]], ['base-uri', ["'none'"]], ['form-action', ["'none'"]]])

function assertSandbox(mode, now, was) {
  const sandbox = now.get('sandbox')
  assert.ok(!sandbox || sandbox.includes('allow-scripts'), `${mode}: a sandbox without allow-scripts stops the browser's annotation injection`)
  assert.ok(!sandbox?.includes('allow-same-origin'), `${mode}: never pair the sandbox with the real origin`)
  assert.equal(Boolean(sandbox), was.has('sandbox'), `${mode}: keeps or lacks the opaque-origin sandbox as before`)
  const lifted = (sandbox ?? []).filter((flag) => !was.get('sandbox').includes(flag))
  assert.ok(lifted.every((flag) => flag === 'allow-scripts'), `${mode}: lifts no sandbox restriction other than scripts: ${lifted}`)
  if (lifted.length > 0) assert.deepEqual(now.get('script-src') ?? now.get('default-src'), ["'none'"], `${mode}: scripts the sandbox now admits are blocked by CSP`)
}

// No mode gains a permission: every baseline directive is unchanged and any new directive only restricts.
function assertModePolicy(mode, served) {
  const before = POLICIES_BEFORE.get(mode)
  assert.ok(before, `${mode}: a new HTML mode records its baseline in POLICIES_BEFORE`)
  const now = directives(served)
  const was = directives(before)
  assertSandbox(mode, now, was)
  for (const [name, values] of was) {
    if (name !== 'sandbox') assert.deepEqual(now.get(name), values, `${mode}: ${name} unchanged`)
  }
  for (const [name, values] of now) {
    if (!was.has(name)) assert.deepEqual(values, RESTRICTIVE_ADDITIONS.get(name), `${mode}: only a restrictive ${name} may be added`)
  }
}

async function everyModeAnnotatable() {
  const missing = [...POLICIES_BEFORE.keys()].filter((mode) => !HTML_PAGE_POLICIES.has(mode))
  assert.deepEqual(missing, [], 'every HTML mode that existed before is still served')
  for (const [mode, policy] of HTML_PAGE_POLICIES) {
    const marker = MODE_MARKERS.get(mode) ?? `<!-- wt-artifact-server: ${mode} -->`
    const served = (await page(`mode-${mode}.html`, `${marker}<title>${mode}</title>`)).headers.get('content-security-policy')
    assert.equal(served, policy, `${mode}: the marker selects its own policy`)
    assertModePolicy(mode, served)
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
    [' '.repeat(257 - Buffer.byteLength(MARKER)) + MARKER, DEFAULT_HTML],
    [' '.repeat(256) + MARKER, DEFAULT_HTML],
    ['\u2003'.repeat(80) + MARKER, DEFAULT_HTML],
    ['<html>' + MARKER, DEFAULT_HTML],
    ['<!-- another comment -->' + MARKER, DEFAULT_HTML],
    ['<!-- wt-artifact-server: annotatable-rich -->', DEFAULT_HTML],
    [' \n<!-- WT-ARTIFACT-SERVER: RICH -->', RICH],
    [' '.repeat(256) + '<!-- wt-artifact-server: rich -->', DEFAULT_HTML],
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
    [' '.repeat(257 - Buffer.byteLength(INTERACTIVE_MARKER)) + INTERACTIVE_MARKER, DEFAULT_HTML],
    [' '.repeat(250) + INTERACTIVE_MARKER, DEFAULT_HTML],
    ['\u2003'.repeat(80) + INTERACTIVE_MARKER, DEFAULT_HTML],
    ['<html>' + INTERACTIVE_MARKER, DEFAULT_HTML],
    ['<!-- earlier -->' + INTERACTIVE_MARKER, DEFAULT_HTML],
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

// Astra r1 HIGH: a non-canonical request path (trailing or repeated slash) moved the relative script URL into a
// registered root, which then served its own mermaid.min.js. Whatever URL the browser resolves, the script it loads
// must be the server's build, directly and behind a path-mounted proxy (tailscale serve /artifacts).
async function nonCanonicalMermaidPaths() {
  mkdirSync(join(directory, 'artifacts', '__wt-artifact-server'), { recursive: true })
  writeFileSync(join(directory, 'artifacts', '__wt-artifact-server', 'mermaid.min.js'), 'SHADOW')
  writeFileSync(join(directory, 'artifacts', 'diagram.md'), '```mermaid\nflowchart LR\n  A-->B\n```')
  for (const requestPath of ['/review/diagram.md', '/review/diagram.md/', '/review//diagram.md', '/review/./diagram.md/']) {
    const response = await fetch(`${origin}${requestPath}`, { headers: { Connection: 'close' } })
    assert.equal(response.status, 200, requestPath)
    const source = /<script src="([^"]+)"><\/script>/.exec(await response.text())?.[1]
    assert.ok(source, `${requestPath} carries the Mermaid script`)
    for (const prefix of ['', '/artifacts']) {
      const resolved = new URL(source, `https://tailnet.example${prefix}${requestPath}`).pathname
      assert.ok(resolved.startsWith(`${prefix}/`), `${requestPath} under ${prefix || 'root'} stays inside the mount`)
      const script = await fetch(`${origin}${resolved.slice(prefix.length)}`, { headers: { Connection: 'close' } })
      assert.equal(script.status, 200, `${requestPath} under ${prefix || 'root'} resolves to ${resolved}`)
      assert.equal(await script.text(), MERMAID_STUB, `${requestPath} under ${prefix || 'root'} loads the server build, never a root file`)
    }
  }
  for (const reserved of ['/review/__wt-artifact-server/mermaid.min.js', '/review/x/%5F_wt-artifact-server/mermaid.min.js']) {
    const response = await fetch(`${origin}${reserved}`, { headers: { Connection: 'close' } })
    assert.equal(await response.text(), MERMAID_STUB, `${reserved}: the reserved segment never reaches a root`)
  }
  const other = await fetch(`${origin}/review/__wt-artifact-server/other.js`, { headers: { Connection: 'close' } })
  assert.equal(other.status, 404, 'any other file under the reserved segment is not found, never read from a root')
}

// Astra r1 LOW: a Mermaid example quoted inside a longer or tilde fence is text, not a diagram.
async function nestedFenceMermaid() {
  for (const source of ['~~~text\n```mermaid\nA-->B\n```\n~~~', '````\n```mermaid\nA-->B\n```\n````', '````md\n```mermaid\nA-->B\n```\n````']) {
    const response = await page('nested.md', source)
    assert.equal(response.headers.get('content-security-policy'), GENERATED, `quoted Mermaid stays script-free: ${JSON.stringify(source)}`)
    assert.doesNotMatch(response.body, /<script\b|<pre class="mermaid">/)
    assert.ok(response.body.includes('```mermaid'), 'the quoted fence is shown as text')
  }
}

export function registerArtifactCspTests({ before, after, test }) {
  before(startServer)
  after(stopServer)
  test('plain, rich, and annotatable HTML produce their exact CSP headers', exactPolicies)
  test('every HTML mode, unmarked included, is annotatable and keeps its page-script permission', everyModeAnnotatable)
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
  test('non-canonical Markdown paths still load the server Mermaid build, never a root file (Astra r1 HIGH)', nonCanonicalMermaidPaths)
  test('a Mermaid fence quoted inside a longer or tilde fence stays text (Astra r1 LOW)', nestedFenceMermaid)
}

if (isInvokedDirectly(import.meta.url)) registerArtifactCspTests(await import('node:test'))
