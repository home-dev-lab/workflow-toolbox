import { spawn } from 'node:child_process'
export function launchProcess(program, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { ...options, shell: false })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve(signal ? 124 : (code ?? 1)))
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
