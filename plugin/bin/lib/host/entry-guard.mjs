import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function isInvokedDirectly(importMetaUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(importMetaUrl))
  } catch {
    return false
  }
}
