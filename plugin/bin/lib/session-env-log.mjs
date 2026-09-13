import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// A runner owns this marker for the duration of each launch, so every start replaces it.
export function recordSessionEnvLog(dir, env = process.env) {
  const logPath = path.join(dir, '.lane', 'env.log')
  try {
    mkdirSync(path.dirname(logPath), { recursive: true })
    writeFileSync(logPath, `CLAUDE_CODE_SESSION_ID=${env.CLAUDE_CODE_SESSION_ID ?? ''}\n`)
    return true
  } catch {
    return false
  }
}
