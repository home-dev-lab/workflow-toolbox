#!/usr/bin/env node
// List every live Claude Code session of this user and the version of one plugin its server
// processes actually load, read off each process (its module path), never off a manifest.
import { isInvokedDirectly } from './lib/host/entry-guard.mjs'
import { handleHelpFlag } from './lib/cli-help.mjs'
import { checkLoadedVersions } from './lib/loaded-version/scan.mjs'
import { renderJson, renderText } from './lib/loaded-version/report.mjs'

const HELP = `Usage: wt-loaded-version --plugin <name> (--expect <version> | --list) [--profile <config-dir>]... [--allow-none] [--json]
Lists every live Claude Code session of this user, on every profile (config dir), with the version of
<name> that its server processes load, read from each process's module path under
<config-dir>/plugins/cache/<marketplace>/<name>/<version>/.
Exit 0: every session loads --expect (--list: listing done). Exit 1: at least one session is stale; a
stale session wins over an unreadable one, and both are listed. Exit 2: could not judge (a process
unreadable, not Linux, a PID namespace that hides the sessions, no session at all without
--allow-none, a --profile that does not exist, bad arguments).
Sessions that do not load the plugin are listed as absent and do not fail the check; a profile
with no session prints "no live session profile=<dir>".
`
const VALUE_FLAGS = ['--plugin', '--expect', '--profile']
const BOOLEAN_FLAGS = { '--json': 'json', '--list': 'list', '--allow-none': 'allowNone' }

export function parseArguments(argv) {
  const options = { plugin: null, expect: null, profiles: [], json: false, list: false, allowNone: false }
  const args = [...argv]
  while (args.length) {
    const flag = args.shift()
    const boolean = BOOLEAN_FLAGS[flag]
    if (boolean) { options[boolean] = true; continue }
    if (!VALUE_FLAGS.includes(flag) || !args.length) throw new Error(`wt-loaded-version: unexpected argument ${JSON.stringify(flag)}\n${HELP}`)
    const value = args.shift()
    if (flag === '--profile') options.profiles.push(value)
    else options[flag.slice(2)] = value
  }
  if (!options.plugin) throw new Error(`wt-loaded-version: --plugin <name> is required\n${HELP}`)
  if ((options.expect === null) === !options.list) throw new Error(`wt-loaded-version: give exactly one of --expect <version> or --list\n${HELP}`)
  return options
}

export function loadedVersionMain(argv = process.argv.slice(2), write = text => process.stdout.write(text)) {
  handleHelpFlag(argv, HELP, { valueFlags: VALUE_FLAGS, booleanFlags: Object.keys(BOOLEAN_FLAGS) })
  const options = parseArguments(argv)
  const result = checkLoadedVersions(options)
  write(options.json ? `${JSON.stringify(renderJson(result))}\n` : `${renderText(result)}\n`)
  return result.exitCode
}

if (isInvokedDirectly(import.meta.url)) {
  try { process.exitCode = loadedVersionMain() } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 2
  }
}
