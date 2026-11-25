import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export function sealedEnvironment(work, root, extra = {}) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key === 'NODE_OPTIONS' || /^WT_SUITE_(LOCK|LEASE)/.test(key)) delete env[key]
  }
  return { ...env, HOME: work, XDG_STATE_HOME: work, CLAUDE_CONFIG_DIR: work,
    WT_SUITE_LOCK_DIR: root, WT_SUITE_LEASE: '', WT_SUITE_LOCK: '1',
    WT_SUITE_LOCK_PRIORITY: 'P1', WT_SUITE_LOCK_LIGHT_SCOPE: 'warn', ...extra }
}

export function runCli(cli, args, fixture, extra = {}) {
  const child = fixture.spawnProcess(process.execPath, [cli, ...args], {
    cwd: fixture.work, env: sealedEnvironment(fixture.work, fixture.root, extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => { output.stdout += chunk })
  child.stderr.on('data', (chunk) => { output.stderr += chunk })
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, ...output }))
  })
  // Consume errors even when a failed assertion reaches cleanup before awaiting done.
  done.catch(() => {})
  const run = { child, done, output }
  fixture.children.push(run)
  return run
}

export async function until(check, message, timeout = 15000) {
  const deadline = performance.now() + timeout
  while (performance.now() < deadline) {
    if (check()) return
    await delay(20)
  }
  assert.fail(message)
}

export async function completed(run, timeout = 15000) {
  await until(() => run.child.exitCode !== null || run.child.signalCode !== null,
    `CLI did not finish: ${run.output.stderr}`, timeout)
  return run.done
}

const gatedSource = `import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
const stem = fileURLToPath(import.meta.url).replace(/\\.(test|selftest)\\.mjs$/, '')
writeFileSync(stem + '.started', '1')
const deadline = Date.now() + 50000
while (!existsSync(stem + '.go')) {
  if (Date.now() > deadline) throw new Error('fixture release timed out')
  await delay(20)
}
writeFileSync(stem + '.ran', '1')
`

export function fixture(spawnProcess = spawn) {
  // The space keeps the fixture honest about file URLs: a URL pathname would percent-encode it.
  const work = mkdtempSync(join(tmpdir(), 'wt direct-run-'))
  const root = join(work, 'lock')
  for (const name of ['a', 'b', 'holder', 'nested']) {
    writeFileSync(join(work, `${name}.test.mjs`), gatedSource)
  }
  return { work, root, children: [], spawnProcess }
}

export function release(f, name = 'a') { writeFileSync(join(f.work, `${name}.go`), '1') }
export function started(f, name = 'a') {
  return until(() => existsSync(join(f.work, `${name}.started`)), `${name} fixture did not start`)
}

export async function cleanup(f) {
  for (const name of ['a', 'b', 'holder', 'nested']) release(f, name)
  for (const run of f.children) {
    try { await completed(run, 1500) } catch {
      run.child.kill('SIGTERM')
      try { await completed(run, 1500) } catch {
        run.child.kill('SIGKILL')
        await completed(run, 4000)
      }
    }
  }
  rmSync(f.work, { recursive: true, force: true })
}

export async function status(cli, f) {
  const result = await completed(runCli(cli, ['status', '--json'], f))
  assert.equal(result.code, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function soleCommandHolder(current) {
  const holders = current.reservations?.holders ?? (current.holder ? [current.holder] : [])
  assert.equal(holders.length, 1, 'queued command must own exactly one live lease')
  if (current.reservations) assert.equal(current.holder.reservationProtocol, current.reservations.version)
  return holders[0]
}

function requests(f) {
  const path = join(f.root, 'journal.jsonl')
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line)).filter((entry) => entry.event === 'request') : []
}

const one = ['node', '--test', 'a.test.mjs']
const light = ['run', '--light', '--', ...one]

export async function assertDirect(cli, spawnProcess) {
  const f = fixture(spawnProcess)
  try {
    const run = runCli(cli, light, f)
    await started(f)
    const current = await status(cli, f)
    assert.equal(current.held, false, 'L1: one-file light run must not hold a ticket')
    assert.equal(current.holder, null)
    assert.deepEqual(current.queue, [])
    release(f)
    assert.equal((await completed(run)).code, 0)
    assert.deepEqual(requests(f), [], 'direct run must not journal a request')
  } finally { await cleanup(f) }
}

export async function assertNoWait(cli, spawnProcess) {
  const f = fixture(spawnProcess)
  try {
    const holder = runCli(cli, ['run', '--', 'node', 'holder.test.mjs'], f)
    await started(f, 'holder')
    const before = await status(cli, f)
    assert.equal(before.held, true)
    release(f)
    const run = runCli(cli, light, f)
    await until(() => existsSync(join(f.work, 'a.ran')),
      'L1b: one-file light run must finish without waiting behind a holder', 10000)
    assert.equal((await completed(run)).code, 0)
    assert.equal(holder.child.exitCode, null)
    assert.equal((await status(cli, f)).holder.leaseId, before.holder.leaseId)
  } finally { await cleanup(f) }
}

export async function assertTwoFiles(cli, spawnProcess) {
  const f = fixture(spawnProcess)
  try {
    const run = runCli(cli, [...light, 'b.test.mjs'], f)
    await started(f)
    const current = await status(cli, f)
    assert.equal(current.held, true, 'L2: two files still hold a ticket')
    const holder = soleCommandHolder(current)
    assert.equal(holder.light, true)
    assert.deepEqual(holder.argv, one.concat('b.test.mjs'))
    release(f); release(f, 'b')
    assert.equal((await completed(run)).code, 0)
    for (const name of ['a', 'b']) assert(existsSync(join(f.work, `${name}.ran`)))
  } finally { await cleanup(f) }
}

export async function assertExclusive(cli, spawnProcess) {
  const f = fixture(spawnProcess)
  try {
    const run = runCli(cli, ['run', '--', ...one], f)
    await started(f)
    assert.equal((await status(cli, f)).held, true)
    assert(requests(f).some((entry) => entry.argv === one.join(' ')),
      'L3: exclusive one-file run must journal its request')
    release(f)
    assert.equal((await completed(run)).code, 0)
    assert(existsSync(join(f.work, 'a.ran')))
  } finally { await cleanup(f) }
}

export async function assertPark(cli, spawnProcess) {
  const f = fixture(spawnProcess)
  try {
    const directory = join(f.work, 'park')
    mkdirSync(directory, { mode: 0o700 })
    writeFileSync(join(directory, 'key'), 'direct-run-park-key-at-least-thirty-two-bytes', { mode: 0o600 })
    const flags = ['--park-dir', directory, '--park-s', '60', '--park-owner-pid', String(process.pid)]
    const run = runCli(cli, ['run', '--light', ...flags, '--', ...one], f)
    await started(f)
    assert.equal((await status(cli, f)).held, true)
    assert(requests(f).some((entry) => entry.argv === one.join(' ')),
      'L3b: valid park request must take a ticket')
    release(f)
    assert.equal((await completed(run)).code, 0)
    assert(existsSync(join(f.work, 'a.ran')))
  } finally { await cleanup(f) }
}

export async function assertNested(cli, spawnProcess) {
  const f = fixture(spawnProcess)
  try {
    writeFileSync(join(f.work, 'a.test.mjs'), `import { spawnSync } from 'node:child_process'
const child = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(cli)}, 'run', '--', 'node', 'nested.test.mjs'], { env: process.env, stdio: 'inherit', timeout: 40000 })
if (child.status !== 0) throw new Error('nested run failed: ' + child.status)
`)
    const run = runCli(cli, light, f)
    await started(f, 'nested')
    const current = await status(cli, f)
    assert.equal(current.held, true, 'L5: nested exclusive work must take its own ticket')
    const holder = soleCommandHolder(current)
    assert.notEqual(holder.light, true)
    assert.deepEqual(holder.argv, ['node', 'nested.test.mjs'])
    release(f, 'nested')
    assert.equal((await completed(run)).code, 0)
  } finally { await cleanup(f) }
}

export async function assertOverrun(cli, spawnProcess) {
  const f = fixture(spawnProcess)
  try {
    const run = runCli(cli, light, f, { WT_SUITE_LOCK_DIRECT_WARN_S: '0.3' })
    await started(f)
    await until(() => run.output.stderr.includes('direct run still running after'),
      'L6: direct run must warn once after its elapsed-time threshold', 10000)
    await delay(350)
    assert.equal(run.output.stderr.match(/direct run still running after/g)?.length, 1)
    assert.match(run.output.stderr, /after [\d.]+ seconds.*wt-suite-lock run -- /)
    assert.equal(run.child.exitCode, null, 'warning must not kill the child')
    release(f)
    assert.equal((await completed(run)).code, 0)
    assert(existsSync(join(f.work, 'a.ran')))
  } finally { await cleanup(f) }
}

export async function assertShort(cli, spawnProcess) {
  const f = fixture(spawnProcess)
  try {
    release(f)
    const result = await completed(runCli(cli, light, f, { WT_SUITE_LOCK_DIRECT_WARN_S: '30' }))
    assert.equal(result.code, 0)
    assert(!result.stderr.includes('direct run still running after'))
    assert(!result.stderr.includes('light ticket'))
  } finally { await cleanup(f) }
}

export async function assertTimerCancelled(parser) {
  const output = []
  const options = { env: { WT_SUITE_LOCK_DIRECT_WARN_S: '0.05' }, write: (text) => output.push(text) }
  assert.equal(await parser.runDirectCommand(async () => 0, options), 0)
  await delay(300)
  const warnings = () => output.filter((text) => text.includes('direct run still running after'))
  assert.equal(warnings().length, 0, 'timer cancellation: completed direct run must not warn')
  assert.equal(await parser.runDirectCommand(async () => { await delay(300); return 0 }, options), 0)
  assert.equal(warnings().length, 1, 'timer positive control: running direct run must warn exactly once')
}

export const acceptedArguments = [
  ['node', '--test', 'a.test.mjs'], ['nice', '-n', '19', 'node', '--test', 'a.test.mjs'],
  ['nice', 'node', '--test', 'a.test.mjs'], [process.execPath, '--test', 'a.test.mjs'],
  ['nice', '-19', 'node', '--test', 'a.test.mjs'], ['nice', '--adjustment=19', 'node', '--test', 'a.test.mjs'],
  ['node', '--test', '--test-reporter=spec', 'a.test.mjs'],
  ['node', '--test', '--test-name-pattern=x', 'a.test.mjs'], ['node', 'a.selftest.mjs'],
  ['node', '--test', '--test-only', '--no-warnings', '--test-skip-pattern=x', '--test-timeout=200', 'a.test.mjs'],
  ...['tap', 'dot', 'junit', 'lcov'].map((name) => ['node', '--test', `--test-reporter=${name}`, 'a.test.mjs']),
]

const rejectedOptions = [
  '--test-reporter=data:text/javascript,0', '--test-reporter=./r.mjs',
  '--test-global-setup=./s.mjs', '--test-shard=2/2', '--test-unknown=1', '--import=file:///tmp/b.mjs',
  '--require=./b.cjs', '-r', '--loader=file:///tmp/b.mjs', '--experimental-test-coverage',
  '--test-reporter-destination=out', '--test-timeout=x', '--test-only=1', '--no-warnings=1',
  '--test-timeout=1\n', '--test-reporter=spec\n',
]
const forbiddenFilenames = [
  'a?.test.mjs', 'a*.test.mjs', '@(a|b).test.mjs', '+(a|b).test.mjs', 'a b.test.mjs', 'a.test.mjs\n',
]
export const rejectedArguments = [
  ...rejectedOptions.map((option) => ['node', '--test', option, 'a.test.mjs']),
  ...['x.test.mjs', 'missing.test.mjs'].map((file) => ['node', '--test', file]),
  ['node', '--test', 'a.test.mjs', 'b.test.mjs'], ['node', '--test', 'a.test.mjs', 'a.test.mjs'],
  ['node', '--test', '--test-reporter=spec', '--test-reporter=tap', 'a.test.mjs'],
  ['node', '--test'], ['node', '-e0', 'a.test.mjs'], ['node', '--test', 'a.test.mjs', '123'],
  ['node', '--test', '--', 'a.test.mjs'], ['node', '--icu-data-dir', '/x', '--test', 'a.test.mjs'],
  ['node', '--test-reporter', 'spec', '--test', 'a.test.mjs'],
  ['/custom/bin/node', '--test', 'a.test.mjs'], ['env', 'X=1', 'node', '--test', 'a.test.mjs'],
  ['env', 'NODE_OPTIONS=--import=file:///tmp/b.test.mjs', 'node', '--test', 'a.test.mjs'],
  ['X=1', 'node', '--test', 'a.test.mjs'], ['setsid', '--wait', 'node', '--test', 'a.test.mjs'],
  ['pnpm', 'exec', 'node', '--test', 'a.test.mjs'],
  ['node', 'wt-suite-lock.mjs', 'run', '--', 'node', '--test', 'a.test.mjs'],
  ['node', 'tool.mjs'], ['node', 'a.selftest.mjs', 'extra'], ['vitest', 'run', 'a.test.ts'],
  ['bun', 'test', 'a.test.ts'], ['bash', '-c', 'node --test a.test.mjs'], [], null,
  ['nice', '-n', 'x', 'node', '--test', 'a.test.mjs'], ['node', '--test', '--test', 'a.test.mjs'],
  ['node', undefined, 'a.test.mjs'], Array(2),
]

export function assertParser(parser) {
  const f = fixture()
  try {
    writeFileSync(join(f.work, 'a.selftest.mjs'), '')
    mkdirSync(join(f.work, 'x.test.mjs'))
    const options = { cwd: f.work, env: {} }
    for (const argv of acceptedArguments) assert.equal(parser.runsWithoutTicket(argv, options), true, JSON.stringify(argv))
    for (const argv of rejectedArguments) assert.equal(parser.runsWithoutTicket(argv, options), false, JSON.stringify(argv))
    assertFilenames(parser, options)
    assertEnvironment(parser, options)
    const requested = { light: true, staticRun: false, park: null, command: one }
    assert.equal(parser.directLightRun(requested, options), true)
    for (const override of [{ light: false }, { staticRun: true }, { park: {} }]) {
      assert.equal(parser.directLightRun({ ...requested, ...override }, options), false)
    }
  } finally { rmSync(f.work, { recursive: true, force: true }) }
}

function assertFilenames(parser, options) {
  for (const file of forbiddenFilenames) {
    const argv = ['node', '--test', file]
    assert.equal(parser.runsWithoutTicket(argv, { ...options, isFile: () => true }), false, JSON.stringify(argv))
    if (process.platform !== 'win32') {
      writeFileSync(join(options.cwd, file), '')
      assert.equal(parser.runsWithoutTicket(argv, options), false, JSON.stringify(argv))
    }
  }
}

function assertEnvironment(parser, options) {
  for (const NODE_OPTIONS of ['', '   ', '--max-old-space-size=4096', '--no-warnings --enable-source-maps']) {
    assert.equal(parser.runsWithoutTicket(one, { ...options, env: { NODE_OPTIONS } }), true, NODE_OPTIONS)
  }
  for (const NODE_OPTIONS of ['--import=file:///tmp/b.mjs', '--require ./b.cjs', '--max-old-space-size=x', '"--no-warnings"']) {
    assert.equal(parser.runsWithoutTicket(one, { ...options, env: { NODE_OPTIONS } }), false, NODE_OPTIONS)
  }
}
