// Frozen pre-park parser for executed legacy-behavior comparisons.
import { parseStaticFlag, staticLaneEnabled, staticRunCommand } from '../../../../../plugin/bin/lib/suite-lock-static.mjs'

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
