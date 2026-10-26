import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  // Use the real platform's path spelling for this filesystem test.
  const options = {
    platform: 'win32', env: { ProgramFiles: dir }, wsl: false, windowsPath: path,
  }
  const calls = []
  const run = (candidate) => { calls.push(candidate); return candidate === command ? '127.0.0.1' : absent() }
  assert.throws(() => runArtifactBinary('tailscale', ['ip', '-4'], run, options),
    { code: 'ENOENT' }, 'a missing standard-install file must not be executed')
  assert.deepEqual(calls, ['tailscale', 'tailscale.exe'])
  writeFileSync(command, '')
  const result = runArtifactBinary('tailscale', ['ip', '-4'], run, options)
  assert.equal(result.command, command)
  assert.equal(calls.at(-1), command, 'the existing standard-install file must be executed')
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
  assert.equal(await retry(unavailable, PORT, DNS), unavailable)
  for (clock = 1; clock < 60000; clock += 1000) assert.equal(retry(unavailable, PORT, DNS), null)
  clock = 60000
  assert.equal(await retry(unavailable, PORT, `100.64.0.1:${PORT}`), unavailable)
  assert.equal(attempts, 2)
  clock = 120000
  assert.equal(retry({ dnsName: DNS, detection: { status: 'available' } }, PORT, DNS), null)
  assert.equal(await retry({ detection: { status: 'no-tailnet' } }, PORT, DNS), unavailable)
})

test('status distinguishes unknown detection from unavailable detection without a known route', async () => {
  const { formatTailnetStatus } = await import('../../../../plugin/bin/lib/artifact-tailnet.mjs')
  assert.match(formatTailnetStatus({}), /unknown \(server predates tailnet detection status\)/)
  const status = formatTailnetStatus({ tailnetDetection: { status: 'unavailable', reason: 'fixture unavailable' } })
  assert.match(status, /unavailable \(fixture unavailable\)/)
  assert.doesNotMatch(status, /will fail/)
})

test('status identifies a missing hostname without denying a usable native IP link', async () => {
  const { formatTailnetStatus } = await import('../../../../plugin/bin/lib/artifact-tailnet.mjs')
  const status = formatTailnetStatus({
    tailnetDetection: { status: 'unavailable', reason: 'tailnet hostname unavailable: fixture' },
    remoteUrl: `http://100.64.0.1:${PORT}`, tailnetVia: 'native',
  })
  assert.match(status, /hostname unavailable/)
  assert.doesNotMatch(status, /remote links will fail/, 'a detected native IP link does not depend on hostname admission')
})

test('an in-flight detection is not duplicated after the minute throttle elapses', async () => {
  const { createTailnetRetry } = await import('../../../../plugin/bin/lib/artifact-tailnet.mjs')
  let clock = 0
  let attempts = 0
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const retry = createTailnetRetry({ now: () => clock, detect: () => { attempts++; return pending } })
  const state = { dnsName: null, detection: { status: 'unavailable' } }
  const first = retry(state, PORT, DNS)
  await Promise.resolve()
  clock = 60001
  const concurrent = retry(state, PORT, DNS)
  release(state)
  await first
  assert.equal(concurrent, null, 'one in-flight attempt must cover concurrent requests even after one minute')
  assert.equal(attempts, 1)
  assert.equal(await retry(state, PORT, DNS), state, 'completion must release the in-flight guard')
})

test('a rejected detection releases the in-flight slot without bypassing the minute throttle', async () => {
  const { createTailnetRetry } = await import('../../../../plugin/bin/lib/artifact-tailnet.mjs')
  const state = { dnsName: null, detection: { status: 'unavailable' } }
  for (const synchronous of [false, true]) {
    let clock = 0
    let attempts = 0
    const failure = new Error('fixture worker rejection')
    const retry = createTailnetRetry({ now: () => clock, detect: () => {
      if (++attempts > 1) return state
      if (synchronous) throw failure
      return Promise.reject(failure)
    } })
    await assert.rejects(retry(state, PORT, DNS), failure)
    clock = 59999
    assert.equal(retry(state, PORT, DNS), null, 'rejection must still charge the minute throttle')
    clock = 60000
    assert.equal(await retry(state, PORT, DNS), state, 'rejection must release the in-flight slot for the next eligible attempt')
    assert.equal(attempts, 2)
  }
})

test('a fully qualified tailnet Host triggers recovery with or without a port', async () => {
  const { createTailnetRetry } = await import('../../../../plugin/bin/lib/artifact-tailnet.mjs')
  const state = { dnsName: null, detection: { status: 'unavailable' } }
  for (const host of [`${DNS}.`, `${DNS.toUpperCase()}.:${PORT}`]) {
    let attempts = 0
    const retry = createTailnetRetry({ detect: () => { attempts++; return state } })
    assert.equal(await retry(state, PORT, host), state, 'a trailing DNS root dot must not prevent recovery')
    assert.equal(attempts, 1)
  }
})

async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function waitFor(read, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = read()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`fixture did not become ready within ${timeout} ms`)
}

function cli(args, env, cwd) {
  const child = spawn(process.execPath, [SERVER, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  return once(child, 'close').then(([code]) => ({ code, stdout, stderr }))
}

const WORKER_ATTEMPT_PRELOAD = `const Worker = threads.Worker
threads.Worker = class extends Worker {
  constructor(file, options) {
    super(file, options)
    if (options?.workerData?.artifactTailnetPort) fs.appendFileSync(dir + '/attempts', 'attempt\\n')
  }
}`

function fixturePreload(dir, pathResolution) {
  const file = path.join(dir, 'preload.cjs')
  writeFileSync(file, `
const fs = require('node:fs')
const net = require('node:net')
const cp = require('node:child_process')
const threads = require('node:worker_threads')
const { syncBuiltinESMExports } = require('node:module')
const dir = ${JSON.stringify(dir)}
const now = Date.now
Date.now = () => now() + Number(fs.readFileSync(dir + '/clock', 'utf8'))
const listen = net.Server.prototype.listen
net.Server.prototype.listen = function (...args) {
  if (args[1] !== '192.0.2.1') return listen.apply(this, args)
  fs.appendFileSync(dir + '/listeners', args[1] + '\\n')
  queueMicrotask(() => this.emit('error', Object.assign(new Error('fixture unowned address'), { code: 'EADDRNOTAVAIL' })))
  return this
}
// Unconditional seal: no mutation of detection may execute an installed host binary.
const run = cp.execFileSync
cp.execFileSync = (command, args, options) => {
  const allowed = ${Boolean(pathResolution)}
    ? command === 'tailscale' && fs.existsSync(dir + '/resolved')
    : command === process.execPath
  if (!allowed || !['ip', 'status', 'serve'].includes(args[0])) {
    throw Object.assign(new Error('fixture absent binary'), { code: 'ENOENT' })
  }
  try {
    return run(process.execPath, args, options)
  } catch (error) {
    fs.appendFileSync(dir + '/command-errors', JSON.stringify({ command: args[0], signal: error.signal, code: error.code }) + '\\n')
    throw error
  }
}
${WORKER_ATTEMPT_PRELOAD}
syncBuiltinESMExports()
`)
  return file
}

async function fixture(context, { pathResolution = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wt-tailnet-'))
  const port = await freePort()
  const env = {
    ...process.env, XDG_STATE_HOME: dir, WT_ARTIFACT_SERVER_PORT: String(port),
    WT_ARTIFACT_SERVER_TAILSCALE_BINARY: pathResolution ? '' : process.execPath, WT_ARTIFACT_SERVER_IDLE_GRACE_S: '600',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(fixturePreload(dir, pathResolution))}`,
  }
  writeFileSync(path.join(dir, 'clock'), '0')
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

function get(port, host, pathname = '/', connectHost = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const req = request({ host: connectHost, port, path: pathname, headers: { Host: host }, agent: false }, (response) => {
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
  const server = await fixture(context, { pathResolution: true })
  assert.equal(server.read().tailnetDetection.status, 'unavailable')
  assert.equal(server.read().tailnetBinary, null)
  writeFileSync(path.join(server.dir, 'ip'), "console.log('192.0.2.1')\n")
  writeFileSync(path.join(server.dir, 'resolved'), '')
  assert.equal(await get(server.port, 'evil.example'), 421)
  assert.equal(server.read().tailnetDetection.status, 'unavailable', 'unrelated hosts must not trigger recovery')
  await get(server.port, DNS)
  const state = await waitFor(() => server.read()?.tailnetDetection.status === 'available' && server.read())
  assert.equal(await get(server.port, DNS), 200, 'the next tailnet Host must recover without restarting')
  assert.equal(state.tailnetDetection.status, 'available')
  assert.equal(state.remoteUrl, `https://${DNS}/artifacts`)
  const listeners = existsSync(path.join(server.dir, 'listeners')) ? readFileSync(path.join(server.dir, 'listeners'), 'utf8').trim().split('\n') : []
  await context.test('recovery listener wiring', () => {
    assert.deepEqual(listeners, ['192.0.2.1'], 'recovery must attempt the detected non-loopback listener')
  })
  await context.test('recovery execution side persistence', () => {
    assert.equal(state.tailnetVia, 'native', 'recovery must publish its execution side')
  })
  await context.test('recovery binary persistence', () => {
    assert.equal(state.tailnetBinary, 'tailscale', 'recovery must publish its resolved binary')
  })
  await context.test('recovery Serve route persistence', () => {
    assert.equal(state.tailnetServeUrl, `https://${DNS}/artifacts`, 'recovery must publish its Serve route')
  })
  assert.equal(await get(server.port, 'evil.example'), 421)
  assert.equal(await get(server.port, 'evil.ts.net'), 421, 'a tailnet-shaped Host is not automatically trusted')
})

test('fully qualified tailnet Hosts recover and admit only the detected hostname and port', async (context) => {
  const server = await fixture(context)
  writeFileSync(path.join(server.dir, 'ip'), "console.log('127.0.0.1')")
  const dotted = `${DNS.toUpperCase()}.:${server.port}`
  assert.equal(await get(server.port, dotted), 421)
  const recovered = await waitFor(() => server.read()?.tailnetDetection.status === 'available', 3000).catch(() => false)
  assert.ok(recovered, 'a fully qualified Host must trigger recovery after unavailable startup detection')
  for (const host of [dotted, `${DNS}.`, DNS, `${DNS}:${server.port}`]) {
    assert.equal(await get(server.port, host), 200, 'the detected hostname must admit its trailing-dot spelling')
  }
  for (const host of ['evil.ts.net.', `${DNS}.:1`, `${DNS}..`, `${DNS}.evil.example`]) {
    assert.equal(await get(server.port, host), 421, 'normalization must preserve hostname and port admission boundaries')
  }
})

test('a SIGTERM-ignoring command times out and releases recovery for a later successful attempt', async (context) => {
  const server = await fixture(context)
  writeFileSync(path.join(server.dir, 'ip'), `
const fs = require('node:fs')
process.on('SIGTERM', () => {})
fs.writeFileSync('started', String(process.pid))
const timer = setInterval(() => {
  if (!fs.existsSync('release')) return
  clearInterval(timer)
  console.log('127.0.0.1')
}, 10)
setTimeout(() => process.exit(0), 15000).unref()
`)
  try {
    assert.equal(await get(server.port, DNS), 421)
    await waitFor(() => existsSync(path.join(server.dir, 'started')))
    assert.equal(await get(server.port, `localhost:${server.port}`, '/__wt-artifact-server/health'), 200)
    const timedOut = await waitFor(() => /timeout=5000ms/.test(server.read()?.tailnetDetection.reason), 6500).catch(() => false)
    assert.ok(timedOut, 'a SIGTERM-ignoring command must settle within its timeout budget')
    assert.match(server.read().tailnetDetection.reason, /signal=SIGKILL/)
    writeFileSync(path.join(server.dir, 'ip'), "console.log('127.0.0.1')")
    writeFileSync(path.join(server.dir, 'clock'), '60001')
    await get(server.port, DNS)
    await waitFor(() => server.read()?.tailnetDetection.status === 'available')
    assert.equal(await get(server.port, DNS), 200, 'the timed-out command must not retain the recovery slot')
  } finally {
    // Independent cleanup also releases the old implementation and timeout-guard mutations.
    writeFileSync(path.join(server.dir, 'release'), '')
    await waitFor(() => server.read()?.tailnetDetection.status === 'available' || /timeout=5000ms/.test(server.read()?.tailnetDetection.reason))
  }
})

function resistTermination(dir, command) {
  const output = readFileSync(path.join(dir, command), 'utf8')
  writeFileSync(path.join(dir, command), `
const fs = require('node:fs')
process.on('SIGTERM', () => {})
fs.writeFileSync('started', String(process.pid))
const timer = setInterval(() => {
  if (!fs.existsSync('release')) return
  clearInterval(timer)
  ${output}
}, 10)
setTimeout(() => process.exit(0), 15000).unref()
`)
  return output
}

function commandErrors(dir) {
  const file = path.join(dir, 'command-errors')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []
}

for (const command of ['status', 'serve']) {
  test(`a SIGTERM-ignoring ${command} command is killed at timeout and releases recovery`, async (context) => {
    const server = await fixture(context)
    // Failed address detection still probes status/Serve, while keeping later Host recovery eligible.
    writeFileSync(path.join(server.dir, 'ip'), 'process.exitCode = 2')
    const output = resistTermination(server.dir, command)
    try {
      assert.equal(await get(server.port, DNS), 421)
      const pid = await waitFor(() => existsSync(path.join(server.dir, 'started')) && Number(readFileSync(path.join(server.dir, 'started'), 'utf8')))
      const timedOut = await waitFor(() => commandErrors(server.dir).find((error) => error.command === command), 6500).catch(() => null)
      assert.ok(timedOut, `a SIGTERM-ignoring ${command} command must be killed within its timeout budget`)
      assert.equal(timedOut.signal, 'SIGKILL', `${command} must be forcibly killed, not released normally`)
      assert.equal(timedOut.code, 'ETIMEDOUT')
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the timed-out child must no longer exist')
      await waitFor(() => /exit=2/.test(server.read()?.tailnetDetection.reason))
      writeFileSync(path.join(server.dir, command), output)
      writeFileSync(path.join(server.dir, 'ip'), "console.log('127.0.0.1')")
      writeFileSync(path.join(server.dir, 'clock'), '60001')
      await get(server.port, DNS)
      const recovered = await waitFor(() => server.read()?.tailnetServeUrl, 3000).catch(() => null)
      assert.equal(recovered, `https://${DNS}/artifacts`, `${command} timeout must release the recovery slot for a later attempt`)
      assert.equal(await get(server.port, DNS), 200)
    } finally {
      // Release resistant children even when the timeout or kill signal is mutated.
      writeFileSync(path.join(server.dir, 'release'), '')
      await waitFor(() => /exit=2/.test(server.read()?.tailnetDetection.reason) || server.read()?.tailnetDetection.status === 'available')
    }
  })
}

const PREVIOUS_RESULTS = [
  ['partial', "console.log('127.0.0.1')", 'process.exitCode = 2', (state) => state.remoteUrl?.startsWith('http://127.0.0.1:')],
  ['no-tailnet', '', null, (state) => state.tailnetDetection.status === 'no-tailnet'],
  ['error', 'process.exitCode = 2', null, (state) => /exit=2/.test(state.tailnetDetection.reason)],
]

test('repeated partial recovery reuses the bound native tailnet listener', { skip: process.platform !== 'linux' }, async (context) => {
  const server = await fixture(context)
  const remoteUrl = `http://127.0.0.2:${server.port}`
  writeFileSync(path.join(server.dir, 'ip'), "console.log('127.0.0.2')")
  writeFileSync(path.join(server.dir, 'status'), 'process.exitCode = 2')
  writeFileSync(path.join(server.dir, 'serve'), "console.log('No serve config')")
  assert.equal(await get(server.port, DNS), 421)
  const partial = await waitFor(() => server.read()?.remoteUrl === remoteUrl && server.read())
  assert.equal(await get(server.port, `127.0.0.2:${server.port}`, '/', '127.0.0.2'), 200, 'the first recovery must really bind the additional address listener')
  writeFileSync(path.join(server.dir, 'status'), `console.log(JSON.stringify({Self:{DNSName:'${DNS}.'}}))`)
  writeFileSync(path.join(server.dir, 'clock'), '60001')
  await get(server.port, DNS)
  const recovered = await waitFor(() => server.read()?.tailnetDetection.reason !== partial.tailnetDetection.reason && server.read())
  assert.equal(recovered.remoteUrl, remoteUrl, 'recovering the hostname must retain the already-listening native IP URL')
  assert.equal(recovered.tailnetDetection.status, 'available')
  assert.equal(await get(server.port, DNS), 200)
})

for (const [shape, ip, status, matches] of PREVIOUS_RESULTS) {
  test(`a ${shape} result remains retryable after the minute throttle and later admits the Host`, async (context) => {
    const server = await fixture(context)
    writeFileSync(path.join(server.dir, 'ip'), ip)
    if (status) writeFileSync(path.join(server.dir, 'status'), status)
    assert.equal(await get(server.port, DNS), 421)
    await waitFor(() => matches(server.read()))
    writeFileSync(path.join(server.dir, 'ip'), "console.log('127.0.0.1')")
    writeFileSync(path.join(server.dir, 'status'), `console.log(JSON.stringify({Self:{DNSName:'${DNS}.'}}))`)
    assert.equal(await get(server.port, DNS), 421, 'the minute throttle must survive an unsuccessful attempt')
    await context.test(`${shape} result does not launch another recovery worker before one minute`, async () => {
      // A subsequent local response drains the triggering handler's microtasks, including worker creation.
      assert.equal(await get(server.port, `localhost:${server.port}`, '/__wt-artifact-server/health'), 200)
      assert.equal(readFileSync(path.join(server.dir, 'attempts'), 'utf8'), 'attempt\n', `${shape} result must not start an early recovery worker`)
    })
    writeFileSync(path.join(server.dir, 'clock'), '60001')
    await get(server.port, DNS)
    const recovered = await waitFor(() => server.read()?.tailnetDetection.status === 'available' && server.read()?.tailnetServeUrl, 3000).catch(() => null)
    assert.ok(recovered, `${shape} results must remain eligible for a retry after one minute`)
    assert.equal(await get(server.port, DNS), 200, `${shape} recovery must admit the next matching Host`)
  })
}

for (const command of ['ip', 'status', 'serve']) {
  test(`local health completes while request recovery waits for the ${command} detection command`, async (context) => {
    const server = await fixture(context)
    writeFileSync(path.join(server.dir, 'ip'), "console.log('127.0.0.1')")
    const output = readFileSync(path.join(server.dir, command), 'utf8')
    writeFileSync(path.join(server.dir, command), `
const fs = require('node:fs')
fs.appendFileSync('started', 'attempt\\n')
const timer = setInterval(() => {
  if (!fs.existsSync('release')) return
  clearInterval(timer)
  ${output}
}, 10)
`)
    const triggering = get(server.port, DNS)
    await waitFor(() => existsSync(path.join(server.dir, 'started')))
    let timer
    try {
      const local = get(server.port, `localhost:${server.port}`, '/__wt-artifact-server/health')
      const result = await Promise.race([local, new Promise((resolve) => { timer = setTimeout(() => resolve('blocked'), 1000) })])
      assert.equal(result, 200, 'a local health request must complete before the detection command is released')
      writeFileSync(path.join(server.dir, 'clock'), '60001')
      assert.equal(await get(server.port, DNS), 421, 'concurrent triggering requests use the current admission decision')
      assert.equal(readFileSync(path.join(server.dir, 'started'), 'utf8'), 'attempt\n', 'concurrent requests must share one in-flight attempt even past the throttle')
    } finally {
      clearTimeout(timer)
      writeFileSync(path.join(server.dir, 'release'), '')
      await triggering
      await waitFor(() => server.read()?.tailnetDetection.status === 'available')
    }
    assert.equal(await get(server.port, DNS), 200)
  })
}
