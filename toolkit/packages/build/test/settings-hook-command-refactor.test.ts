import { readFileSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'

// Frozen pre-refactor bodies: exercise the same scanner dependencies in both copies.
const BASE_LIST = `function commandList(scan, nested) {
  const tokens = []
  let depth = 0
  while (scan.pos < scan.text.length) {
    const token = nextToken(scan)
    if (!token) continue
    const group = token.kind === 'operator' ? token.value : null
    if (group === ')' && depth === 0) return nested ? tokens : unreadable()
    if (group === '(') depth++
    if (group === ')') depth--
    tokens.push(token)
  }
  return nested || depth ? unreadable() : tokens
}`
const BASE_NODE = `function nodeScript(words) {
  let index = 0
  const wrapper = isCommand(words[0], 'env')
  if (wrapper) index++
  while (words[index]?.assignment || (wrapper && words[index] && isEnvAssignment(words[index]))) index++
  const executable = words[index]
  const script = words[index + 1]
  if (!isCommand(executable, 'node') && !isCommand(executable, 'node.exe')) return null
  return script && !script.opaque && isAbsolute(script.value) && script.value.endsWith('.mjs') ? script.value : null
}`
const SOURCE = readFileSync(process.env.WT_SETTINGS_COMMAND_SOURCE
  ?? new URL('../../../../plugin/bin/lib/settings-hook-command.mjs', import.meta.url), 'utf8')
type Subject = (...args: unknown[]) => unknown
type Subjects = { commandList: Subject; nodeScript: Subject }
let activeTrace: unknown[] = []

function pathCall(fn: (value: string) => unknown, value: string) {
  activeTrace.push(['call', fn.name, value])
  return fn(value)
}

function subjects(base: boolean): Subjects {
  let source = SOURCE.replace(/^import .*$/m, '').replace('export function', 'function')
  if (base) {
    source = source.replace(/function commandList\([^]*?\n}/, BASE_LIST)
    source = source.replace(/function nodeScript\([^]*?\n}/, BASE_NODE)
  }
  return runInNewContext(`${source}\n;({ commandList, nodeScript })`, {
    basename: (value: string) => pathCall(basename, value),
    isAbsolute: (value: string) => pathCall(isAbsolute, value),
  }) as Subjects
}

function observed(value: unknown, trace: unknown[]): unknown {
  if (value === null || typeof value !== 'object') return value
  return new Proxy(value, {
    get(target, key, receiver) {
      trace.push(['get', String(key)])
      return observed(Reflect.get(target, key, receiver), trace)
    },
    set(target, key, next, receiver) {
      trace.push(['set', String(key), next])
      return Reflect.set(target, key, next, receiver)
    },
  })
}

function outcome(subject: Subject, args: unknown[]) {
  const trace: unknown[] = []
  activeTrace = trace
  const cloned = structuredClone(args)
  try {
    const result = subject(...cloned.map((arg) => observed(arg, trace)))
    return { result: JSON.stringify(result), args: JSON.stringify(cloned), trace }
  } catch (error) {
    const { name, message } = error as Error
    return { error: { name, message, constructor: (error as Error).constructor.name }, args: JSON.stringify(cloned), trace }
  }
}

const COMMANDS = [
  '', 'node /hook.mjs', 'env X=1 node /hook.mjs', 'node /hook.mjs;',
  '(node /hook.mjs)', ')', '(', 'node /hook.mjs >', 'node /hook.mjs > > x',
  'echo $(node /hook.mjs)', 'echo `node /hook.mjs`', 'echo ${X:-$(echo {})}',
  'node /hook.mjs ||\n node /other.mjs', 'node /hook.mjs && true',
  '# comment\nnode /hook.mjs', 'node "unterminated', 'cat <<EOF',
  'node /hook.mjs 2>/dev/null', 'echo <(node /hook.mjs)',
]

it('commandList preserves outputs, errors, mutations and property evaluation order', () => {
  const base = subjects(true), current = subjects(false)
  for (const text of COMMANDS) for (const nested of [false, true]) {
    const args = [{ text, pos: 0, depth: 0 }, nested]
    expect(outcome(current.commandList, args), text).toEqual(outcome(base.commandList, args))
  }
})

const word = (value: string, opaque = false, assignment = false) => ({ value, opaque, assignment })
const WORDS = [
  [], [word('node')], [word('node'), word('/hook.mjs')],
  [word('node.exe'), word('/hook.mjs')], [word('node/'), word('/hook.mjs')],
  [word('echo'), word('/hook.mjs')], [word('node', true), word('/hook.mjs')],
  [word('node'), word('/hook.mjs', true)], [word('node'), word('relative.mjs')],
  [word('node'), word('/hook.js')], [word('env'), word('X=1'), word('node'), word('/hook.mjs')],
  [word('X=1', false, true), word('node'), word('/hook.mjs')],
  [word('env'), word('X=1', true), word('node'), word('/hook.mjs')],
  [word('env/')], [word('env')], [word('env'), word('node.exe'), word('/hook.mjs')],
  [word('X=1'), word('node'), word('/hook.mjs')], [null], [word('node'), null],
]

it('nodeScript preserves outputs, errors and property evaluation order', () => {
  const base = subjects(true), current = subjects(false)
  for (const words of WORDS) {
    expect(outcome(current.nodeScript, [words])).toEqual(outcome(base.nodeScript, [words]))
  }
})
