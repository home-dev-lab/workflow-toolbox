import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const repo = process.env.WT_LAUNCHER_TEST_ROOT ?? fileURLToPath(new URL('../../../../../', import.meta.url))
export const moduleUrl = (file) => pathToFileURL(path.join(repo, 'plugin/bin', file)).href
export const events = await import(moduleUrl('lib/host/launcher-events.mjs'))
export const routing = await import(moduleUrl('lib/launcher-routing.mjs'))
export const notices = await import(moduleUrl('lib/lane-exit-notices.mjs'))

export function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'launcher-event-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const stateRoot = path.join(root, 'host'), livenessDir = path.join(root, 'live')
  mkdirSync(stateRoot); mkdirSync(livenessDir)
  const options = { stateRoot, livenessDir, now: Date.now() }
  options.monotonicClock = () => options.now
  const record = { owner: 'session', ownerSessionId: 'session', launcherAgentId: 'delegate',
    runId: '10-20', worktree: root, state: 'exited', exitedAt: new Date(options.now).toISOString(), exit: 0 }
  return { root, options, record, box: path.join(root, 'wt-launcher-events', 'delegate') }
}

export function live(f, complete = false) {
  writeFileSync(path.join(f.options.livenessDir, 'delegate.json'), JSON.stringify({ agentId: 'delegate', complete }))
}

export function scanner(f, extra = {}) {
  const lines = [], errors = []
  const store = { load: () => ({ entries: new Map(), through: f.through ?? null, baseline: false }),
    records: () => [{ record: f.record, modifiedAt: f.options.now }], reportPresent: () => false }
  const sweep = notices.createLaneExitNotices({ ...f.options, sessionId: 'session', clock: () => f.options.now,
    store, stdout: (line) => { lines.push(line) }, stderr: (line) => { errors.push(line) }, write: () => {}, ...extra })
  return { sweep, lines, errors }
}

export function program(f, body) {
  return `import fs from 'node:fs'; import assert from 'node:assert/strict';
    import {syncBuiltinESMExports} from 'node:module';
    const options = ${JSON.stringify(f.options)}, record = ${JSON.stringify(f.record)};
    const pause = new Int32Array(new SharedArrayBuffer(4));
    const hold = () => { process.send('held'); const until=Date.now()+10000;
      while(!fs.existsSync(${JSON.stringify(path.join(f.root, 'release'))}) && Date.now()<until) Atomics.wait(pause,0,0,5); };
    const eventUrl = ${JSON.stringify(moduleUrl('lib/host/launcher-events.mjs'))};
    const routingUrl = ${JSON.stringify(moduleUrl('lib/launcher-routing.mjs'))};
    ${body}`
}

export function fresh(f, body, expected = 0) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program(f, body)], { encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, expected, `caller exit must remain ${expected}: ${result.stderr}`)
  return result
}

export async function held(t, f, body) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', program(f, body)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const output = [], errors = []
  child.stdout.on('data', (bytes) => output.push(bytes.toString()))
  child.stderr.on('data', (bytes) => errors.push(bytes.toString()))
  const ended = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended })
  await once(child, 'message', { signal: AbortSignal.timeout(5000) }).catch((error) => { throw new Error(`${error.message}: ${errors.join('')}`) })
  return { child, ended, output }
}
