import { spawn } from 'node:child_process'
import { closeSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { offloadFrame, relayOffloadLog } from './suite-lock-offload-log.mjs'
import { openOffloadDirectory } from './suite-lock-offload-directory.mjs'

const MAX_LINE = 64 * 1024
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9._:/@+-]{1,512}$/.test(value)

function completedResult(result) {
  return result?.outcome === 'completed' && Number.isInteger(result.exit) && result.exit >= 0 && result.exit <= 255 && validId(result.archive) && validId(result.snapshot)
}

function fallbackResult(result) {
  return result?.outcome === 'fallback' && typeof result.reason === 'string' && result.reason.length > 0 && result.reason.length <= 1024
}

export function parseOffloadResult(line) {
  let result
  try { result = JSON.parse(line) } catch { return { outcome: 'fallback', reason: 'malformed last line' } }
  if (fallbackResult(result) || completedResult(result)) return result
  return { outcome: 'fallback', reason: 'invalid terminal outcome' }
}

function killGroup(child, directory) {
  // Unlink before killing either cleanup owner; the relay already holds its reader open.
  try { rmSync(directory, { recursive: true, force: true }) } catch (error) {
    process.stderr.write(`workflow-toolbox: offload log cleanup failed: ${error.code}\n`)
  }
  if (!child.pid) return
  try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
    if (error.code !== 'ESRCH') process.stderr.write(`workflow-toolbox: offload group kill failed: ${error.code}\n`)
  }
}

function captureResult(child, directory, deadlineS, done) {
  const output = { tail: '', last: '' }
  let ended = false
  const finish = (result) => {
    if (ended) return
    ended = true; clearTimeout(timer); done(result)
  }
  const timer = setTimeout(() => { killGroup(child, directory); finish({ outcome: 'fallback', reason: 'offload deadline passed' }) }, deadlineS * 1000)
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (text) => {
    if (!appendOutput(output, text)) { killGroup(child, directory); finish({ outcome: 'fallback', reason: 'offload stdout line too large' }) }
  })
  child.once('error', (error) => finish({ outcome: 'fallback', reason: `offload spawn failed: ${error.code}` }))
  child.once('close', () => finish(parseOffloadResult(output.tail || output.last)))
  child.stdin.on('error', () => {})
  return () => { ended = true; clearTimeout(timer); killGroup(child, directory) }
}

function appendOutput(output, text) {
  const lines = (output.tail + text).split('\n')
  if (lines.some((line) => Buffer.byteLength(line, 'utf8') > MAX_LINE)) return false
  output.tail = lines.pop()
  if (lines.length) output.last = lines.at(-1)
  return true
}

function launchOffload(config, request, directory) {
  const fd = openOffloadDirectory(config.root, request.cwd)
  try {
    // Source lives only in host process memory/argv, outside every lane-writable filesystem root.
    return spawn(process.execPath, ['--input-type=module', '--eval', config.guardianSource, 'suite-lock-offload-guardian', config.command, directory, String(request.deadlineS)], {
      shell: false, detached: true, cwd: `/proc/self/fd/${fd}`, env: config.env, stdio: ['pipe', 'pipe', 'ignore', 'pipe'],
    })
  } finally { closeSync(fd) }
}

export function startSuiteOffload(config, request, socket, done) {
  const directory = mkdtempSync(path.join(tmpdir(), 'wt-suite-offload-'))
  const logPath = path.join(directory, 'output.log')
  writeFileSync(logPath, '', { mode: 0o600 })
  const relay = relayOffloadLog(socket, request.requestId, logPath, Date.now() + request.deadlineS * 1000)
  let stop
  try {
    const child = launchOffload(config, request, directory)
    stop = captureResult(child, directory, request.deadlineS, (result) => { killGroup(child, directory); done(result) })
    child.stdin.end(JSON.stringify({ version: 1, ...request, root: config.root, logPath }))
    offloadFrame(socket, request.requestId, 'progress', { state: 'started' })
  } catch (error) {
    relay.close(); rmSync(directory, { recursive: true, force: true }); throw error
  }
  return { stop: () => { stop(); relay.close(); rmSync(directory, { recursive: true, force: true }) },
    finish: async () => { try { await relay.finish() } finally { rmSync(directory, { recursive: true, force: true }) } } }
}
