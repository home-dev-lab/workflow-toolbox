import { parseSuiteLockProject, validSuiteLockName } from './suite-lock-rank-common.mjs'
import { clearSuiteLockPrecedence, listSuiteLockPrecedence, setSuiteLockPrecedence } from './host/suite-lock-rank-state.mjs'
import { appendSuiteLockJournal } from './host/suite-lock-journal-append.mjs'

const USAGE = 'use precedence set --project P --until ISO --source ID, clear --project P, or list'

function parseUntil(value, now) {
  const until = Date.parse(value)
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
    || !Number.isFinite(until) || until <= now || until > now + 7 * 86400_000) {
    throw new Error('--until requires a future ISO timestamp with explicit timezone, at most seven days ahead')
  }
  return new Date(until).toISOString()
}

function parseSource(value) {
  if (!validSuiteLockName(value)) throw new Error('--source requires a short identifier without controls')
  return value.trim()
}

function parseFlags(args, action, now) {
  const result = {}
  const parsers = { '--project': parseSuiteLockProject, '--until': (value) => parseUntil(value, now), '--source': parseSource }
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    if (!Object.hasOwn(parsers, name) || name in result || (action === 'clear' && name !== '--project')) throw new Error(USAGE)
    result[name] = parsers[name](args[index + 1])
  }
  for (const name of action === 'set' ? Object.keys(parsers) : ['--project']) if (!(name in result)) parsers[name](undefined)
  return entryFromFlags(result)
}

function entryFromFlags(result) {
  return { project: result['--project'], until: result['--until'] ?? null, source: result['--source'] ?? null }
}

export function suiteLockPrecedenceCli(args, root, env = process.env) {
  if (env.WT_SUITE_LOCK_BROKER?.trim()) throw new Error('precedence is not available inside a lane sandbox; run wt-suite-lock precedence on the host')
  const [action, ...argsFlags] = args
  if (action === 'list' && argsFlags.length === 0) {
    process.stdout.write(`${JSON.stringify(listSuiteLockPrecedence(root))}\n`)
    return 0
  }
  if (!['set', 'clear'].includes(action)) throw new Error(USAGE)
  const entry = parseFlags(argsFlags, action, Date.now())
  if (action === 'set') setSuiteLockPrecedence(root, entry)
  else clearSuiteLockPrecedence(root, entry.project)
  appendSuiteLockJournal(root, { event: 'precedence', action, ...entry, ts: new Date().toISOString() })
  return 0
}
