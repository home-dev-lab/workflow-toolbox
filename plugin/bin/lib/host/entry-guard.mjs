import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function isInvokedDirectly(importMetaUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false
  try {
    const moduleUrl = new URL(importMetaUrl)
    if (moduleUrl.search || moduleUrl.hash) return false
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}
