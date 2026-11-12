import { parseSuiteLockProject } from './suite-lock-priority.mjs'
import { clearSuiteLockPrecedence, listSuiteLockPrecedence, setSuiteLockPrecedence } from './host/suite-lock-rank-state.mjs'
import { appendSuiteLockJournal } from './host/suite-lock-journal-append.mjs'

function parseFlags(args) {
  const result = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    if (!['--project', '--until', '--source'].includes(name) || !args[index + 1] || name in result) throw new Error('precedence accepts --project, --until and --source once each')
    result[name] = args[index + 1]
  }
  return result
}

function precedenceEntry(flags) {
  const project = parseSuiteLockProject(flags['--project'])
  const until = flags['--until']
  const source = flags['--source']
  if (!until || !Number.isFinite(Date.parse(until)) || !/^\d{4}-\d\d-\d\dT/.test(until)) throw new Error('--until requires an ISO timestamp')
  if (!source || source.length > 120 || /[\p{Cc}\p{Cf}]/u.test(source)) throw new Error('--source requires a short identifier without controls')
  return { project, until: new Date(until).toISOString(), source }
}

export function suiteLockPrecedenceCli(args, root, env = process.env) {
  if (env.WT_SUITE_LOCK_BROKER?.trim()) throw new Error('precedence is not available inside a lane sandbox; run wt-suite-lock precedence on the host')
  const [action, ...argsFlags] = args
  if (action === 'list' && argsFlags.length === 0) {
    process.stdout.write(`${JSON.stringify(listSuiteLockPrecedence(root))}\n`)
    return 0
  }
  const flags = parseFlags(argsFlags)
  const project = parseSuiteLockProject(flags['--project'])
  let entry
  if (action === 'set') { entry = precedenceEntry(flags); setSuiteLockPrecedence(root, entry) }
  else if (action === 'clear' && Object.keys(flags).length === 1) { entry = { project, until: null, source: null }; clearSuiteLockPrecedence(root, project) }
  else throw new Error('use precedence set --project P --until ISO --source ID, clear --project P, or list')
  appendSuiteLockJournal(root, { event: 'precedence', action, ...entry, ts: new Date().toISOString() })
  return 0
}
