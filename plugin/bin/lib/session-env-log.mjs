import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ensureLaneHostDir } from './host/lane-host-dir.mjs'

// A runner owns this marker for the duration of each launch, so every start replaces it.
export function recordSessionEnvLog(dir, env = process.env) {
  try {
    const logPath = path.join(ensureLaneHostDir(dir), 'env.log')
    mkdirSync(path.dirname(logPath), { recursive: true })
    writeFileSync(logPath, `CLAUDE_CODE_SESSION_ID=${env.CLAUDE_CODE_SESSION_ID ?? ''}\n`)
    return true
  } catch {
    return false
  }
}
