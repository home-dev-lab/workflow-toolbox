import { displayArgv } from './suite-lock-display.mjs'
import { defaultSuiteLockProject } from './host/suite-lock-project.mjs'
import { parseSuiteLockProject } from './suite-lock-rank-common.mjs'
export { parseSuiteLockProject } from './suite-lock-rank-common.mjs'

export function parseSuiteLockPriority(value) {
  if (value === 'release') return value
  const level = typeof value === 'string' ? value.toUpperCase() : ''
  if (['P0', 'P1', 'P2'].includes(level)) return level
  throw new Error(`unknown suite lock priority: ${displayArgv([value])}`)
}

function lanePriorityContext(options, env) {
  const broker = typeof env.WT_SUITE_LOCK_BROKER === 'string' && Boolean(env.WT_SUITE_LOCK_BROKER.trim())
  return options.lane === true || env.WT_SUITE_LOCK_CONTEXT === 'lane' || broker
}

function ambientPriority(raw, lane, fallback, present) {
  if (raw === undefined && (!lane || !present)) return fallback
  const value = typeof raw === 'string' ? raw.toUpperCase() : ''
  if (['P0', 'P1', 'P2'].includes(value)) return value
  process.stderr.write(`wt-suite-lock: invalid WT_SUITE_LOCK_PRIORITY ${JSON.stringify(displayArgv([raw]))}; using ${fallback}\n`)
  return fallback
}

export function suiteLockPriority(options = {}, env = process.env) {
  const lane = lanePriorityContext(options, env)
  // The non-lane static mutex historically uses FIFO at P1, even for declared levels.
  if (options.staticSemaphore && !lane) return 'P1'
  if (options.priority !== undefined) return parseSuiteLockPriority(options.priority)
  return ambientPriority(env.WT_SUITE_LOCK_PRIORITY, lane, lane ? 'P2' : 'P1', Object.hasOwn(env, 'WT_SUITE_LOCK_PRIORITY'))
}

// Host boundaries declare context; all selection stays in the common resolver.
export function laneSuiteLockPriority(options = {}, env = process.env) {
  return suiteLockPriority({ ...options, lane: true }, env)
}

export function suiteLockLongHoldSeconds(env = process.env) {
  const raw = env.WT_SUITE_LOCK_LONG_HOLD_S
  if (raw === undefined) return 3600
  const number = Number(raw)
  if (String(raw).trim() && Number.isFinite(number) && number >= 0) return number
  process.stderr.write(`wt-suite-lock: invalid WT_SUITE_LOCK_LONG_HOLD_S ${JSON.stringify(displayArgv([raw]))}; using 3600 s\n`)
  return 3600
}

export function suiteLockLightHoldSeconds(env = process.env) {
  const value = env.WT_SUITE_LOCK_LIGHT_HOLD_S
  if (value === undefined) return 600
  const seconds = Number(value)
  if (String(value).trim() && Number.isFinite(seconds) && seconds >= 0) return seconds
  process.stderr.write(`wt-suite-lock: invalid WT_SUITE_LOCK_LIGHT_HOLD_S ${JSON.stringify(displayArgv([value]))}; using 600 s\n`)
  return 600
}

export function parseSuiteLockSize(value) {
  if (['S', 'M', 'L'].includes(value)) return value
  throw new Error('suite lock size must be S, M or L')
}

let warnedSandboxRank = false
function warnSandboxRank(options, env) {
  if (!warnedSandboxRank && (options.size !== undefined || options.project !== undefined || env.WT_SUITE_LOCK_SIZE || env.WT_SUITE_LOCK_PROJECT)) {
    warnedSandboxRank = true
    process.stderr.write('wt-suite-lock: the host sets a lane\'s project and size; sandbox declarations are ignored\n')
  }
}

export function suiteLockRankOptions(options = {}, env = process.env) {
  if (env.WT_SUITE_LOCK_BROKER?.trim()) {
    warnSandboxRank(options, env)
    return {}
  }
  return {
    project: parseSuiteLockProject(options.project ?? (env.WT_SUITE_LOCK_PROJECT || defaultSuiteLockProject(options.cwd, options.home))),
    size: parseSuiteLockSize(options.size ?? (env.WT_SUITE_LOCK_SIZE || 'L')),
  }
}
