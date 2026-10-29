import { readStaticSemaphore, staticSemaphoreOptions, staticSemaphoreRoot, staticWrapperCommand } from './host/suite-lock-static-semaphore.mjs'
import { suiteLockPriority } from './suite-lock-priority.mjs'

const STATIC_SCRIPTS = new Set(['typecheck', 'lint', 'quality', 'quality:lint', 'quality:dup', 'quality:dead', 'quality:deps', 'quality:changed', 'quality:host'])
let warned = false

export function staticLaneEnabled(env = process.env) {
  const value = env.WT_SUITE_LOCK_STATIC_LANE
  if (value === undefined || value === '1') return true
  if (value === '0') return false
  if (!warned) {
    warned = true
    process.stderr.write('wt-suite-lock: invalid WT_SUITE_LOCK_STATIC_LANE; expected 1 or 0; defaulting to 1\n')
  }
  return true
}

export function staticRunCommand(argv) {
  if (!Array.isArray(argv)) return false
  const [tool, ...args] = argv
  if (tool === 'node') return staticWrapperCommand(args)
  if (tool === 'jscpd' || tool === 'depcruise') return true
  if (!['pnpm', 'npm'].includes(tool)) return false
  if (args[0] === 'run' || (tool === 'pnpm' && args[0] === '-r')) args.shift()
  return args.length === 1 && STATIC_SCRIPTS.has(args[0])
}

export function parseStaticFlag(flags) {
  const index = flags.indexOf('--static')
  if (index < 0) return false
  flags.splice(index, 1)
  return true
}

export function staticLockOptions(root, options) {
  if (options.priority === 'release') return null // Release gates always take the main queue.
  if (root.startsWith('broker:')) return null // The host classifies the supplied command and wrapper argv.
  if (!options.static || !staticLaneEnabled(options.env)) return null
  return staticSemaphoreOptions(root, { ...options, journalPriority: suiteLockPriority({ priority: options.priority }, options.env ?? process.env) })
}

export function withStaticLaneSnapshot(snapshot, env, now, isStale) {
  const lane = readStaticSemaphore(snapshot.root, now, isStale)
  if (staticLaneEnabled(env) || lane.holder || lane.waiting) snapshot.staticLane = lane
  return snapshot
}

export function staticLaneStatusLines(snapshot) {
  const lane = snapshot.staticLane
  if (!lane || (!lane.holder && !lane.waiting)) return ''
  const holder = lane.holder
  const age = Number.isFinite(holder?.ageMs) ? `${holder.ageMs / 1000} s` : 'unknown'
  const pid = Number.isSafeInteger(holder?.pid) && holder.pid > 0 ? holder.pid : 'unknown'
  const description = holder ? `holder pid ${pid}, held ${age} (${holder.argv})` : 'no holder'
  return `static lane: ${description}; ${lane.waiting} waiting\n`
}

export const staticLeaseRoot = staticSemaphoreRoot
