// Owns child-process receipts and process-group cleanup; it must not know lifecycle phases or state.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
export function launchProcess(program, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { ...options, shell: false })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve(signal ? 124 : (code ?? 1)))
  })
}
export function launchProcessWithOutput(program, args, options) {
  const { stdoutPath, stderrPath, ...spawnOptions } = options
  if (!stdoutPath || !stderrPath) throw new Error('launch output paths are required')
  const stdoutFd = fs.openSync(stdoutPath, 'wx', 0o600)
  let stderrFd
  try {
    stderrFd = fs.openSync(stderrPath, 'wx', 0o600)
  } catch (error) {
    fs.closeSync(stdoutFd)
    throw error
  }
  return new Promise((resolve, reject) => {
    let closed = false
    const closeOutput = () => {
      if (closed) return
      closed = true
      fs.closeSync(stdoutFd)
      fs.closeSync(stderrFd)
    }
    let child
    try {
      child = spawn(program, args, { ...spawnOptions, shell: false, stdio: ['ignore', stdoutFd, stderrFd] })
    } catch (error) {
      closeOutput()
      reject(error)
      return
    }
    child.once('error', (error) => { closeOutput(); reject(error) })
    child.once('close', (code, signal) => {
      closeOutput()
      resolve({ code: signal ? 124 : (code ?? 1), stdout: fs.readFileSync(stdoutPath, 'utf8'), stderr: fs.readFileSync(stderrPath, 'utf8') })
    })
  })
}
export async function waitForLaneReceipt({ log, nonce, timeoutMs, launchedAt, pollMs, readAttestation, readRegularFile }) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const entry = readAttestation(log)
    const content = readRegularFile(log)
    if (entry?.exit && entry.mtime >= launchedAt && content?.startsWith(`LANE_NONCE=${nonce}\n`)) return entry
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  return null
}
