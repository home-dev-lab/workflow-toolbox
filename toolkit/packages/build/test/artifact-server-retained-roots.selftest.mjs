import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, request } from 'node:http'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'
import { isInvokedDirectly } from '../../../../plugin/bin/lib/host/entry-guard.mjs'

const SERVER = process.env.WT_RETAINED_TEST_SERVER ?? fileURLToPath(new URL('../../../../plugin/bin/wt-artifact-server.mjs', import.meta.url))
let spawnProcess = spawn
const scratch = []
const children = new Set()

function temporary() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'artifact-retained-')))
  scratch.push(dir)
  return dir
}

async function until(read) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const result = await read()
    if (result !== undefined) return result
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`condition not reached: ${read.toString()}`)
}

async function stop(child, signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return
  const done = new Promise((resolve) => child.once('exit', () => resolve()))
  child.kill(signal)
  await done
}

async function cleanup() {
  for (const child of children) await stop(child)
  children.clear()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
}

function launch(env) {
  const child = spawnProcess(process.execPath, [SERVER, 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  let stderr = ''
  child.stderr?.on('data', (value) => { stderr += String(value) })
  return { child, stderr: () => stderr }
}

function cli(env, ...args) {
  return spawnSync(process.execPath, [SERVER, ...args], { env, encoding: 'utf8', timeout: 10_000 })
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(() => resolve()))
  return port
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: pathname, agent: false, headers: { Host: `localhost:${port}` } }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += String(chunk) })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.once('error', reject)
    req.end()
  })
}

async function fixture(extra = {}) {
  const home = temporary()
  const root = join(home, 'reports')
  mkdirSync(root)
  for (const file of ['ok.txt', 'private.txt', '.env', 'other.txt']) writeFileSync(join(root, file), file)
  const port = await freePort()
  const stateDir = join(home, 'wt-artifact-server')
  const registrations = join(stateDir, 'registrations')
  mkdirSync(registrations, { recursive: true, mode: 0o700 })
  const env = { ...process.env, CLAUDE_CONFIG_DIR: home, XDG_STATE_HOME: home,
    WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_IDLE_GRACE_S: '0.2',
    WT_ARTIFACT_SERVER_REGISTRATION_POLL_MS: '20', WT_ARTIFACT_SERVER_RETAIN_DAYS: '30',
    WT_ARTIFACT_SERVER_TAILSCALE_BINARY: process.execPath, ...extra }
  const register = (id, pid, deny = ['.env'], name = 'reports', directory = root) => {
    writeFileSync(join(registrations, `${id}.json`), JSON.stringify({ pid, roots: [{ name, path: directory }], deny, startedAt: new Date().toISOString() }), { mode: 0o600 })
  }
  register('holder', process.pid, [], 'holder', home)
  const registrant = spawnProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  children.add(registrant)
  register('project', registrant.pid)
  const readState = () => {
    try { return JSON.parse(readFileSync(join(stateDir, 'server.json'), 'utf8')) } catch { return undefined }
  }
  const start = async (settings = env) => {
    const server = launch(settings)
    await until(() => { const s = readState(); return s?.pid === server.child.pid ? s : undefined })
    return server
  }
  const departed = async () => {
    await stop(registrant, 'SIGKILL')
    await until(() => existsSync(join(registrations, 'project.json')) ? undefined : true)
  }
  const record = join(stateDir, 'retained', `${createHash('sha256').update(root).digest('hex')}.json`)
  return { home, root, port, stateDir, registrations, env, register, registrant, readState, start, departed, record,
    fetch: (pathname = '/reports/ok.txt') => get(port, pathname) }
}

const cases = [
['retains a departed canonical root and its name across restart; never registers an unknown mount', async () => {
  const f = await fixture()
  const server = await f.start()
  await f.departed()
  assert.equal((await f.fetch()).status, 200, 'departed root remains served')
  const retained = f.readState()?.roots.find((r) => r.name === 'reports')
  assert.equal(retained?.path, f.root)
  assert.equal(retained?.retained, true)
  assert.equal(typeof retained?.lastLiveAt, 'number')
  await stop(server.child)
  await f.start()
  assert.equal((await f.fetch()).status, 200, 'same retained URL survives restart')
  assert.equal((await f.fetch('/never-registered/ok.txt')).status, 404, 'never-registered first segment is refused')
  assert.equal(cli(f.env, 'url', join(f.root, 'ok.txt')).stdout.trim(), `http://localhost:${f.port}/reports/ok.txt`)
  assert.ok(cli(f.env, 'status').stdout.includes('reports=' + f.root + ' (retained, last live '))
}],

['retains the union of simultaneous live deny policies and all request-target checks', async () => {
  const f = await fixture()
  f.register('second', f.registrant.pid, ['private.txt', 'other.txt'])
  await f.start()
  await f.departed()
  for (const file of ['.env', 'private.txt', 'other.txt']) assert.equal((await f.fetch('/reports/' + file)).status, 403)
  assert.equal((await f.fetch('/reports/%2e%2e/outside')).status, 403)
  assert.equal((await f.fetch()).status, 200)
}],

['seeds retained names before a colliding live root joins after restart', async () => {
  const f = await fixture()
  const server = await f.start()
  await f.departed()
  await stop(server.child)
  const other = join(f.home, 'other-reports')
  mkdirSync(other)
  writeFileSync(join(other, 'ok.txt'), 'different report')
  f.register('colliding', process.pid, [], 'reports', other)
  await f.start()
  assert.equal((await f.fetch()).status, 200)
  assert.ok((await f.fetch()).body.includes('ok.txt'))
  const retained = f.readState().roots.find((r) => r.path === f.root)
  const live = f.readState().roots.find((r) => r.path === other)
  assert.equal(retained.name, 'reports', 'retained name remains reserved across restart')
  assert.notEqual(live.name, retained.name)
}],

['retains only the final live deny union after staggered departures', async () => {
  const f = await fixture()
  f.register('second', process.pid, ['private.txt'])
  await f.start()
  await f.departed()
  assert.equal((await f.fetch('/reports/.env')).status, 200)
  rmSync(join(f.registrations, 'second.json'))
  await until(() => f.readState()?.roots.find((r) => r.name === 'reports')?.retained ? true : undefined)
  assert.equal((await f.fetch('/reports/private.txt')).status, 403)
  assert.equal((await f.fetch('/reports/.env')).status, 200)
}],

['retained requests reject escaping and denied symlink targets and a retargeted declared root', async () => {
  if (process.platform === 'win32') return // Creating file symlinks requires an OS privilege on Windows.
  const f = await fixture()
  writeFileSync(join(f.home, 'outside.txt'), 'outside')
  symlinkSync(join(f.home, 'outside.txt'), join(f.root, 'escape.txt'))
  symlinkSync(join(f.root, '.env'), join(f.root, 'alias.txt'))
  await f.start()
  await f.departed()
  assert.equal((await f.fetch('/reports/escape.txt')).status, 403)
  assert.equal((await f.fetch('/reports/alias.txt')).status, 403)
  renameSync(f.root, join(f.home, 'old-reports'))
  symlinkSync(join(f.home, 'old-reports'), f.root)
  assert.equal((await f.fetch()).status, 404)
}],

['forget retires a non-live root during scans and across restart, and re-registration revives it', async () => {
  const f = await fixture()
  let server = await f.start()
  await f.departed()
  const forgotten = cli(f.env, 'forget', 'reports')
  assert.equal(forgotten.status, 0, forgotten.stderr)
  assert.ok(forgotten.stdout.includes('forget requested: reports (' + f.root + ')'))
  await until(async () => (await f.fetch()).status === 404 ? true : undefined)
  await stop(server.child)
  server = await f.start()
  assert.equal((await f.fetch()).status, 404)
  f.register('again', process.pid)
  await until(async () => (await f.fetch()).status === 200 ? true : undefined)
  await stop(server.child)
  rmSync(join(f.registrations, 'again.json'))
  assert.equal(cli(f.env, 'forget', 'reports').status, 0)
  await f.start()
  assert.equal((await f.fetch()).status, 404)
  assert.equal(cli(f.env, 'forget', 'unknown').stderr, 'no retained root named unknown\n')
  assert.equal(cli(f.env, 'forget', 'unknown').status, 1)
}],

['forget while live is ignored with a diagnostic and remains retained on departure', async () => {
  const f = await fixture()
  const server = await f.start()
  assert.equal(cli(f.env, 'forget', 'reports').status, 0)
  await until(() => server.stderr().includes('forget ignored while live: reports') ? true : undefined)
  assert.equal((await f.fetch()).status, 200)
  await f.departed()
  assert.equal((await f.fetch()).status, 200)
}],

['forget reports marker write failures and refuses malformed command arguments', async () => {
  const f = await fixture()
  const server = await f.start()
  await stop(server.child)
  const directory = join(f.stateDir, 'forgotten')
  rmSync(directory, { recursive: true })
  writeFileSync(directory, 'not a directory')
  const failed = cli(f.env, 'forget', 'reports')
  assert.equal(failed.status, 1)
  assert.ok(failed.stderr.length > 0)
  assert.equal(cli(f.env, 'forget').status, 2)
  assert.equal(cli(f.env, 'forget', 'reports', 'extra').status, 2)
}],

['forget accepts a registered mount name beginning with a dash', async () => {
  for (const name of ['-reports', '--help', '-h', '--']) {
    const f = await fixture()
    f.register('project', f.registrant.pid, ['.env'], name)
    const server = await f.start()
    await f.departed()
    const route = `/${name}/ok.txt`
    assert.equal((await f.fetch(route)).status, 200)
    const result = cli(f.env, 'forget', ...(name === '-reports' ? [name] : ['--', name]))
    assert.equal(result.status, 0, 'registered mount names beginning with a dash can be forgotten')
    assert.ok(result.stdout.startsWith(`forget requested: ${name} `), 'literal flag-like mount is retired')
    await until(async () => (await f.fetch(route)).status === 404 ? true : undefined)
    await stop(server.child)
  }
}],

['retained roots do not count as sessions or prevent idle shutdown', async () => {
  const f = await fixture()
  const server = await f.start()
  await f.departed()
  const health = await f.fetch('/__wt-artifact-server/health')
  assert.equal(JSON.parse(health.body).registeredSessions, 1)
  assert.ok(cli(f.env, 'stop').stderr.includes('refusing with 1 registered session(s)'))
  assert.ok(cli(f.env, 'restart').stderr.includes('refusing with 1 registered session(s)'))
  assert.equal((await f.fetch()).status, 200)
  rmSync(join(f.registrations, 'holder.json'))
  await until(() => server.child.exitCode === 0 ? true : undefined)
}],

['retention zero preserves live-only serving and removes older live policy before re-enabling', async () => {
  const f = await fixture()
  let server = await f.start()
  await stop(server.child)
  f.register('project', f.registrant.pid, ['.env', 'private.txt'])
  server = await f.start({ ...f.env, WT_ARTIFACT_SERVER_RETAIN_DAYS: '0' })
  assert.equal(existsSync(f.record), false, 'disabled retention removes a live root stale policy')
  assert.equal((await f.fetch('/reports/private.txt')).status, 403)
  await f.departed()
  assert.equal((await f.fetch()).status, 404)
  await stop(server.child)
  await f.start()
  assert.equal((await f.fetch('/reports/private.txt')).status, 404)
}],

['failed stricter record write removes the weaker record before restart', async () => {
  const f = await fixture()
  let server = await f.start()
  assert.equal(existsSync(f.record), true, 'live root policy was persisted')
  await stop(server.child)
  const preload = join(f.home, 'fail-record.cjs')
  writeFileSync(preload, `const fs = require('node:fs'); const original = fs.renameSync;
fs.renameSync = (from, to) => { if (String(to) === ${JSON.stringify(f.record)}) throw new Error('injected record write failure'); return original(from, to) };
require('node:module').syncBuiltinESMExports();`)
  f.register('project', f.registrant.pid, ['.env', 'private.txt'])
  server = await f.start({ ...f.env, NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(preload)}` })
  assert.equal(existsSync(f.record), false, 'failed update removes stale weaker record')
  assert.equal((await f.fetch('/reports/private.txt')).status, 403)
  await f.departed()
  await stop(server.child)
  await f.start()
  assert.equal((await f.fetch('/reports/private.txt')).status, 404)
}],

['expires aged records at startup and removes their reservation', async () => {
  const f = await fixture()
  const server = await f.start()
  assert.equal(existsSync(f.record), true, 'root has a persisted observation')
  await stop(server.child)
  await stop(f.registrant)
  const record = JSON.parse(readFileSync(f.record, 'utf8'))
  record.lastLiveAt = Date.now() - 31 * 86_400_000
  writeFileSync(f.record, JSON.stringify(record), { mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(f.record, 0o600)
  await f.start()
  assert.equal((await f.fetch()).status, 404)
  assert.equal(existsSync(f.record), false)
}],

['marker-read failure during a stricter live scan never restores a weaker retained HTTP policy', async () => {
  const f = await fixture()
  const flag = join(f.home, 'fail-marker-read')
  const preload = join(f.home, 'fail-marker-read.cjs')
  writeFileSync(preload, `const fs = require('node:fs'); const original = fs.readdirSync;
fs.readdirSync = (directory, ...args) => {
  if (String(directory) === ${JSON.stringify(join(f.stateDir, 'forgotten'))} && fs.existsSync(${JSON.stringify(flag)})) throw new Error('injected marker read failure');
  return original(directory, ...args);
}; require('node:module').syncBuiltinESMExports();`)
  const server = await f.start({ ...f.env, NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(preload)}` })
  writeFileSync(flag, '')
  f.register('stricter', f.registrant.pid, ['private.txt'])
  await until(async () => (await f.fetch('/reports/private.txt')).status === 403 ? true : undefined)
  await f.departed()
  await until(() => existsSync(join(f.registrations, 'stricter.json')) ? undefined : true)
  rmSync(flag)
  await until(() => f.readState()?.roots.find((r) => r.name === 'reports')?.retained ? true : undefined)
  assert.equal((await f.fetch('/reports/private.txt')).status, 403, 'marker read failure cannot restore weaker retained policy')
  assert.equal(server.stderr().split('injected marker read failure').length - 1, 1, 'marker read failure logs once')
}],

['unknown forget-marker state refuses retained HTTP roots while keeping live roots available', async () => {
  const f = await fixture()
  const flag = join(f.home, 'unreadable-markers')
  const preload = join(f.home, 'unknown-markers.cjs')
  writeFileSync(preload, `const fs = require('node:fs'); const original = fs.readdirSync;
fs.readdirSync = (directory, ...args) => {
  if (String(directory) === ${JSON.stringify(join(f.stateDir, 'forgotten'))} && fs.existsSync(${JSON.stringify(flag)})) throw new Error('unknown HTTP marker state');
  return original(directory, ...args);
}; require('node:module').syncBuiltinESMExports();`)
  const server = await f.start({ ...f.env, NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(preload)}` })
  await f.departed()
  assert.equal((await f.fetch()).status, 200)
  writeFileSync(flag, '')
  await until(() => server.stderr().includes('unknown HTTP marker state') ? true : undefined)
  assert.equal((await f.fetch()).status, 404, 'unknown marker state must refuse retained HTTP authority')
  assert.equal((await f.fetch('/holder/reports/ok.txt')).status, 200, 'live holder stays available during marker failure')
  rmSync(flag)
  await until(async () => (await f.fetch()).status === 200 ? true : undefined)
}],

['failed stricter update plus failed removal cannot restore weaker HTTP policy on restart', async () => {
  const f = await fixture()
  let server = await f.start()
  await stop(server.child)
  const preload = join(f.home, 'fail-update-remove.cjs')
  writeFileSync(preload, `const fs = require('node:fs'); const rename = fs.renameSync, remove = fs.rmSync;
fs.renameSync = (from, to) => { if (String(to) === ${JSON.stringify(f.record)}) throw new Error('record update failed'); return rename(from, to) };
fs.rmSync = (file, options) => { if (String(file) === ${JSON.stringify(f.record)}) throw new Error('record removal failed'); return remove(file, options) };
require('node:module').syncBuiltinESMExports();`)
  f.register('project', f.registrant.pid, ['.env', 'private.txt'])
  server = await f.start({ ...f.env, NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(preload)}` })
  assert.equal(existsSync(f.record), true, 'injected removal failure leaves the stale record on disk')
  assert.equal((await f.fetch('/reports/private.txt')).status, 403)
  await f.departed()
  assert.equal((await f.fetch('/reports/private.txt')).status, 404)
  await stop(server.child)
  await f.start()
  assert.equal((await f.fetch('/reports/private.txt')).status, 404, 'restart must not restore stale weaker HTTP policy')
}],

['checks retention age at request time before the next registration scan', async () => {
  const f = await fixture({ WT_ARTIFACT_SERVER_RETAIN_DAYS: '1' })
  const server = await f.start()
  assert.equal(existsSync(f.record), true, 'root was retained')
  await f.departed()
  await stop(server.child)
  const record = JSON.parse(readFileSync(f.record, 'utf8'))
  const clock = join(f.home, 'request-clock')
  const preload = join(f.home, 'request-clock.cjs')
  writeFileSync(clock, String(record.lastLiveAt))
  writeFileSync(preload, `const fs = require('node:fs'); Date.now = () => Number(fs.readFileSync(${JSON.stringify(clock)}, 'utf8'));`)
  await f.start({ ...f.env, WT_ARTIFACT_SERVER_REGISTRATION_POLL_MS: '60000',
    NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(preload)}` })
  assert.equal((await f.fetch()).status, 200)
  writeFileSync(clock, String(record.lastLiveAt + 86_400_001))
  assert.equal((await f.fetch()).status, 404, 'expired retained root rejected between scans')
}],
]

export function registerRetainedRootIntegrationTests(hooks) {
  spawnProcess = hooks.spawnProcess ?? spawn
  hooks.afterEach(cleanup)
  for (const [name, run] of cases) hooks.test(name, run)
}

if (isInvokedDirectly(import.meta.url)) registerRetainedRootIntegrationTests({ test, afterEach })
