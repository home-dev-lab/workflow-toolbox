import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const SOURCE = fileURLToPath(new URL('../../../../../plugin', import.meta.url))
const FILE = 'wt-lane.mjs'
const FILES = [FILE, 'wt-lane-wait.mjs', 'wt-arc-watch.mjs', 'wt-quota-watch.mjs']

function fakePlugin(root, label) {
  const plugin = path.join(root, label)
  fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true })
  fs.mkdirSync(path.join(plugin, 'bin'))
  fs.writeFileSync(path.join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'workflow-toolbox', version: '1.0.0' }))
  for (const file of FILES) fs.writeFileSync(path.join(plugin, 'bin', file), `process.stdout.write(${JSON.stringify(label)})`)
  return plugin
}

function fixture(source) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-shim-fix-')))
  const config = path.join(root, 'config'), project = path.join(root, 'project'), scripts = path.join(config, 'scripts')
  fs.mkdirSync(path.join(config, 'plugins'), { recursive: true }); fs.mkdirSync(project)
  const env = { ...process.env, HOME: root, USERPROFILE: root, XDG_STATE_HOME: path.join(root, 'state'), NPM_CONFIG_PREFIX: path.join(root, 'npm-prefix'), CLAUDE_CONFIG_DIR: config, CLAUDE_PROJECT_DIR: project }
  for (const key of ['WT_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'NODE_OPTIONS', 'WT_ADOPT_REFRESH']) delete env[key]
  const plugin = fakePlugin(root, 'preferred')
  const registry = (entries) => fs.writeFileSync(path.join(config, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'workflow-toolbox@fixture': entries } }))
  registry([{ scope: 'user', installPath: plugin }])
  const node = (args, options = {}) => spawnSync(process.execPath, args, { env, cwd: project, encoding: 'utf8', timeout: 15_000, ...options })
  const installer = (...args) => node([path.join(source, 'skills/adopt/scripts/install.mjs'), '--set', 'scripts', '--dir', scripts, ...args])
  const installed = installer('--install')
  assert.equal(installed.status, 0, installed.stdout + installed.stderr)
  const shim = path.join(scripts, FILE), target = path.join(plugin, 'bin', FILE)
  const run = (...args) => node([shim, ...args])
  const check = () => installer('--check', '--fail-on-drift')
  const hook = (hookSource = source) => node([path.join(hookSource, 'bin/wt-adopt-check-hook.mjs')], { input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: project }) })
  return { root, config, project, scripts, env, plugin, registry, node, installer, shim, target, run, check, hook }
}

function refused(f, candidate) {
  const result = f.run()
  assert.equal(result.status, 2, 'the first present candidate must refuse instead of falling through')
  assert.ok(result.stdout.includes(candidate), 'refusal must name the failed candidate')
  assert.equal(result.stderr, result.stdout)
  assert.match(f.check().stdout, /wt-lane\.mjs: TARGET-MISSING/)
}

function copyHook(f, source) {
  const copy = path.join(f.root, 'hook-copy')
  fs.cpSync(path.join(source, 'bin/lib'), path.join(copy, 'bin/lib'), { recursive: true })
  fs.copyFileSync(path.join(source, 'bin/wt-adopt-check-hook.mjs'), path.join(copy, 'bin/wt-adopt-check-hook.mjs'))
  return copy
}

export const fixLocks = {
  'banner executable prefix': (f) => {
    const text = fs.readFileSync(f.shim, 'utf8').replace('// installed from', 'process.exit(0); // installed from')
    fs.writeFileSync(f.shim, text)
    const result = f.check()
    assert.equal(result.status, 1, 'executable code on the banner line must be drift')
    assert.match(result.stdout, /wt-lane\.mjs: EDITED/)
  },
  'banner trailing code': (f) => {
    const lines = fs.readFileSync(f.shim, 'utf8').split('\n')
    lines[1] += ' process.exit(0);'
    fs.writeFileSync(f.shim, lines.join('\n'))
    assert.match(f.check().stdout, /wt-lane\.mjs: EDITED/, 'only the exact rendered banner may be removed')
  },
  'symlink strict check': (f) => {
    fs.rmSync(f.shim); fs.symlinkSync(f.target, f.shim)
    assert.equal(f.check().status, 1, 'a symlinked script must fail the strict drift check')
  },
  'symlink hook remedy': (f) => {
    fs.rmSync(f.shim); fs.symlinkSync(path.join(f.root, 'missing'), f.shim)
    const result = f.hook()
    assert.match(result.stdout, /wt-lane\.mjs.*SYMLINK/, 'the hook must report even a dangling script symlink')
    assert.ok(result.stdout.includes('--replace-symlinks'), 'symlink remedy must use --replace-symlinks')
  },
  'broken override refuses': (f) => {
    f.env.WT_PLUGIN_ROOT = path.join(f.root, 'missing-plugin')
    refused(f, f.env.WT_PLUGIN_ROOT)
  },
  'broken registry refuses': (f) => {
    const fallback = fakePlugin(f.root, 'fallback')
    fs.rmSync(f.target)
    f.registry([{ scope: 'user', installPath: fallback }, { scope: 'project', projectPath: f.project, installPath: f.plugin }])
    f.env.CLAUDE_PLUGIN_ROOT = fallback
    refused(f, f.plugin)
  },
  'unknown scopes ignored': (f) => {
    const wrong = fakePlugin(f.root, 'wrong')
    for (const scope of [undefined, null, 'garbage']) {
      f.registry([{ scope, installPath: wrong }, { scope: 'user', installPath: f.plugin }])
      assert.equal(f.run().stdout, 'preferred', 'only user scope may apply globally')
    }
  },
  'project descendant applies': (f) => {
    const fallback = fakePlugin(f.root, 'fallback'), subdir = path.join(f.project, 'subdir')
    fs.mkdirSync(subdir); delete f.env.CLAUDE_PROJECT_DIR
    for (const scope of ['project', 'local']) {
      f.registry([{ scope: 'user', installPath: fallback }, { scope, projectPath: f.project, installPath: f.plugin }])
      assert.equal(f.node([f.shim], { cwd: subdir }).stdout, 'preferred', 'project scope must apply from a descendant cwd')
    }
  },
  'same rank keeps registry order': (f) => {
    const second = fakePlugin(f.root, 'second')
    f.registry([{ scope: 'local', projectPath: f.project, installPath: f.plugin }, { scope: 'project', projectPath: f.project, installPath: second }])
    assert.equal(f.run().stdout, 'preferred', 'equal scope ranks must keep registry order')
  },
  'relative override refuses': (f) => {
    f.env.WT_PLUGIN_ROOT = path.relative(f.project, f.plugin)
    refused(f, f.env.WT_PLUGIN_ROOT)
    assert.match(f.run().stdout, /absolute/, 'relative root refusal must explain the absolute path requirement')
  },
  'relative loaded root refuses': (f) => {
    f.registry([]); f.env.CLAUDE_PLUGIN_ROOT = path.relative(f.project, f.plugin)
    refused(f, f.env.CLAUDE_PLUGIN_ROOT)
  },
  'relative registry install refuses': (f) => {
    const relative = path.relative(f.project, f.plugin)
    f.registry([{ scope: 'user', installPath: relative }, { scope: 'user', installPath: f.plugin }])
    refused(f, relative)
  },
  'relative project path ignored': (f) => {
    const wrong = fakePlugin(f.root, 'wrong')
    f.registry([{ scope: 'project', projectPath: '.', installPath: wrong }, { scope: 'user', installPath: f.plugin }])
    assert.equal(f.run().stdout, 'preferred', 'relative projectPath must not make an entry applicable')
  },
  'execArgv execve propagation': (f) => {
    fs.writeFileSync(f.target, 'process.stdout.write(JSON.stringify(process.execArgv))')
    assert.deepEqual(JSON.parse(f.node(['--conditions=shim-lock', f.shim]).stdout), ['--conditions=shim-lock'], 'execve must preserve interpreter options')
  },
  'execArgv spawn propagation': (f) => {
    const preload = path.join(f.root, 'no-execve.mjs')
    fs.writeFileSync(preload, 'process.execve = undefined')
    fs.writeFileSync(f.target, 'process.stdout.write(JSON.stringify(process.execArgv))')
    const args = ['--conditions=shim-lock', '--import', preload]
    assert.deepEqual(JSON.parse(f.node([...args, f.shim]).stdout), args, 'spawn must preserve interpreter options')
  },
  'non executable interpreter preflight': (f) => {
    // Leave execve enabled: this regular but non-executable interpreter copy would abort Node.
    const executable = path.join(f.root, 'node-copy'), preload = path.join(f.root, 'node-path.mjs')
    fs.copyFileSync(process.execPath, executable); fs.chmodSync(executable, 0o644)
    fs.writeFileSync(preload, `process.execPath = ${JSON.stringify(executable)}`)
    const result = f.node(['--import', preload, f.shim])
    assert.equal(result.status, 2, 'non-executable Node must refuse before real execve')
    assert.equal(result.signal, null)
    assert.match(result.stdout, /Node executable/)
    assert.equal(result.stderr, result.stdout)
  },
  'stale hook suppresses scripts': (f) => {
    const loaded = fakePlugin(f.root, 'old-loaded')
    fs.writeFileSync(path.join(loaded, '.claude-plugin/plugin.json'), '{"name":"workflow-toolbox","version":"0.0.1"}')
    fs.writeFileSync(path.join(f.config, 'settings.json'), '{"enabledPlugins":{"workflow-toolbox@fixture":true}}')
    f.env.CLAUDE_PLUGIN_ROOT = loaded; f.env.CLAUDE_PLUGIN_DATA = path.join(f.root, 'workflow-toolbox-fixture')
    const lines = fs.readFileSync(f.shim, 'utf8').split('\n')
    const body = lines[0] + '\n' + lines.slice(3).join('\n') + '// newer template\n'
    const fp = createHash('sha256').update(body).digest('hex').slice(0, 12)
    fs.writeFileSync(f.shim, body.replace('\n', `\n// installed from workflow-toolbox v99.0.0 · content sha256:${fp} by the adopt skill -- editable copy.\n\n`))
    const result = f.hook()
    assert.ok(!result.stdout.includes('--set scripts'), 'stale loaded hook must not recommend restoring its older template')
    assert.match(result.stdout, /Comparison skipped for .*wt-lane\.mjs/, 'stale script comparisons must be named as skipped')
  },
  'hook child failure notice': (f, source) => {
    const copy = copyHook(f, source)
    // Missing installer: spawn succeeds, but the child cannot run its program.
    const result = f.hook(copy)
    assert.match(result.stdout, /scripts drift check could not run/, 'a failed scripts check must be reported once')
    assert.equal(result.stdout.split('scripts drift check could not run').length, 2)
  },
  'hook no status notice': (f, source) => {
    const copy = copyHook(f, source)
    fs.mkdirSync(path.join(copy, 'skills/adopt/scripts'), { recursive: true })
    fs.writeFileSync(path.join(copy, 'skills/adopt/scripts/install.mjs'), 'process.exit(0)')
    assert.match(f.hook(copy).stdout, /scripts drift check could not run/, 'a statusless scripts check must be reported')
    fs.rmSync(f.scripts, { recursive: true })
    assert.equal(f.hook(copy).stdout, '', 'no adopted script means no check-failure notice')
  },
  'closed diagnostic descriptors': (f) => {
    f.registry([])
    for (const fd of [1, 2]) {
      const preload = path.join(f.root, `closed-${fd}.mjs`)
      fs.writeFileSync(preload, `import fs from 'node:fs'; fs.closeSync(${fd})`)
      const result = f.node(['--import', preload, f.shim])
      assert.equal(result.status, 2, 'a failed diagnostic fd must not prevent controlled exit 2')
      assert.match(fd === 1 ? result.stderr : result.stdout, /installed workflow-toolbox plugin not found/, 'the other diagnostic fd must still be written')
    }
  },
  'help only first argument': (f) => {
    f.registry([])
    assert.equal(f.run('--output', '--help').status, 2, 'a help flag used as an option value must not turn refusal into success')
    assert.equal(f.run('--help').status, 0)
    assert.equal(f.run('-h').status, 0)
  },
}

export function runFixLock(name, source = process.env.WT_SHIM_TEST_PLUGIN || SOURCE) {
  const f = fixture(source)
  try { fixLocks[name](f, source) }
  finally { fs.rmSync(f.root, { recursive: true, force: true }) }
}
