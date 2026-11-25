import assert from 'node:assert/strict'
import { spawnSync } from '../../../../test-support/bounded-hook-spawn.mjs'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { runInNewContext } from 'node:vm'

export function assertCurrencyRefusal(plugin) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-currency-proof-')))
  try { proveRefusal(root, plugin) } finally { rmSync(root, { recursive: true, force: true }) }
}

function proveRefusal(root, plugin) {
  const cache = join(root, 'plugins/cache/workflow-toolbox/workflow-toolbox')
  const old = join(cache, '0.0.1'), current = join(cache, '0.0.2'), lock = join(root, 'locks'), marker = join(root, 'marker')
  for (const [target, version] of [[old, '0.0.1'], [current, '0.0.2']]) {
    cpSync(join(plugin, 'bin'), join(target, 'bin'), { recursive: true })
    mkdirSync(join(target, '.claude-plugin'))
    writeFileSync(join(target, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'workflow-toolbox', version }))
  }
  const order = join(old, 'bin/lib/suite-lock-order.mjs')
  writeFileSync(order, readFileSync(order, 'utf8').replace('SUITE_LOCK_ORDER_VERSION = 4', 'SUITE_LOCK_ORDER_VERSION = 3'))
  writeFileSync(join(root, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: {
    'workflow-toolbox@workflow-toolbox': [{ scope: 'user', installPath: current, version: '0.0.2' }],
  } }))
  const env = { ...process.env, CLAUDE_CONFIG_DIR: root, CLAUDE_PROJECT_DIR: root, HOME: root, USERPROFILE: root,
    WT_SUITE_LOCK_DIR: lock, WT_SUITE_LOCK_BROKER: '', WT_SUITE_LEASE: '', WT_SUITE_LOCK: '',
    WT_PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: '', NODE_OPTIONS: '', WT_SUITE_LOCK_PRIORITY: 'P1' }
  const script = join(root, 'child.mjs')
  writeFileSync(script, 'import fs from "node:fs"; fs.writeFileSync(process.argv[2], "ran")')
  const args = ['run', '--light', '--', process.execPath, script, marker]
  const refused = spawnSync(process.execPath, [join(old, 'bin/wt-suite-lock.mjs'), ...args], { env, encoding: 'utf8', timeout: 20_000 })
  assert.equal(refused.status, 78, 'stale cached writer must refuse with exit 78 before publishing a ticket')
  assert.match(refused.stderr, /wt-suite-lock: REFUSED stale-client:/)
  assert.doesNotMatch(refused.stderr, /Usage:/)
  assert.equal(existsSync(marker), false)
  assert.equal(existsSync(lock), false, 'refusal must precede directories, counters and tickets')
  const command = refused.stderr.split('\n').find((line) => line.startsWith('Replacement command: '))?.slice(21)
  assert.ok(command, 'refusal must print the exact replacement command')
  if (process.platform === 'win32') assert.match(command, /^cmd\.exe: /)
  const executable = process.platform === 'win32' ? command.slice('cmd.exe: '.length) : command
  const replaced = spawnSync(executable, { shell: true, env, encoding: 'utf8', timeout: 20_000 })
  assert.equal(replaced.status, 0, replaced.stderr)
  assert.equal(readFileSync(marker, 'utf8'), 'ran')
}

function resolverCases() {
  const user = { scope: 'user', installPath: '/user' }
  const project = { scope: 'project', projectPath: '/project', installPath: '/project-plugin' }
  const local = { scope: 'local', projectPath: '/project', installPath: '/local' }
  const entries = [[], [user], [user, project], [project, local, user], [local, project],
    [{ ...project, projectPath: '/other' }, user], [{ scope: 'user', installPath: 'relative' }]]
  const envs = [{}, { WT_PLUGIN_ROOT: '/override' }, { WT_PLUGIN_ROOT: '' }, { CLAUDE_PLUGIN_ROOT: '/fallback' },
    { CLAUDE_PROJECT_DIR: '/project/child' }, { CLAUDE_PROJECT_DIR: '/other', USERPROFILE: '/profile' }]
  return entries.flatMap((values) => envs.flatMap((env) => ['none', 'registry', 'manifest', 'stat', 'realpath', 'env'].map((fault) => ({ values, env, fault }))))
}

function observeResolver(source, scenario) {
  const trace = []
  const failure = (kind) => { if (scenario.fault === kind) throw new Error(`injected ${kind}`) }
  const fs = {
    realpathSync(value) { trace.push(['realpath', value, this === fs]); failure('realpath'); return value },
    readFileSync(value, encoding) {
      trace.push(['read', value, encoding, this === fs])
      if (value.endsWith('installed_plugins.json')) { failure('registry'); return JSON.stringify({ plugins: { 'workflow-toolbox@fixture': scenario.values } }) }
      failure('manifest'); return JSON.stringify({ name: 'workflow-toolbox', version: 'fixture' })
    },
    statSync(value) { trace.push(['stat', value, this === fs]); failure('stat'); return { isFile() { trace.push(['isFile']); return true } } },
  }
  const env = new Proxy(scenario.env, { get(target, key) { trace.push(['env', key]); if (scenario.fault === 'env' && key === 'WT_PLUGIN_ROOT') throw new Error('injected env'); return target[key] } })
  const process = { env, cwd() { trace.push(['cwd', this === process]); return '/project' } }
  const context = { fs, process, path: path.posix, os: { homedir() { trace.push(['home']); return '/home' } } }
  const resolve = runInNewContext(`${source}\nresolveAdoptedScript`, context)
  try { return { value: JSON.parse(JSON.stringify(resolve('wt-lane.mjs'))), trace } }
  catch (error) { return { error: { name: error.name, message: error.message }, trace } }
}

export function assertResolverParity(plugin) {
  const before = readFileSync(new URL('./adopted-resolver-before-currency.txt', import.meta.url), 'utf8')
  const text = readFileSync(join(plugin, 'bin/lib/host/adopted-script-shim.mjs'), 'utf8')
  const current = text.slice(text.indexOf('function canonical('), text.indexOf('function failAdoptedScript(')).replaceAll(/^export /gm, '')
  const cases = resolverCases()
  for (const [index, scenario] of cases.entries()) {
    assert.deepEqual(observeResolver(current, scenario), observeResolver(before, scenario), `registry resolver must preserve outputs errors reads and outgoing calls: case ${index + 1}`)
  }
  return cases.length
}

// Frozen pre-quality-cleanup bodies: compare the cleanup by execution, not a diff read.
function previousQuoteWindowsWord(word) {
  return `"${word.replace(/(\\+)$/, '$1$1')}"`
}
function previousRelativeImports(source) {
  const pattern = /\b(?:import\s*(?:\(\s*|[^'";]*?\bfrom\s*)?|export\s+[^'";]*?\bfrom\s*)['"](\.{1,2}\/[^'"]+)['"]/g
  return [...source.matchAll(pattern)].map((match) => match[1])
}
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`)
  return source.slice(start, source.indexOf('\n}', start) + 2)
}
function outcome(operation) {
  try { const value = operation(); return { value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) } }
  catch (error) { return { error: { name: error.name, message: error.message } } }
}
function previousUpgradeResumedOrder(resumed, fresh) {
  if (fresh.levelOrderVersion <= 2 || !(fresh.levelOrderVersion > (resumed.levelOrderVersion ?? 0))) return
  resumed.levelOrderVersion = fresh.levelOrderVersion
  resumed.project ??= fresh.project
  resumed.size ??= fresh.size
}
function observeUpgrade(upgrade, savedVersion, freshVersion, metadata, fault) {
  const trace = [], saved = { levelOrderVersion: savedVersion, ...metadata }
  const track = (target, name) => new Proxy(target, {
    get(object, key) { trace.push(['get', name, key]); if (`${name}.${key}` === fault) throw new Error(`injected ${fault}`); return object[key] },
    set(object, key, value) { trace.push(['set', name, key, value]); object[key] = value; return true },
  })
  const fresh = { levelOrderVersion: freshVersion, project: 'fresh', size: 'S' }
  const result = outcome(() => upgrade(track(saved, 'saved'), track(fresh, 'fresh')))
  return { result, saved, trace }
}
function assertParkUpgradeCases(plugin) {
  const text = readFileSync(join(plugin, 'bin/lib/suite-lock-park.mjs'), 'utf8')
  const current = runInNewContext(`${functionBody(text, 'upgradeResumedOrder')}\nupgradeResumedOrder`, { BOUNDED_P0_ORDER_VERSION: 2 })
  let count = 0
  const compare = (...args) => assert.deepEqual(observeUpgrade(current, ...args), observeUpgrade(previousUpgradeResumedOrder, ...args), `park upgrade cleanup parity: case ${++count}`)
  for (const saved of [undefined, null, 0, 2, 3, 4, 'unknown', 5, NaN]) for (const fresh of [undefined, null, 2, 3, 4, NaN]) for (const metadata of [{}, { project: null, size: null }, { project: 'saved', size: 'L' }]) compare(saved, fresh, metadata)
  for (const fault of ['fresh.levelOrderVersion', 'saved.levelOrderVersion', 'saved.project', 'fresh.project', 'saved.size', 'fresh.size']) compare(2, 4, {}, fault)
  return count
}
export function assertCurrencyQualityParity(plugin) {
  const source = readFileSync(join(plugin, 'bin/lib/host/suite-lock-client-currency.mjs'), 'utf8')
  const bodies = ['quoteWindowsWord', 'relativeSuiteLockImports'].map((name) => functionBody(source, name)).join('\n')
  const current = runInNewContext(`${bodies}\n({ quote: quoteWindowsWord, imports: relativeSuiteLockImports })`)
  const argumentsList = [[], [''], ['a b'], ["a'b"], ['%', '!'], ['C:\\tail\\'], ['a\\b', 'x\\'], ['"'], ['\n'], ['$a', 'a|b'], ['`cmd`'], ['unicode-λ']]
  let count = 0
  for (const platform of ['linux', 'win32']) for (const entry of ['/entry', '/plugin dir/entry', 'C:\\tail\\']) for (const args of argumentsList) {
    // Rendering semantics deliberately changed; the untouched quoting cleanup still compares to its frozen base.
    assert.deepEqual(outcome(() => [platform, ...[entry, ...args].map(current.quote)]), outcome(() => [platform, ...[entry, ...args].map(previousQuoteWindowsWord)]), `word quoting cleanup parity: ${++count}`)
  }
  const forms = ["import './a.mjs';", "import x from '../b.mjs';", "import {\n x,\n y\n} from './c.mjs';", "export * from './d.mjs';",
    "export { x as y } from '../e.mjs';", "const lazy = () => import('./f.mjs');", "const x = import (\n '../g.mjs'\n);", "import builtin from 'node:fs';"]
  for (const left of forms) for (const right of forms) {
    const text = left + '\n' + right
    assert.deepEqual(outcome(() => current.imports(text)), outcome(() => previousRelativeImports(text)), `import cleanup parity: ${++count}`)
  }
  return count + assertParkUpgradeCases(plugin)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const plugin = process.env.WT_CURRENCY_TEST_PLUGIN_ROOT ?? fileURLToPath(new URL('../../../../../plugin', import.meta.url))
  if (process.argv.includes('--resolver')) console.log(`resolver differential: ${assertResolverParity(plugin)} cases passed`)
  else if (process.argv.includes('--quality-parity')) console.log(`currency quality differential: ${assertCurrencyQualityParity(plugin)} cases passed`)
  else { assertCurrencyRefusal(plugin); console.log('currency refusal and executable replacement: passed') }
}
