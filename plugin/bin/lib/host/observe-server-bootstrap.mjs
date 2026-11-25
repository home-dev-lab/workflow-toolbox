import { resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

// tsx runs this bootstrap in the server process. Restore the companion entry's
// argv before loading it (including --watch), and keep the title local to this role.
export async function runObserveServer() {
  const entry = resolvePath(process.argv[3])
  process.argv.splice(1, 2)
  process.argv[1] = entry
  try { process.title = 'wt-observe-srv' } catch { /* Best-effort on unsupported hosts. */ }
  await import(pathToFileURL(entry).href)
}

export { isInvokedDirectly } from './entry-guard.mjs'
