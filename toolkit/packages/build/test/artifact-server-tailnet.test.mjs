import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkArtifactUrl, detectTailscale } from '../../../../plugin/bin/lib/artifact-server.mjs'

const SERVER = fileURLToPath(new URL('../../../../plugin/bin/wt-artifact-server.mjs', import.meta.url))
const WSL_TAILSCALE = '/mnt/c/Program Files/Tailscale/tailscale.exe'
const WSL_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
const PORT = 48001
const DNS = 'fixture.tailnet.ts.net'
const absent = () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }) }

function outputs(args) {
  if (args[0] === 'ip') return '127.0.0.1\n'
  if (args[0] === 'status') return JSON.stringify({ Self: { DNSName: `${DNS}.` } })
  return `https://${DNS}\n|-- /artifacts proxy http://127.0.0.1:${PORT}\n`
}

function resolutionOptions(platform, exists = () => false, env = {}) {
  return { platform, wsl: platform === 'linux', exists, env }
}

test('resolves the WSL standard Tailscale install with an interop-free PATH', () => {
  const calls = []
  const run = (command, args) => {
    calls.push(command)
    return command === WSL_TAILSCALE ? outputs(args) : absent()
  }
  const result = detectTailscale(PORT, run, resolutionOptions('linux', (file) => file === WSL_TAILSCALE))
  assert.equal(result.detection.status, 'available', 'standard WSL install must be detected')
  assert.equal(result.via, 'windows-interop')
  assert.equal(result.binary, WSL_TAILSCALE)
  assert.deepEqual(calls.slice(0, 3), ['tailscale', 'tailscale.exe', WSL_TAILSCALE])
})

for (const [platform, command, env] of [
  ['darwin', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', {}],
  ['win32', 'D:\\Programs\\Tailscale\\tailscale.exe', { ProgramFiles: 'D:\\Programs' }],
]) {
  test(`resolves the standard install on ${platform}`, () => {
    const run = (candidate, args) => candidate === command ? outputs(args) : absent()
    const result = detectTailscale(PORT, run, resolutionOptions(platform, (file) => file === command, env))
    assert.equal(result.detection.status, 'available')
    assert.equal(result.via, 'native')
    assert.equal(result.binary, command)
  })
}

test('PATH wins over standard installs without probing their filesystem', () => {
  const options = resolutionOptions('linux', () => { throw new Error('must not probe fallback') })
  const result = detectTailscale(PORT, (_command, args) => outputs(args), options)
  assert.equal(result.binary, 'tailscale')
})

test('a configured binary stays authoritative and names its failure', () => {
  const calls = []
  const options = resolutionOptions('linux', () => true, { WT_ARTIFACT_SERVER_TAILSCALE_BINARY: '/chosen/tailscale' })
  const result = detectTailscale(PORT, (command) => { calls.push(command); return absent() }, options)
  assert.equal(result.detection.status, 'unavailable')
  assert.match(result.detection.reason, /configured tailscale binary failed/)
  assert.equal(calls[0], '/chosen/tailscale')
  assert.equal(new Set(calls).size, 1, 'no fallback may replace an explicit binary')
})

test('native Linux uses PATH only and reports unavailable when absent', () => {
  const calls = []
  const options = { ...resolutionOptions('linux', () => { throw new Error('no Linux install probes') }), wsl: false }
  const result = detectTailscale(PORT, (command) => { calls.push(command); return absent() }, options)
  assert.equal(result.detection.status, 'unavailable')
  assert.equal(result.remoteUrl, null)
  assert.deepEqual(calls, ['tailscale'])
})

test('remote checks resolve the WSL PowerShell absolute fallback', async () => {
  const calls = []
  const result = await checkArtifactUrl(`https://${DNS}/artifacts`, {
    remote: true, via: 'windows-interop', ...resolutionOptions('linux', (file) => file === WSL_POWERSHELL),
    run: (command) => { calls.push(command); return command === WSL_POWERSHELL ? 'STATUS=200\r\n' : absent() },
  })
  assert.deepEqual(result, { verdict: 'reachable', status: 200, from: 'windows' })
  assert.deepEqual(calls, ['powershell.exe', WSL_POWERSHELL])
})

test('PowerShell command discovery also uses its WSL absolute fallback', () => {
  const custom = '/mnt/c/Custom/tailscale.exe'
  const run = (command, args) => {
    if (command === WSL_POWERSHELL) return 'C:\\Custom\\tailscale.exe\r\n'
    if (command === 'wslpath') return `${custom}\n`
    return command === custom ? outputs(args) : absent()
  }
  const result = detectTailscale(PORT, run, resolutionOptions('linux', (file) => file === WSL_POWERSHELL))
  assert.equal(result.detection.status, 'available')
  assert.equal(result.binary, custom)
  assert.equal(result.via, 'windows-interop')
})

test('unreadable PowerShell degrades to an explicit unverified result', async () => {
  const result = await checkArtifactUrl(`https://${DNS}/artifacts`, {
    remote: true, via: 'windows-interop', ...resolutionOptions('linux'), run: absent,
  })
  assert.equal(result.verdict, 'unverified')
  assert.match(result.reason, /powershell.exe.*ENOENT/)
})

test('the real resolver checks an existing standard-install file', async (context) => {
  const { runArtifactBinary } = await import('../../../../plugin/bin/lib/host/artifact-binaries.mjs')
  const dir = mkdtempSync(path.join(tmpdir(), 'wt-tailnet-resolver-'))
  context.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(path.join(dir, 'Tailscale'))
  const command = path.join(dir, 'Tailscale', 'tailscale.exe')
  writeFileSync(command, '')
  // Use the real platform's path spelling for this filesystem test.
  const result = runArtifactBinary('tailscale', ['ip', '-4'], (candidate) => candidate === command ? '127.0.0.1' : absent(), {
    platform: 'win32', env: { ProgramFiles: dir }, wsl: false, windowsPath: path,
  })
  assert.equal(result.command, command)
})

test('failed detection retries immediately, then at most once per minute', async () => {
  const { createTailnetRetry } = await import('../../../../plugin/bin/lib/artifact-tailnet.mjs')
  let clock = 0
  let attempts = 0
  const unavailable = { detection: { status: 'unavailable', reason: 'fixture' } }
  const retry = createTailnetRetry({ now: () => clock, detect: () => { attempts++; return unavailable } })
  assert.equal(retry(unavailable, PORT, undefined), null)
  assert.equal(retry(unavailable, PORT, 'evil.example'), null)
  assert.equal(retry(unavailable, PORT, `localhost:${PORT}`), null)
  assert.equal(retry(unavailable, PORT, DNS), unavailable)
  for (clock = 1; clock < 60000; clock += 1000) assert.equal(retry(unavailable, PORT, DNS), null)
  clock = 60000
  assert.equal(retry(unavailable, PORT, `100.64.0.1:${PORT}`), unavailable)
  assert.equal(attempts, 2)
  assert.equal(retry({ detection: { status: 'available' } }, PORT, DNS), null)
  assert.equal(retry({ detection: { status: 'no-tailnet' } }, PORT, DNS), null)
})

test('status distinguishes unknown detection from unavailable detection without a known route', async () => {
  const { formatTailnetStatus } = await import('../../../../plugin/bin/lib/artifact-tailnet.mjs')
  assert.match(formatTailnetStatus({}), /unknown \(server predates tailnet detection status\)/)
  const status = formatTailnetStatus({ tailnetDetection: { status: 'unavailable', reason: 'fixture unavailable' } })
  assert.match(status, /unavailable \(fixture unavailable\)/)
  assert.doesNotMatch(status, /will fail/)
})

async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function waitFor(read) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const result = read()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('fixture did not become ready within 15 seconds')
}

function cli(args, env, cwd) {
  const child = spawn(process.execPath, [SERVER, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  return once(child, 'close').then(([code]) => ({ code, stdout, stderr }))
}

async function fixture(context) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wt-tailnet-'))
  const port = await freePort()
  const env = {
    ...process.env, XDG_STATE_HOME: dir, WT_ARTIFACT_SERVER_PORT: String(port),
    WT_ARTIFACT_SERVER_TAILSCALE_BINARY: process.execPath, WT_ARTIFACT_SERVER_IDLE_GRACE_S: '600',
  }
  writeFileSync(path.join(dir, 'ip'), 'process.exitCode = 1\n')
  writeFileSync(path.join(dir, 'status'), `console.log(JSON.stringify({Self:{DNSName:'${DNS}.'}}))`)
  writeFileSync(path.join(dir, 'serve'), `console.log('https://${DNS}\\n|-- /artifacts proxy http://127.0.0.1:${port}\\n')`)
  const child = spawn(process.execPath, [SERVER, 'serve'], { env, cwd: dir, stdio: 'ignore' })
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close')
      child.kill('SIGTERM')
      await closed
    }
    rmSync(dir, { recursive: true, force: true })
  })
  const stateFile = path.join(dir, 'wt-artifact-server', 'server.json')
  const read = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')) } catch { return null } }
  await waitFor(read)
  return { dir, port, env, stateFile, read }
}

function get(port, host) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', headers: { Host: host }, agent: false }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode))
    })
    req.once('error', reject)
    req.end()
  })
}

test('status names unavailable detection and a known route that will fail with 421', async (context) => {
  const server = await fixture(context)
  const result = await cli(['status'], server.env, server.dir)
  assert.equal(result.code, 0)
  assert.match(result.stdout, /tailnetDetection: unavailable/)
  assert.match(result.stdout, /remote links will fail \(421\)/)
})

test('first tailnet Host retries failed startup detection and publishes recovered state', async (context) => {
  const server = await fixture(context)
  assert.equal(server.read().tailnetDetection.status, 'unavailable')
  writeFileSync(path.join(server.dir, 'ip'), "console.log('127.0.0.1')\n")
  assert.equal(await get(server.port, 'evil.example'), 421)
  assert.equal(server.read().tailnetDetection.status, 'unavailable', 'unrelated hosts must not trigger recovery')
  assert.equal(await get(server.port, DNS), 200, 'first tailnet Host must recover without restarting')
  const state = server.read()
  assert.equal(state.tailnetDetection.status, 'available')
  assert.equal(state.remoteUrl, `https://${DNS}/artifacts`)
  assert.equal(await get(server.port, 'evil.example'), 421)
  assert.equal(await get(server.port, 'evil.ts.net'), 421, 'a tailnet-shaped Host is not automatically trusted')
})
