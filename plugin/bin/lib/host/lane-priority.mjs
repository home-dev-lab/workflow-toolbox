import { constants as osConstants, setPriority as osSetPriority } from 'node:os'
import { trustedSystemExecutable } from './lane-sandbox.mjs'
import { spawnSync } from 'node:child_process'

// ionice comes from a root-owned system location only: never a relative, user-owned or lane-supplied PATH entry.
// The trusted resolver and the search path are injectable so a test never depends on the host filesystem or PATH syntax.
export function resolveIonice({ trusted = trustedSystemExecutable, searchPath = process.env.PATH } = {}) {
  return (name) => {
    try { return trusted(name, searchPath) } catch (error) { return { refusal: error instanceof Error ? error.message : String(error) } }
  }
}
const defaultResolve = (name) => resolveIonice()(name)

// Niceness (and, on Linux, the idle I/O class) set on the worker is inherited by the lane it spawns
// next. Every degraded path is named in the returned stage text, never silent.
export function applyLanePriority(priority, { platform = process.platform, run = spawnSync, setPriority = osSetPriority, pid = process.pid, resolve = defaultResolve } = {}) {
  if (priority !== 'low') return 'priority normal'
  const windows = platform === 'win32'
  let nice = windows ? 'nice=below-normal' : 'nice=19'
  try { setPriority(pid, windows ? osConstants.priority.PRIORITY_BELOW_NORMAL : 19) } catch (error) { nice = `nice=unavailable (${error instanceof Error ? error.message : String(error)})` }
  if (platform !== 'linux') return `priority ${nice} ionice=unsupported-platform`
  const ionice = resolve('ionice')
  if (ionice?.refusal) return `priority ${nice} ionice=unavailable (${ionice.refusal})`
  if (!ionice) return `priority ${nice} ionice=unavailable (not found in a trusted system location)`
  const result = run(ionice, ['-c', '3', '-p', String(pid)], { stdio: 'ignore', timeout: 3_000, windowsHide: true })
  if (result.error) return `priority ${nice} ionice=unavailable (${result.error.message})`
  const ionicePart = result.status === 0 ? 'ionice=idle' : 'ionice=unavailable (exit ' + result.status + ')'
  return `priority ${nice} ${ionicePart}`
}
