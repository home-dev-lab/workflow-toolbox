// Run on a native host: node toolkit/packages/build/test/lane-queue-deadline.e2e.mjs
// Every lock, model command, state file and process belongs to this temporary fixture.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { laneHostDir, laneHostStateRoot } from '../../../../plugin/bin/lib/host/lane-host-dir.mjs'

const root = mkdtempSync(path.join(tmpdir(), 'lane-queue-e2e-'))
const plugin = fileURLToPath(new URL('../../../../plugin/bin/', import.meta.url))
const model = fileURLToPath(new URL('./fixtures/queue-opencode.mjs', import.meta.url))
const hostState = path.join(root, 'host'), lock = path.join(root, 'lock'), bin = path.join(root, 'bin')
const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), SystemRoot: process.env.SystemRoot, CLAUDE_CONFIG_DIR: path.join(root, 'config'), CLAUDE_PLUGIN_DATA: path.join(root, 'plugin-data'), XDG_STATE_HOME: path.join(root, 'state'), WT_LANE_HOST_STATE: hostState, WT_SUITE_LOCK_DIR: lock, WT_SUITE_LOCK_STATIC_LANE: '0', WT_LANE_SANDBOX_READ: path.dirname(model), WT_LANE_MODELS: 'openai/stub', WT_LANE_MIN_AVAILABLE_MIB: '0', WT_EXTERNAL_MODEL_ENV_ALLOW: 'WT_SUITE_LOCK_DIR' }
let holder
const workers = []

function text(file) {
  try { return readFileSync(file, 'utf8') } catch { return '' }
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function until(predicate, description) {
  const end = performance.now() + 60_000
  while (!predicate()) {
    if (performance.now() >= end) throw new Error(`timed out: ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function launch(name) {
  const dir = path.join(root, name)
  mkdirSync(path.join(dir, '.lane'), { recursive: true })
  const brief = path.join(dir, 'brief.md')
  writeFileSync(brief, '# Stub lane\n## Gates\nPrivate fixture gate only.\n')
  const result = spawnSync(process.execPath, [path.join(plugin, 'wt-lane.mjs'), '--dir', dir, '--model', 'openai/stub', '--brief', brief, '--allow-no-git', '--timeout', '20', '--decision-grace', '0', '--max-extensions', '0', '--idle-window', '1', '--owner', 'pilot', '--owner-token', 'fixture-owner'], { env, encoding: 'utf8', timeout: 30_000 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const host = laneHostDir(dir, { env })
  const pointerFile = path.join(host, 'supervision/current.json')
  await until(() => Boolean(text(pointerFile)), 'lane supervision pointer')
  const pointer = JSON.parse(readFileSync(pointerFile, 'utf8'))
  const stateFile = path.join(host, 'supervision', `${pointer.runId}.json`)
  workers.push(stateFile)
  return { log: path.join(host, 'run.log'), stateFile }
}

async function startHolder() {
  const module = new URL('../../../../plugin/bin/lib/suite-lock.mjs', import.meta.url).href
  const script = `import { acquireSuiteLock, releaseSuiteLock } from ${JSON.stringify(module)}; const lease = await acquireSuiteLock({ root: ${JSON.stringify(lock)} }); process.stdout.write('ready\\n'); const timer = setInterval(() => {}, 1000); process.on('SIGTERM', () => { releaseSuiteLock(lease); clearInterval(timer) })`
  holder = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'inherit'] })
  let ready = false
  holder.stdout.on('data', () => { ready = true })
  await until(() => ready, 'private holder ready')
  process.stdout.write(`private holder pid=${holder.pid}\n`)
}

async function runProof() {
  if (laneHostStateRoot({ env }) !== hostState) {
    process.stdout.write('e2e not run: this process is sandboxed; the launcher ignores private host-state overrides here. Run this script on the native host.\n')
    process.exitCode = 77
    return
  }
  if (process.platform !== 'linux') {
    process.stdout.write('e2e not run: the launcher installs its suite-lock broker in the Linux sandbox only.\n')
    process.exitCode = 77
    return
  }
  mkdirSync(bin); mkdirSync(env.CLAUDE_CONFIG_DIR)
  writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
  writeFileSync(path.join(bin, 'opencode'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(model)} "$@"\n`)
  chmodSync(path.join(bin, 'opencode'), 0o755)
  writeFileSync(path.join(bin, 'opencode.cmd'), `@echo off\r\n"${process.execPath}" "${model}" %*\r\n`)
  await startHolder()
  const queued = await launch('queued')
  const started = performance.now()
  await until(() => performance.now() - started >= 21_000 && /LANE_EXTENDED .*source=suite-lock-queue/.test(text(queued.log)), 'queue pause beyond timeout 20')
  assert.doesNotMatch(text(queued.log), /LANE_DECISION_NEEDED/)
  assert.equal(JSON.parse(text(queued.stateFile)).extensionCount, 0)
  process.stdout.write('queued: clock paused beyond timeout=20; extensionCount=0; decision-needed=0\n')
  holder.kill('SIGTERM')
  await until(() => holder.exitCode !== null || holder.signalCode !== null, 'holder release')
  await until(() => /^EXIT=0$/m.test(text(queued.log)), 'queued gate completion')
  assert.match(text(queued.log), /gate ran/)
  process.stdout.write('queued: holder released; gate ran; EXIT=0\n')
  const idle = await launch('idle')
  await until(() => /^EXIT=126$/m.test(text(idle.log)), 'idle abandonment')
  assert.match(text(idle.log), /TERMINATION=timeout/)
  process.stdout.write('idle: timeout=20; TERMINATION=timeout; EXIT=126\n')
}

try { await runProof() } finally {
  if (holder && holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL')
  if (holder) await until(() => holder.exitCode !== null || holder.signalCode !== null, 'private holder exit')
  for (const file of workers) {
    const state = JSON.parse(text(file) || '{}')
    if (!['exited', 'abandoned'].includes(state.state) && state.workerPid) {
      try { process.kill(state.workerPid, 'SIGTERM') } catch { /* already exited */ }
    }
    if (state.workerPid) await until(() => !alive(state.workerPid), 'fixture worker exit')
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
