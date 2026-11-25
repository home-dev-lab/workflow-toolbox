import assert from 'node:assert/strict'
import { spawnSync as nativeSpawnSync, execFileSync as nativeExecFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'
import { nativeSynchronousImportLines, scanNativeHookTestImports, scanSpawningTestFiles } from '../../../scripts/spawning-test-files.mjs'
import { scanAmbientState } from '../../../scripts/ambient-state-census.mjs'
import { scanFixedWaits } from '../../../scripts/fixed-wait-census.mjs'

const moduleUrl = process.env.WT_HOOK_SPAWN_TEST_MODULE
  ? pathToFileURL(process.env.WT_HOOK_SPAWN_TEST_MODULE).href
  : new URL('../../../test-support/bounded-hook-spawn.mjs', import.meta.url).href
const bounded = await import(moduleUrl)

test('audited hook and plugin-bin subprocess tests use bounded imports, including generated launchers', () => {
  assert.deepEqual(scanNativeHookTestImports(), [], 'audited hook/plugin-bin tests must not import native synchronous child processes')
})

test('the audited import lock recognizes aliases and emitted fixture imports without matching comments or mocks', () => {
  for (const source of [
    "import { spawnSync as run } from 'node:child_process'",
    "import { execFileSync } from 'child_process'",
    "import { execSync } from 'node:child_process'",
    "import * as cp from 'node:child_process'; cp.spawnSync('node')",
    "import cp from 'node:child_process'; cp.execSync('node')",
    'const source = `import { spawnSync } from "node:child_process"; spawnSync(${target})`',
    'const source = "import { spawnSync } from \'node:child_process\'"',
  ]) assert.deepEqual(nativeSynchronousImportLines(source), [1], source)
  for (const source of [
    "// import { spawnSync } from 'node:child_process'",
    "import { spawn } from 'node:child_process'",
    "import type { SpawnSyncOptions } from 'node:child_process'",
    "import { spawnSync } from '../../test-support/bounded-hook-spawn.mjs'",
    "const cp = require('node:child_process'); cp.spawnSync = () => ({status: 0})",
    "import cp from 'node:child_process'; cp.spawnSync = () => ({status: 0})",
  ]) assert.deepEqual(nativeSynchronousImportLines(source), [], source)
})

test('both bounded import depths retain spawning, ambient-state and fixed-wait census coverage', () => {
  const root = mkdtempSync(join(tmpdir(), 'bounded-census-parity-'))
  try {
    for (const dir of ['packages/build/test', 'examples/test', 'scripts/test']) mkdirSync(join(root, dir), { recursive: true })
    for (const method of ['spawnSync', 'execFileSync']) {
      const file = join(root, 'scripts/test/child.test.ts')
      const source = module => `import { ${method} as run } from '${module}'\nrun('node', ['hook.mjs'], { env: { ...process.env }, timeout: 1000 })`
      writeFileSync(file, source('node:child_process'))
      const scan = () => [scanSpawningTestFiles(root), scanAmbientState(root), scanFixedWaits(root)]
      const before = scan()
      assert.deepEqual(before.map(findings => findings.length), [1, 1, 1])
      for (const module of ['../../test-support/bounded-hook-spawn.mjs', '../../../test-support/bounded-hook-spawn.mjs']) {
        writeFileSync(file, source(module))
        assert.deepEqual(scan(), before, `${method}: ${module}`)
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

function generatedLauncherTemplates() {
  const source = readFileSync(new URL('./sdk-pilot-lifecycle-server.test.ts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('launchers.ts', source, ts.ScriptTarget.Latest, true)
  const templates = []
  const visit = node => {
    if (ts.isCallExpression(node) && ['rawLauncher', 'launcher'].includes(node.expression.getText(parsed))) {
      const template = node.arguments[0]
      if (template && ts.isTemplateExpression(template) && template.getText(parsed).includes('BOUNDED_SPAWN_URL')) templates.push(template.getText(parsed))
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return templates
}

function runRelocatedLauncher(template) {
  const root = mkdtempSync(join(tmpdir(), 'bounded-launcher-import-'))
  try {
    mkdirSync(join(root, '.lane'))
    const cli = join(root, 'fake-cli.mjs'), file = join(root, 'launcher.mjs')
    const log = join(root, 'run.log'), brief = join(root, 'brief.md'), report = join(root, 'report.md')
    writeFileSync(cli, 'process.stdout.write("pid=0\\n")')
    writeFileSync(log, 'LANE_NONCE=fixture\n')
    writeFileSync(brief, `Write the report to \`${report}\``)
    const render = new Function('BOUNDED_SPAWN_URL', 'fakeSource', 'realLauncher', 'hermeticPath', 'helperSource', 'old', `return ${template}`)
    writeFileSync(file, render(moduleUrl, '', cli, () => process.env.PATH, 'process.exit(0)', cli))
    const result = nativeSpawnSync(process.execPath, [file, '--dir', root, '--log', log, '--brief', brief], {
      cwd: root, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    if (existsSync(report)) assert.equal(readFileSync(report, 'utf8'), 'report\n')
    else assert.equal(result.stdout, 'pid=0\n')
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('all generated synchronous lifecycle launchers resolve the bounded helper from temporary directories', () => {
  const templates = generatedLauncherTemplates()
  assert.equal(templates.length, 4, 'every generated synchronous launcher must carry its relocatable helper URL')
  for (const template of templates) runRelocatedLauncher(template)
})

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
