import assert from 'node:assert/strict'
import { spawnSync as nativeSpawnSync, execFileSync as nativeExecFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const moduleUrl = process.env.WT_HOOK_SPAWN_TEST_MODULE
  ? pathToFileURL(process.env.WT_HOOK_SPAWN_TEST_MODULE).href
  : new URL('../../../test-support/bounded-hook-spawn.mjs', import.meta.url).href
const bounded = await import(moduleUrl)

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bounded-hook-spawn-'))
  const hook = join(root, 'never-exits-hook.mjs')
  const pid = join(root, 'child.pid')
  writeFileSync(hook, `import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => {});
    writeFileSync(${JSON.stringify(pid)}, String(process.pid));
    process.stdout.write('partial output');
    setInterval(() => {}, 1000);
  `)
  return { root, hook, pid, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function assertStall(run, timeout) {
  const f = fixture()
  const start = performance.now()
  try {
    assert.throws(() => run(f), error => {
      assert.equal(error.message, `stalled hook child: ${f.hook} exceeded ${timeout} ms`)
      assert.equal(error.cause.code, 'ETIMEDOUT')
      assert.equal(error.result.signal, 'SIGKILL')
      return true
    })
    assert.ok(performance.now() - start < timeout + 5000, 'stalled child must fail within the deadline plus scheduling slack')
    const pid = Number(readFileSync(f.pid, 'utf8'))
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  } finally { f.cleanup() }
}

test('default deadline kills a stalled hook child and names the hook and timeout', () => {
  assertStall(f => bounded.spawnSync(process.execPath, [f.hook], { encoding: 'utf8' }), bounded.HOOK_SPAWN_TIMEOUT_MS)
})

test('an explicit shorter deadline cannot be weakened by a SIGTERM override', () => {
  assertStall(f => bounded.spawnSync(process.execPath, [f.hook], { timeout: 5000, killSignal: 'SIGTERM', encoding: 'utf8' }), 5000)
})

test('a timed-out native spawn cannot return partial output', () => {
  assertStall(f => bounded.spawnSync(process.execPath, [f.hook], { timeout: 5000, killSignal: 'SIGKILL', encoding: 'utf8' }), 5000)
})

test('execFileSync turns ETIMEDOUT into the same named failure', () => {
  assertStall(f => bounded.execFileSync(process.execPath, [f.hook], { timeout: 5000, encoding: 'utf8', stdio: 'pipe' }), 5000)
})

test('the timeout names the hook instead of a guard-named preload', () => {
  assertStall(f => {
    const preload = join(f.root, 'guard-preload.mjs')
    writeFileSync(preload, '')
    return bounded.spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, f.hook], { timeout: 5000, encoding: 'utf8' })
  }, 5000)
})

test('timeouts throw out of a test process instead of returning plausible partial output', () => {
  const f = fixture()
  try {
    const program = `import {spawnSync} from ${JSON.stringify(moduleUrl)}; spawnSync(process.execPath, [${JSON.stringify(f.hook)}], {timeout:5000, encoding:'utf8'});`
    const run = nativeSpawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL' })
    assert.equal(run.status, 1)
    assert.equal(run.error, undefined)
    assert.ok(run.stderr.includes(`stalled hook child: ${f.hook} exceeded 5000 ms`))
  } finally { f.cleanup() }
})

for (const timeout of [0, -1, Infinity, NaN, 0.5]) {
  test(`rejects an unbounded or invalid timeout: ${timeout}`, () => {
    assert.throws(() => bounded.spawnSync(process.execPath, ['-e', ''], { timeout }), /hook spawn timeout must be a positive integer/)
  })
}

for (const encoding of [undefined, 'utf8']) {
  for (const exit of [0, 7]) {
    test(`native result parity: encoding=${encoding}, exit=${exit}`, () => {
      const root = mkdtempSync(join(tmpdir(), 'bounded-hook-parity-'))
      try {
        const code = `process.stdout.write(process.cwd()+'|'+process.env.HOOK_TEST_VALUE+'|'+process.argv[1]+'|'); process.stdin.pipe(process.stdout); process.stderr.write('diagnostic'); process.on('exit',()=>{process.exitCode=${exit}})`
        const args = ['-e', code, 'λ argument']
        const options = { cwd: root, env: { ...process.env, HOOK_TEST_VALUE: 'fixture' }, input: 'stdin data', encoding }
        const before = nativeSpawnSync(process.execPath, args, options)
        const after = bounded.spawnSync(process.execPath, args, options)
        for (const key of ['status', 'signal', 'stdout', 'stderr', 'error']) assert.deepEqual(after[key], before[key], key)
        if (exit === 0) assert.deepEqual(bounded.execFileSync(process.execPath, args, options), nativeExecFileSync(process.execPath, args, options))
        else assert.throws(() => bounded.execFileSync(process.execPath, args, { ...options, stdio: 'pipe' }), error => error.status === exit && String(error.stdout) === String(before.stdout))
      } finally { rmSync(root, { recursive: true, force: true }) }
    })
  }
}

test('spawn options overload retains stdin, encoding and the native result', () => {
  const options = { input: 'process.stdout.write("from stdin")', encoding: 'utf8' }
  assert.equal(bounded.spawnSync(process.execPath, options).stdout, nativeSpawnSync(process.execPath, options).stdout)
})

test('non-timeout spawn errors retain the native error code', () => {
  const root = mkdtempSync(join(tmpdir(), 'bounded-hook-missing-'))
  try {
    const run = bounded.spawnSync(join(root, 'missing-node'), [], { encoding: 'utf8' })
    assert.equal(run.error.code, 'ENOENT')
    assert.equal(run.status, null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

function runCopiedModel(source, args, action) {
  const root = mkdtempSync(join(tmpdir(), 'bounded-model-copy-'))
  try {
    const file = join(root, 'model.mjs')
    const gate = join(root, 'gate.sh')
    writeFileSync(file, source)
    writeFileSync(gate, '#!/bin/sh\nexec "$@"\n')
    chmodSync(gate, 0o755)
    const run = nativeSpawnSync(process.execPath, [file, 'opencode', ...args], {
      cwd: root, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root, WT_FAKE_OPENCODE_ACTION: action, WT_SUITE_LOCK_CMD: gate },
    })
    assert.equal(run.status, 0, run.stderr)
    const record = join(root, 'suite-lock-run')
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, record: existsSync(record) ? readFileSync(record, 'utf8') : null }
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('copied model fixtures retain native behavior with a relocated bounded import', () => {
  const source = readFileSync(new URL('./fixtures/fake-opencode.mjs', import.meta.url), 'utf8')
  const specifier = "'../../../../test-support/bounded-hook-spawn.mjs'"
  const before = source.replace(specifier, "'node:child_process'")
  const after = source.replace(specifier, JSON.stringify(moduleUrl))
  const cases = [[['--version'], ''], [['debug', 'skill'], ''], [['run'], 'true']]
  if (process.platform !== 'win32' && nativeSpawnSync('zsh', ['--version'], { timeout: 5000, killSignal: 'SIGKILL' }).status === 0) cases.push([['run'], 'suite-lock-run-zsh'])
  for (const [args, action] of cases) assert.deepEqual(runCopiedModel(after, args, action), runCopiedModel(before, args, action))
  console.log(`copied-model differential cases=${cases.length}`)
})
