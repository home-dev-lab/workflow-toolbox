import { parseStaticFlag, staticLaneEnabled, staticRunCommand } from './suite-lock-static.mjs'

export function parseSuiteRunOptions(args, dependencies) {
  const { parseSeconds, parsePriority, waitSeconds, defaultStaleS } = dependencies
  const separator = args.indexOf('--')
  if (separator < 0 || separator === args.length - 1) throw new Error('run requires -- followed by a command')
  const flags = args.slice(0, separator)
  const command = args.slice(separator + 1)
  const explicitStatic = parseStaticFlag(flags)
  const waitS = parseSeconds(flags, '--wait-s', waitSeconds())
  const staleS = parseSeconds(flags, '--stale-s', defaultStaleS)
  const lightIndex = flags.indexOf('--light')
  const light = lightIndex >= 0
  if (light) flags.splice(lightIndex, 1)
  const priority = parsePriority(flags)
  if (priority === 'release' && light) throw new Error('release priority cannot be combined with light')
  const staticRun = priority !== 'release' && (explicitStatic || (staticLaneEnabled(dependencies.env) && staticRunCommand(command)))
  if (flags.length > 0) throw new Error(`unknown argument: ${flags[0]}`)
  return { command, waitS, staleS, light, priority, staticRun }
}

export async function cliInheritedLease(hasLease) {
  try { return await hasLease() } catch (error) {
    if (error?.code !== 'WT_SUITE_LOCK_UNAVAILABLE') throw error
    process.stderr.write(`wt-suite-lock: ${error.message}\n`)
    return 75
  }
}

export async function acquireCliLease(acquire, options) {
  try { return await acquire(options) } catch (error) {
    if (error?.code === 'WT_SUITE_LOCK_PRIORITY_REFUSED') {
      process.stderr.write(`wt-suite-lock: ${error.message}\n`)
      return 2
    }
    if (error?.code === 'WT_SUITE_LOCK_TIMEOUT' || error?.code === 'WT_SUITE_LOCK_UNAVAILABLE') {
      process.stderr.write(`wt-suite-lock: ${error.message}\n`)
      return 75
    }
    throw error
  }
}
