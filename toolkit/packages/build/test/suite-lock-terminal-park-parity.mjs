import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

// Round-one snapshots, independent of the implementation under comparison.
const before = String.raw`
function recoverParkAsides(queueDir, now, ownerIsStale, parkIsLive) {
  let names
  try { names = readdirSync(queueDir) } catch (error) { if (error?.code === 'ENOENT') return; throw error }
  for (const name of names) {
    if (!/^\d{16}\.parked\.reclaimed-/.test(name)) continue
    const aside = path.join(queueDir, name)
    if (retainParkAside(name, aside, now, ownerIsStale)) continue
    const file = aside.slice(0, aside.indexOf('.parked.reclaimed-') + '.parked'.length)
    const park = readParkJson(aside)
    if (parkIsLive(park) && !existsSync(file) && !existsSync(file.replace(/\.parked$/, '.json'))) restoreParkAside(aside, file)
    rmSync(aside, { force: true })
  }
}
function takeParkAttemptFile(context, ownerIsStale, candidate) {
  const file = path.join(context.directory, 'attempt')
  const claim = candidate.claim
  try { linkSync(candidate.file, file) } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const held = readParkJson(file)
    if (!Number.isSafeInteger(held?.pid) || !ownerIsStale(held)) throw new Error('another attempt holds this park directory')
    const aside = file + '.reclaimed-' + randomUUID()
    renameSync(file, aside)
    if (readParkJson(aside)?.nonce !== held.nonce) {
      restoreParkAside(aside, file)
      rmSync(aside, { force: true })
      throw new Error('another attempt holds this park directory')
    }
    rmSync(aside, { force: true })
    return takeParkAttemptFile(context, ownerIsStale, candidate)
  }
  return () => { if (readParkJson(file)?.nonce === claim.nonce) rmSync(file, { force: true }) }
}
`

function functionSources(source) {
  const ast = ts.createSourceFile('park.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const names = new Set(['recoverParkAsides', 'takeParkAttemptFile', 'linkParkAttempt'])
  return ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text))
    .map((node) => node.getText(ast).replace(/^export /, '')).join('\n')
}

const errorValue = (error) => ({ name: error.name, message: error.message, code: error.code, cause: error.cause })
function failure(code, trace, errors) {
  const error = new Error(code)
  Object.defineProperty(error, 'code', { get() { trace.push(['error.code', code]); return code } })
  errors.push(error)
  return error
}
const asideName = '0000000000000001.parked.reclaimed-creator'

function traceFunction(trace, name, run = () => undefined) {
  return function (...args) { trace.push([name, this === undefined ? 'unbound' : 'bound', ...args]); return run(...args) }
}

function attemptEnvironment(kind, trace, errors) {
  let links = 0
  const held = kind === 'invalid' ? {} : { pid: 42, nonce: 'held' }
  const read = (file) => {
    if (file.includes('.reclaimed-')) return { nonce: kind === 'replacement' ? 'other' : 'held' }
    return links <= 1 && kind !== 'success' ? held : { nonce: kind === 'cleanup-other' ? 'other' : 'mine' }
  }
  return {
    path,
    linkSync: traceFunction(trace, 'link', () => {
      links++
      if (kind === 'permission') throw failure('EACCES', trace, errors)
      if (links === 1 && !['success', 'cleanup-other'].includes(kind)) throw failure('EEXIST', trace, errors)
    }),
    readParkJson: traceFunction(trace, 'read', read),
    randomUUID: traceFunction(trace, 'uuid', () => 'uuid'),
    renameSync: traceFunction(trace, 'rename'),
    restoreParkAside: traceFunction(trace, 'restore'),
    rmSync: traceFunction(trace, 'rm'),
  }
}

function recoveryEnvironment(kind, trace, errors) {
  return {
    path,
    readdirSync: traceFunction(trace, 'list', () => {
      if (['ENOENT', 'EACCES'].includes(kind)) throw failure(kind, trace, errors)
      return kind === 'unrelated' ? ['other'] : [asideName]
    }),
    retainParkAside: traceFunction(trace, 'retain', () => kind === 'retained'),
    readParkJson: traceFunction(trace, 'read', () => ({ nonce: 'park' })),
    existsSync: traceFunction(trace, 'exists', (file) => kind === 'published' || (kind === 'ticket' && file.endsWith('.json'))),
    restoreParkAside: traceFunction(trace, 'restore', () => { if (kind === 'restore-error') throw failure('EIO', trace, errors) }),
    rmSync: traceFunction(trace, 'rm'),
  }
}

function attemptArguments(kind, trace) {
  return [
    { get directory() { trace.push(['directory']); return 'park' } },
    traceFunction(trace, 'judge', () => kind !== 'live'),
    { get file() { trace.push(['candidate.file']); return 'candidate' }, get claim() { trace.push(['candidate.claim']); return { nonce: 'mine' } } },
  ]
}

function execute(source, family, kind) {
  const trace = []
  const errors = []
  const environment = family === 'attempt' ? attemptEnvironment(kind, trace, errors) : recoveryEnvironment(kind, trace, errors)
  const context = vm.createContext(environment)
  vm.runInContext(source, context)
  const name = family === 'attempt' ? 'takeParkAttemptFile' : 'recoverParkAsides'
  const args = family === 'attempt' ? attemptArguments(kind, trace) : ['queue', 123, traceFunction(trace, 'judge'), traceFunction(trace, 'live', () => kind !== 'expired')]
  let outcome
  try {
    const value = context[name](...args)
    if (typeof value === 'function') { value(); outcome = 'cleanup returned' }
    else outcome = value
  } catch (error) { outcome = { ...errorValue(error), injectedError: errors.indexOf(error) } }
  // Cross-realm object prototypes are irrelevant; retain every call argument,
  // getter read, returned value and error field in their execution order.
  return JSON.parse(JSON.stringify({ trace, outcome }))
}

export function parkQualityParity(moduleUrl) {
  let source = functionSources(readFileSync(moduleUrl, 'utf8'))
  if (process.env.WT_TERMINAL_MUTATE_PARK_PARITY) source = source.replaceAll('another attempt holds this park directory', 'mutated park error')
  const families = {
    attempt: ['success', 'cleanup-other', 'permission', 'invalid', 'live', 'replacement', 'dead'],
    recovery: ['ENOENT', 'EACCES', 'unrelated', 'retained', 'expired', 'published', 'ticket', 'restore', 'restore-error'],
  }
  let count = 0
  for (const [family, kinds] of Object.entries(families)) for (const kind of kinds) {
    assert.deepEqual(execute(source, family, kind), execute(before, family, kind), `park quality parity: ${family}/${kind}`)
    count++
  }
  assert.equal(count, 16)
}
