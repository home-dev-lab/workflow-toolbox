#!/usr/bin/env node
import { runSuiteLockCliEntrypoint } from './wt-suite-lock.mjs'
import { lightRunCommand } from './lib/suite-lock.mjs'

// WT_SUITE_LOCK_CMD accepts a bare command, or a launcher prefix ending at the first `--`:
// `run --`, `run --light --`, `--light --`, or just `--`. Only one explicit --light is allowed;
// any other token between a leading `run` (or a leading `--flag`) and the first `--` is refused
// before a lease is requested. A command named run without a separator, and commands whose first
// token is neither `run` nor a `--flag`, keep their original argv.
const ACCEPTED_FORMS = 'accepted forms: <command> [args...], run [--light] -- <command> [args...], [--light] -- <command> [args...]'

function parseRunnerArguments(argv) {
  const verbatim = { command: argv, light: false }
  const separator = argv.indexOf('--')
  if (separator < 0) return verbatim
  if (argv[0] !== 'run' && !argv[0].startsWith('--')) return verbatim
  let light = false
  for (const flag of argv.slice(argv[0] === 'run' ? 1 : 0, separator)) {
    if (flag !== '--light' || light) {
      throw new Error(`unsupported flag: ${flag.replace(/[\r\n]/g, ' ')}; ${ACCEPTED_FORMS}`)
    }
    light = true
  }
  return { command: argv.slice(separator + 1), light }
}

async function main(argv) {
  let parsed
  try { parsed = parseRunnerArguments(argv) } catch (error) {
    process.stderr.write(`wt-suite-lock-run: ${error.message}\n`)
    return 2
  }
  const { command, light: declaredLight } = parsed
  const light = declaredLight || lightRunCommand(command)
  return runSuiteLockCliEntrypoint(['run', ...(light ? ['--light'] : []), '--', ...command])
}

process.exitCode = await main(process.argv.slice(2))
