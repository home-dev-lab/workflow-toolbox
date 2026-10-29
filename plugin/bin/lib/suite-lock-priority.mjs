import { displayArgv } from './suite-lock-display.mjs'

export function parseSuiteLockPriority(value) {
  if (value === 'release') return value
  const level = typeof value === 'string' ? value.toUpperCase() : ''
  if (['P0', 'P1', 'P2'].includes(level)) return level
  throw new Error(`unknown suite lock priority: ${displayArgv([value])}`)
}

export function suiteLockPriority(options = {}, env = process.env) {
  if (options.priority !== undefined) return parseSuiteLockPriority(options.priority)
  const raw = env.WT_SUITE_LOCK_PRIORITY
  if (raw === undefined) return 'P1'
  const value = typeof raw === 'string' ? raw.toUpperCase() : ''
  if (['P0', 'P1', 'P2'].includes(value)) return value
  process.stderr.write(`wt-suite-lock: invalid WT_SUITE_LOCK_PRIORITY ${JSON.stringify(displayArgv([raw]))}; using P1\n`)
  return 'P1'
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
