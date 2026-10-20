import { strict as assert } from 'node:assert'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, it } from 'vitest'
import coverageModule, { disableChildProcessCoverage, enableChildProcessCoverage } from '../child-process-coverage-provider.mjs'

const roots: string[] = []
const children = new Set<ChildProcess>()
const instruments: ReturnType<typeof enableChildProcessCoverage>[] = []
const providerURL = pathToFileURL(resolve(import.meta.dirname, '../child-process-coverage-provider.mjs')).href

afterEach(async () => {
  for (const child of children) {
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  }
  children.clear()
  for (const instrument of instruments.splice(0)) disableChildProcessCoverage(instrument)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'wt-coverage-cleanup-'))
  roots.push(root)
  mkdirSync(join(root, '.lane'))
  return root
}

function start(root: string) {
  const instrument = enableChildProcessCoverage(root, {})
  instruments.push(instrument)
  return instrument
}

async function initialize(root: string) {
  const provider = await coverageModule.getProvider() as unknown as {
    initialize: (ctx: unknown) => void,
    childInstrument: ReturnType<typeof enableChildProcessCoverage>,
  }
  const base = Object.getPrototypeOf(Object.getPrototypeOf(provider))
  const original = base.initialize
  base.initialize = function (this: { options: unknown }) {
    this.options = { reportsDirectory: join(root, 'reports') }
  }
  try {
    provider.initialize({ config: { root } })
    instruments.push(provider.childInstrument)
  } finally {
    if (original === undefined) delete base.initialize
    else base.initialize = original
  }
}

async function owner(root: string, ending = 'setInterval(() => {}, 1000)', before = '') {
  const source = `import { enableChildProcessCoverage } from ${JSON.stringify(providerURL)};
    ${before}; const instrument = enableChildProcessCoverage(${JSON.stringify(root)});
    ${ending}; console.log(instrument.directory)`
  const env = { ...process.env }
  delete env.NODE_V8_COVERAGE
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
  children.add(child)
  child.once('exit', () => children.delete(child))
  let output = ''
  const directory = await new Promise<string>((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('coverage owner did not become ready')), 10_000)
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      reject(new Error(`coverage owner exited before ready: ${code}/${signal}`))
    })
    child.stdout!.on('data', (chunk) => {
      output += String(chunk)
      if (!output.includes('\n')) return
      clearTimeout(timeout)
      done(output.trim().split('\n')[0]!)
    })
    child.stderr!.on('data', (chunk) => { output += String(chunk) })
  })
  return { child, directory }
}

it('removes a stale sibling with a dead owner when coverage initializes', async () => {
  const root = scratch()
  const { child, directory } = await owner(root)
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  assert.equal(existsSync(directory), true, 'SIGKILL must leave a stale directory for this lock')
  await initialize(root)
  assert.equal(existsSync(directory), false, 'dead-owner sibling must be removed at initialize')
})

it('keeps a sibling whose owner is still alive, even when the directory is old', async () => {
  const root = scratch()
  const { directory } = await owner(root)
  const old = new Date(Date.now() - 7_200_000)
  utimesSync(directory, old, old)
  start(root)
  assert.equal(existsSync(directory), true, 'live-owner sibling must be kept')
})

it('keeps young ownerless siblings and removes only those older than one hour', () => {
  const root = scratch()
  const young = join(root, '.lane', 'child-coverage-young')
  const old = join(root, '.lane', 'child-coverage-old')
  mkdirSync(young)
  mkdirSync(old)
  const timestamp = new Date(Date.now() - 3_601_000)
  utimesSync(old, timestamp, timestamp)
  start(root)
  assert.equal(existsSync(young), true, 'young ownerless sibling must be kept')
  assert.equal(existsSync(old), false, 'old ownerless sibling must be removed at initialize')
})

it('does not mistake a reused live pid for the recorded owner', () => {
  const root = scratch()
  const stale = join(root, '.lane', 'child-coverage-reused')
  mkdirSync(stale)
  writeFileSync(join(stale, '.owner'), JSON.stringify({ version: 1, pid: process.pid, identity: 'different-process-incarnation' }))
  start(root)
  // An unavailable process-creation identity must conservatively remain unknown.
  const recordFile = join(instruments.at(-1)!.directory, '.owner')
  const record = existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, 'utf8')) : { identity: 'missing-record' }
  assert.equal(existsSync(stale), record.identity === null, 'a different process identity must not protect a stale directory')
})

it('keeps old directories when their owner identity or metadata cannot be determined', () => {
  const root = scratch()
  const unknown = join(root, '.lane', 'child-coverage-unknown')
  const corrupt = join(root, '.lane', 'child-coverage-corrupt')
  mkdirSync(unknown)
  mkdirSync(corrupt)
  writeFileSync(join(unknown, '.owner'), JSON.stringify({ version: 1, pid: process.pid, identity: null }))
  writeFileSync(join(corrupt, '.owner'), 'incomplete metadata')
  const old = new Date(Date.now() - 7_200_000)
  for (const directory of [unknown, corrupt]) utimesSync(directory, old, old)
  start(root)
  assert.equal(existsSync(unknown), true, 'unknown PID incarnation must not be treated as dead')
  assert.equal(existsSync(corrupt), true, 'unreadable owner metadata must not be treated as absent')
})

it('never follows sibling symlinks or deletes unrelated files and nested directories', () => {
  const root = scratch()
  const target = scratch()
  writeFileSync(join(target, 'keep'), 'untouched')
  const parent = join(root, '.lane')
  const link = join(parent, 'child-coverage-link')
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(parent, 'child-coverage-file'), 'keep')
  mkdirSync(join(parent, 'other', 'child-coverage-nested'), { recursive: true })
  start(root)
  assert.equal(lstatSync(link).isSymbolicLink(), true)
  assert.equal(readFileSync(join(target, 'keep'), 'utf8'), 'untouched')
  assert.equal(readFileSync(join(parent, 'child-coverage-file'), 'utf8'), 'keep')
  assert.equal(existsSync(join(parent, 'other', 'child-coverage-nested')), true)
})

it.skipIf(process.platform === 'win32')('never follows a symlink used as an owner record', () => {
  const root = scratch()
  const target = scratch()
  const ended = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' })
  assert.equal(ended.status, 0)
  const record = join(target, 'owner-record')
  writeFileSync(record, JSON.stringify({ version: 1, pid: Number(ended.stdout.trim()), identity: null }))
  const sibling = join(root, '.lane', 'child-coverage-owner-link')
  mkdirSync(sibling)
  symlinkSync(record, join(sibling, '.owner'))
  const old = new Date(Date.now() - 7_200_000)
  utimesSync(sibling, old, old)
  start(root)
  assert.equal(existsSync(sibling), true, 'symlink metadata must remain unknown rather than be followed')
  assert.equal(lstatSync(join(sibling, '.owner')).isSymbolicLink(), true)
  assert.equal(existsSync(record), true)
})

it('does not follow a symlink in place of the lane directory', () => {
  const root = scratch()
  const target = scratch()
  rmSync(join(root, '.lane'), { recursive: true })
  symlinkSync(target, join(root, '.lane'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => start(root), /symlink|directory/i, 'symlink lane parent must be rejected')
  assert.deepEqual(readdirSync(target), ['.lane'])
})

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) {
  it.skipIf(process.platform === 'win32')(`cleans on ${signal} while retaining the ${signal} exit outcome`, async () => {
    const root = scratch()
    const { child, directory } = await owner(root)
    const exited = once(child, 'exit')
    child.kill(signal)
    assert.deepEqual(await exited, [null, signal])
    assert.equal(existsSync(directory), false, `${signal} owner must remove its coverage directory`)
  })
}

it('cleans on normal exit without changing a nonzero exit code', async () => {
  const root = scratch()
  const { child, directory } = await owner(root, 'process.exitCode = 7')
  assert.deepEqual(await once(child, 'exit'), [7, null])
  assert.equal(existsSync(directory), false, 'normal exit must remove its coverage directory')
})

it.skipIf(process.platform === 'win32')('preserves a pre-existing one-shot signal handler and its exit code', async () => {
  const root = scratch()
  const { child, directory } = await owner(root, 'setInterval(() => {}, 1000)', "process.once('SIGTERM', () => process.exit(17))")
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  assert.deepEqual(await exited, [17, null])
  assert.equal(existsSync(directory), false, 'handled signal must still clean coverage')
})

it.skipIf(process.platform === 'win32')('keeps coverage available when an application handles a signal and continues', async () => {
  const root = scratch()
  const { child, directory } = await owner(root,
    "process.stdin.resume(); process.stdin.once('data', () => process.exit(0))",
    "process.on('SIGTERM', () => console.log('handled'))")
  const handled = once(child.stdout!, 'data')
  child.kill('SIGTERM')
  assert.equal(String((await handled)[0]).trim(), 'handled')
  assert.equal(existsSync(directory), true, 'a handled signal must not destroy an ongoing coverage run')
  const exited = once(child, 'exit')
  child.stdin!.end('finish\n')
  assert.deepEqual(await exited, [0, null])
  assert.equal(existsSync(directory), false)
})

it('restores the environment and releases hooks after repeated explicit disable', () => {
  const root = scratch()
  const events = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP', 'newListener', 'removeListener']
  const counts = events.map((event) => process.listenerCount(event))
  const env = { NODE_V8_COVERAGE: 'previous' }
  const instrument = enableChildProcessCoverage(root, env)
  disableChildProcessCoverage(instrument)
  disableChildProcessCoverage(instrument)
  assert.equal(env.NODE_V8_COVERAGE, 'previous')
  assert.deepEqual(events.map((event) => process.listenerCount(event)), counts)
})

// signal-exit's rule: re-raise the signal only when this library's listener is the only one left.
const deferringLibrary = `process.on('SIGTERM', function library() {
  if (process.listenerCount('SIGTERM') !== 1) return
  process.removeListener('SIGTERM', library); process.kill(process.pid, 'SIGTERM') })`

async function exitWithin(child: ChildProcess, ms: number) {
  const timer = new Promise<'still running'>((done) => setTimeout(() => done('still running'), ms))
  return Promise.race([once(child, 'exit'), timer])
}

for (const order of ['before', 'after'] as const) {
  it.skipIf(process.platform === 'win32')(`a library that re-raises only as the sole listener, registered ${order} coverage, still dies of SIGTERM`, async () => {
    const root = scratch()
    const keepAlive = 'setInterval(() => {}, 1000)'
    const { child, directory } = order === 'before'
      ? await owner(root, keepAlive, deferringLibrary)
      : await owner(root, `${deferringLibrary}; ${keepAlive}`)
    child.kill('SIGTERM')
    assert.deepEqual(await exitWithin(child, 5_000), [null, 'SIGTERM'], 'SIGTERM must not be swallowed by mutual deferral')
    assert.equal(existsSync(directory), false, 'the SIGTERM run must remove its coverage directory')
  })
}

it('cleans on normal exit even when an earlier exit listener ends the process', async () => {
  const root = scratch()
  const { child, directory } = await owner(root, 'process.exitCode = 7', "process.on('exit', () => process.exit(7))")
  assert.deepEqual(await once(child, 'exit'), [7, null])
  assert.equal(existsSync(directory), false, 'an earlier exit listener must not skip coverage cleanup')
})

const otherUserPid = (() => {
  try { return process.platform === 'linux' && readFileSync('/proc/1/stat', 'utf8') ? 1 : 0 } catch { return 0 }
})()

it.skipIf(otherUserPid === 0)('collects a sibling whose pid now belongs to another incarnation, even when signalling it is not permitted', () => {
  const root = scratch()
  const stale = join(root, '.lane', 'child-coverage-foreign')
  mkdirSync(stale)
  writeFileSync(join(stale, '.owner'), JSON.stringify({ version: 1, pid: otherUserPid, identity: 'linux:another-boot:1' }))
  start(root)
  assert.equal(existsSync(stale), false, 'EPERM on a reused pid must still compare the process identity')
})

it('still captures real child V8 output, with metadata outside the JSON population', () => {
  const root = scratch()
  const instrument = enableChildProcessCoverage(root)
  instruments.push(instrument)
  const result = spawnSync(process.execPath, ['-e', 'console.log(6 * 7)'], { env: process.env, encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), '42')
  const entries = readdirSync(instrument.directory).filter((file) => file.endsWith('.json'))
  assert.ok(entries.length > 0)
  for (const entry of entries) assert.ok(Array.isArray(JSON.parse(readFileSync(join(instrument.directory, entry), 'utf8')).result))
  assert.equal(entries.includes('.owner'), false)
})

it('merges real child-only script coverage and never parses the owner record as V8 output', async () => {
  const root = scratch()
  const executable = join(root, 'child-only.mjs')
  writeFileSync(executable, 'console.log(21 * 2)')
  const instrument = enableChildProcessCoverage(root)
  instruments.push(instrument)
  assert.equal(spawnSync(process.execPath, [executable], { env: process.env }).status, 0)
  writeFileSync(join(instrument.directory, '.owner'), 'deliberately not JSON')
  const provider = await coverageModule.getProvider()
  const base = Object.getPrototypeOf(Object.getPrototypeOf(provider))
  const original = base.generateCoverage
  const merged: unknown[] = []
  const map = { merge: (value: unknown) => merged.push(value) }
  base.generateCoverage = async () => map
  Object.assign(provider, {
    childInstrument: instrument,
    ctx: { logger: { warn: () => assert.fail('owner metadata must not be parsed as coverage') } },
    isIncluded: (file: string) => file === executable,
    convertCoverage: async (value: unknown) => value,
  })
  try {
    assert.equal(await provider.generateCoverage({}), map)
    const result = (merged[0] as { result: { url: string, functions: { ranges: { count: number }[] }[] }[] }).result
    assert.equal(merged.length, 1)
    assert.equal(result[0]!.url, pathToFileURL(executable).href)
    assert.ok(result[0]!.functions.some((fn) => fn.ranges.some((range) => range.count > 0)))
    assert.equal(existsSync(instrument.directory), false)
  } finally {
    if (original === undefined) delete base.generateCoverage
    else base.generateCoverage = original
  }
})
