import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { staleSuiteLockClient, suiteLockReplacementCommand } from '../../../../../plugin/bin/lib/host/suite-lock-client-currency.mjs'

function fixture() {
  const own = 'C:\\Config\\plugins\\cache\\workflow-toolbox\\workflow-toolbox\\old'
  const target = 'C:\\Config\\plugins\\cache\\workflow-toolbox\\workflow-toolbox\\new'
  const registry = { mtimeMs: 1, size: 100 }, manifest = { mtimeMs: 1, size: 50 }
  const files = new Map()
  const state = { order: '4', status: 0, target, registry, manifest, files, now: 0 }
  const probes = [], reads = [], warnings = []
  const io = {
    realpathSync: (file) => file,
    statSync: (file) => {
      const stat = file.endsWith('installed_plugins.json') ? registry : file.endsWith('plugin.json') ? manifest : files.get(file)
      if (stat === null) throw new Error('missing executable')
      return { isFile: () => true, mtimeMs: 1, size: 10, ino: 1, ...stat }
    },
    readFileSync: (file) => {
      reads.push(file)
      if (file.endsWith('installed_plugins.json')) return JSON.stringify({ plugins: {
        'workflow-toolbox@workflow-toolbox': [{ scope: 'user', installPath: state.target, version: 'new' }],
      } })
      return file.endsWith('plugin.json') ? JSON.stringify({ name: 'workflow-toolbox', version: 'new' }) : ''
    },
    spawnSync: (command, args) => { probes.push({ command, args }); return { status: state.status, stdout: state.order } },
    warn: (line) => warnings.push(line),
  }
  const check = (extra = {}) => staleSuiteLockClient({
    moduleUrl: 'file:///C:/Config/plugins/cache/workflow-toolbox/workflow-toolbox/old/bin/lib/suite-lock.mjs',
    ownOrderVersion: 3, argv: ['node', `${own}\\bin\\wt-suite-lock.mjs`, 'run', '--', 'true'],
    cwd: 'C:\\Project', env: {}, platform: 'win32', paths: path.win32, io, now: () => state.now, ...extra,
  })
  return { own, target, state, probes, reads, warnings, check }
}

const cases = []
function test(name, run) { cases.push({ name, run }) }

test('T1 memoizes equal-order admissions and registry/manifest/closure reads', () => {
  const f = fixture()
  f.state.order = '3'
  assert.equal(f.check(), null)
  const reads = [...f.reads]
  assert.equal(f.check(), null)
  assert.equal(f.probes.length, 1, 'two admissions with unchanged identities must perform one probe')
  assert.deepEqual(f.reads, reads, 'unchanged inputs must not repeat registry, manifest or closure reads')
})

test('T1 memoizes unknown probe verdicts and their warning', () => {
  const f = fixture()
  f.state.status = 1
  assert.equal(f.check(), null)
  assert.equal(f.check(), null)
  assert.equal(f.probes.length, 1, 'an unknown verdict must also be memoized')
  assert.equal(f.warnings.length, 1, 'one warning per unchanged unknown verdict')
})

for (const input of ['registry', 'manifest']) for (const field of ['mtimeMs', 'size']) {
  test(`T1 invalidates on ${input} ${field} changes`, () => {
    const f = fixture()
    assert.equal(f.check({ ownOrderVersion: 4 }), null)
    assert.equal(f.check({ ownOrderVersion: 4 }), null)
    assert.equal(f.probes.length, 1, 'unchanged identities must be cached before invalidation')
    f.state[input][field] += 1
    f.state.order = '5'
    assert.equal(f.check({ ownOrderVersion: 4 })?.orderVersion, 5)
    assert.equal(f.probes.length, 2, 'changed identity must trigger a second probe')
  })
}

test('T1 invalidates when the effective install path changes', () => {
  const f = fixture()
  f.check()
  f.state.target = 'C:\\Other Install'
  f.state.registry.size += 1
  assert.equal(f.check()?.installPath, f.state.target)
  assert.equal(f.probes.length, 2)
})

test('T1 caches the verdict without freezing covered command arguments', () => {
  const f = fixture()
  const first = f.check()
  const second = f.check({ argv: ['node', `${f.own}\\bin\\wt-suite-lock.mjs`, 'run', '--', 'second'] })
  assert.notEqual(first?.command, second?.command)
  assert.match(second.command, /"second"$/)
  assert.equal(f.probes.length, 1, 'different covered arguments must reuse the currency verdict')
})

for (const file of ['bin/wt-suite-lock.mjs', 'bin/lib/suite-lock-order.mjs', 'bin/lib/suite-lock.mjs',
  'bin/wt-suite-lock-run.mjs', 'own/bin/lib/suite-lock-order.mjs']) {
  for (const field of ['mtimeMs', 'size', 'ino']) test(`R1 invalidates ${file} ${field}`, () => {
    const f = fixture(), ownFile = file.startsWith('own/')
    const executable = path.win32.join(ownFile ? f.own : f.target, ownFile ? file.slice(4) : file)
    const options = { argv: ['node', `${f.own}\\bin\\wt-suite-lock-run.mjs`, 'run'] }
    assert.equal(f.check(options)?.orderVersion, 4)
    const probes = f.probes.length
    f.state.files.set(executable, { [field]: field === 'size' ? 11 : 2 })
    f.state.order = '3'
    assert.equal(f.check(options), null, 'executable identity changes must discard the cached refusal')
    assert.equal(f.probes.length, probes + 2, 'changed executable identity must re-probe CLI and runner')
  })
}

test('R1 deletion of an enabled executable invalidates a cached refusal', () => {
  const f = fixture()
  assert.equal(f.check()?.orderVersion, 4)
  f.state.files.set(path.win32.join(f.target, 'bin/wt-suite-lock.mjs'), null)
  assert.equal(f.check(), null, 'a deleted enabled CLI must fail open on the next check')
  assert.equal(f.warnings.length, 1)
})

for (const [name, order, status] of [['refusal', '4', 0], ['admission', '3', 0], ['unknown', '4', 1]]) {
  test(`R1 expires a cached ${name} after 60 seconds`, () => {
    const f = fixture()
    f.state.order = order; f.state.status = status
    f.check()
    f.state.now = 59_999
    f.check()
    assert.equal(f.probes.length, 1, 'unchanged evidence should stay memoized before expiry')
    f.state.now = 60_000
    f.state.order = '5'; f.state.status = 0
    assert.equal(f.check()?.orderVersion, 5, 'a verdict must be refreshed at the 60-second boundary')
    assert.equal(f.probes.length, 2)
  })
}

test('T3 replacement starts with the injected absolute interpreter and carries execArgv', () => {
  const command = suiteLockReplacementCommand('/plugin/bin/entry', ['run', '--', 'true'], 'linux', {
    execPath: '/runtime dir/node', execArgv: ['--conditions=x', '--import', '/loader dir/register.mjs'],
  })
  assert.equal(command, "'/runtime dir/node' '--conditions=x' '--import' '/loader dir/register.mjs' '/plugin/bin/entry' 'run' '--' 'true'",
    'replacement must preserve the running interpreter and Node execution flags')
})

for (const entry of ['wt-suite-lock.mjs', 'wt-suite-lock-run.mjs']) {
  test(`T3 ${entry} probes use the injected interpreter and execArgv`, () => {
    const f = fixture(), flags = ['--conditions=x', '--import', '/loader.mjs']
    f.check({ argv: ['node', `${f.own}\\bin\\${entry}`, 'run'], execPath: '/runtime/node', execArgv: flags })
    assert.equal(f.probes.length, entry === 'wt-suite-lock.mjs' ? 1 : 2)
    for (const probe of f.probes) {
      assert.equal(probe.command, '/runtime/node', 'probe must use the same interpreter as the replacement')
      assert.deepEqual(probe.args.slice(0, flags.length), flags, 'probe must preserve Node execution flags')
    }
  })
}

test('T6 labels the Windows replacement command with its shell', () => {
  const f = fixture()
  assert.match(f.check().command, /^cmd\.exe: /, 'Windows recovery commands must identify cmd.exe')
})

for (const argument of ['%', '!', '^', '"', '\n', '\r']) {
  test(`T6 still refuses proven staleness when cmd.exe cannot render ${JSON.stringify(argument)}`, () => {
    const f = fixture()
    const verdict = f.check({ argv: ['node', `${f.own}\\bin\\wt-suite-lock.mjs`, 'run', '--', argument] })
    assert.equal(verdict?.orderVersion, 4, 'unrenderable recovery must not discard positive stale-client evidence')
    assert.equal(verdict.command, null, 'unrenderable recovery must use restart-from-install guidance')
    assert.equal(f.warnings.length, 0, 'proven staleness is not an unknown currency verdict')
  })
}

export const currencyFixCases = cases

export function assertAcquisitionProjectCurrency(plugin, scenario = 'library') {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'wt-currency-project-')))
  try { proveAcquisitionProject(root, plugin, scenario) } finally { rmSync(root, { recursive: true, force: true }) }
}

function proveAcquisitionProject(root, plugin, scenario) {
  const own = path.join(root, 'plugins/cache/workflow-toolbox/workflow-toolbox/old')
  const target = path.join(root, 'plugins/cache/workflow-toolbox/workflow-toolbox/new')
  const project = path.join(root, 'project'), service = path.join(root, 'service')
  mkdirSync(project); mkdirSync(service)
  for (const [install, version] of [[own, 'old'], [target, 'new']]) {
    cpSync(path.join(plugin, 'bin'), path.join(install, 'bin'), { recursive: true })
    mkdirSync(path.join(install, '.claude-plugin'))
    writeFileSync(path.join(install, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'workflow-toolbox', version }))
  }
  const order = path.join(own, 'bin/lib/suite-lock-order.mjs')
  writeFileSync(order, readFileSync(order, 'utf8').replace('SUITE_LOCK_ORDER_VERSION = 4', 'SUITE_LOCK_ORDER_VERSION = 3'))
  writeFileSync(path.join(root, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: {
    'workflow-toolbox@workflow-toolbox': [{ scope: 'user', installPath: target, version: 'new' },
      ...((scenario === 'memo' || scenario.startsWith('mutation-')) ? [] : [{ scope: 'project', projectPath: project, installPath: own, version: 'old' }])],
  } }))
  if (scenario === 'broker-null') writeFileSync(path.join(root, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: {
    'workflow-toolbox@workflow-toolbox': [{ scope: 'user', installPath: own, version: 'old' },
      { scope: 'project', projectPath: project, installPath: target, version: 'new' }],
  } }))
  const script = acquisitionScript({ root, own, project }, scenario)
  const env = { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: root, CLAUDE_PROJECT_DIR: ['broker-env', 'broker-null'].includes(scenario) ? project : service,
    WT_SUITE_LOCK_DIR: path.join(root, 'locks'), WT_SUITE_LOCK_BROKER: '', WT_SUITE_LEASE: '', WT_SUITE_LOCK: '', NODE_OPTIONS: '' }
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, cwd: service, encoding: 'utf8', timeout: 20_000 })
  assert.equal(result.status, 0, `explicit acquisition cwd must outrank environment and service cwd: ${result.stderr}`)
}

function acquisitionScript({ root, own, project }, scenario) {
  const url = JSON.stringify(pathToFileURL(path.join(own, 'bin/lib/suite-lock.mjs')).href)
  const options = JSON.stringify({ root: path.join(root, 'locks'), cwd: project, light: true })
  if (scenario.startsWith('mutation-')) return mutationScript(root, own, scenario)
  if (scenario === 'memo') return `
    import assert from 'node:assert/strict'; import fs from 'node:fs';
    import childProcess from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
    let probes = 0; childProcess.spawnSync = () => { probes++; return { status: 0, stdout: '3' } }; syncBuiltinESMExports();
    const { acquireSuiteLock, releaseSuiteLock } = await import(${url});
    for (let i = 0; i < 2; i++) releaseSuiteLock(await acquireSuiteLock(${options}));
    assert.equal(probes, 1, 'two consecutive enqueues must share one equal-order probe');
    fs.appendFileSync(${JSON.stringify(path.join(root, 'plugins/installed_plugins.json'))}, ' ');
    releaseSuiteLock(await acquireSuiteLock(${options}));
    assert.equal(probes, 2, 'registry identity change must re-probe the next enqueue');`
  if (scenario.startsWith('broker')) return `
    import assert from 'node:assert/strict';
    const { acquireSuiteLock, releaseSuiteLock, readSuiteLock } = await import(${url});
    const { createSuiteLockBroker } = await import(${JSON.stringify(pathToFileURL(path.join(own, 'bin/lib/host/lane-suite-lock-broker.mjs')).href)});
    const socket = ${JSON.stringify(path.join(root, 'broker.sock'))};
    const broker = createSuiteLockBroker(${JSON.stringify(scenario === 'broker-null' ? { root: null } : scenario === 'broker-env' ? {} : { root: project })});
    await new Promise(resolve => broker.listen(socket, resolve));
    const acquire = () => acquireSuiteLock({ light: true, env: { ...process.env, WT_SUITE_LOCK_BROKER: socket } });
    try {
      if (${JSON.stringify(scenario)} === 'broker-null') await assert.rejects(async () => { releaseSuiteLock(await acquire()); }, { code: 'WT_SUITE_LOCK_STALE_CLIENT' }, 'null broker root must select the newer project install and refuse');
      else {
        const lease = await acquire();
        try {
          if (${JSON.stringify(scenario)} === 'broker-ticket') assert.equal(readSuiteLock().holder.cwd, process.cwd(), 'broker ticket cwd must remain the service cwd while root selects the install');
        } finally { releaseSuiteLock(lease); }
      }
    }
    finally { broker.releaseAll(); await new Promise(resolve => broker.close(resolve)); }`
  return `const { acquireSuiteLock, releaseSuiteLock } = await import(${url}); releaseSuiteLock(await acquireSuiteLock(${options}));`
}

function mutationScript(root, own, scenario) {
  const target = path.join(root, 'plugins/cache/workflow-toolbox/workflow-toolbox/new')
  return `
    import assert from 'node:assert/strict'; import fs from 'node:fs';
    const { staleSuiteLockClient } = await import(${JSON.stringify(pathToFileURL(path.join(own, 'bin/lib/host/suite-lock-client-currency.mjs')).href)});
    const order = ${JSON.stringify(path.join(target, 'bin/lib/suite-lock-order.mjs'))};
    const source = fs.readFileSync(order, 'utf8');
    const check = () => staleSuiteLockClient({ moduleUrl: ${JSON.stringify(pathToFileURL(path.join(own, 'bin/lib/suite-lock.mjs')).href)}, ownOrderVersion: 3 });
    if (${JSON.stringify(scenario)} === 'mutation-admission') fs.writeFileSync(order, source.replace('SUITE_LOCK_ORDER_VERSION = 4', 'SUITE_LOCK_ORDER_VERSION = 3'));
    assert.equal(check()?.orderVersion ?? null, ${scenario === 'mutation-admission' ? 'null' : '4'});
    if (${JSON.stringify(scenario)} === 'mutation-cli') fs.rmSync(${JSON.stringify(path.join(target, 'bin/wt-suite-lock.mjs'))});
    else fs.writeFileSync(order, ${scenario === 'mutation-admission' ? 'source' : "source.replace('SUITE_LOCK_ORDER_VERSION = 4', 'SUITE_LOCK_ORDER_VERSION = 3')"});
    assert.equal(check()?.orderVersion ?? null, ${scenario === 'mutation-admission' ? '4' : 'null'}, 'executable mutation must refresh the next real-filesystem currency verdict');`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const plugin = process.env.WT_CURRENCY_TEST_PLUGIN_ROOT ?? fileURLToPath(new URL('../../../../../plugin', import.meta.url))
  let failures = 0
  const acquisitions = ['library', 'memo', 'mutation-cli', 'mutation-order', 'mutation-admission',
    ...(process.platform === 'win32' ? [] : ['broker', 'broker-env', 'broker-null', 'broker-ticket'])]
    .map((scenario) => ({ name: `cached acquisition: ${scenario}`, run: () => assertAcquisitionProjectCurrency(plugin, scenario) }))
  for (const { name, run } of [...currencyFixCases, ...acquisitions]) {
    try { run(); console.log(`PASS ${name}`) }
    catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`) }
  }
  console.log(`${currencyFixCases.length + acquisitions.length} cases; ${failures} failed`)
  process.exitCode = failures ? 1 : 0
}
