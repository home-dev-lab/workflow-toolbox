import { mkdirSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'

// A crashed controller leaves a claim for explicit cleanup, never timed reclamation
// that might admit a second controller while the first is merely descheduled.
export function acquireArtifactControlClaim(directory) {
  const claim = join(directory, 'control.d')
  try { mkdirSync(claim, { mode: 0o700 }) } catch { return null }
  let released = false
  return () => {
    if (released) return
    released = true
    rmdirSync(claim)
  }
}
