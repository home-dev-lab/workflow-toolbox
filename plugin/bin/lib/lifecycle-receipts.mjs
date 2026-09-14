// Owns child-process receipts and process-group cleanup; it must not know lifecycle phases or state.
import { spawn } from 'node:child_process'
export function launchProcess(program, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { ...options, shell: false })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve(signal ? 124 : (code ?? 1)))
  })
}
export function launchProcessWithOutput(program, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { ...options, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code: signal ? 124 : (code ?? 1), stdout, stderr }))
  })
}
export async function terminateProcessGroup(pid, graceMs = 5000, pollMs = 25) {
  const signal = (name) => {
    try { process.kill(-pid, name); return true }
    catch (error) {
      if (error?.code === 'ESRCH') return false
      throw error
    }
  }
  if (!signal('SIGTERM')) return 'already-gone'
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    if (!signal(0)) return 'terminated'
  }
  signal('SIGKILL')
  return 'terminated'
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
