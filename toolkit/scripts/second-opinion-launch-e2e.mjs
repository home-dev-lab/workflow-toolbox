#!/usr/bin/env node
// Execute the skill's copyable launch blocks using only temporary profiles and a consent refusal.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../plugin')
export const skillPath = process.env.WT_SECOND_OPINION_LAUNCH_SKILL ?? join(pluginRoot, 'skills/second-opinion/SKILL.md')

export function launchFixture() {
  const root = mkdtempSync(join(tmpdir(), 'wt-opinion launch-'))
  const config = join(root, 'config')
  const repo = join(root, 'repo')
  const plugin = join(root, 'missing-plugin')
  const home = join(root, 'home')
  for (const dir of [config, repo, home, join(plugin, '.claude-plugin')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'workflow-toolbox', version: '0.0.0' }))
  writeFileSync(join(config, 'settings.json'), JSON.stringify({
    pluginConfigs: { 'workflow-toolbox@test': { options: { executor_lane_consent: false } } },
  }))
  const request = join(root, 'request.md')
  writeFileSync(request, 'A model must never be called for this consent-refusal check.')
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
    CLAUDE_CONFIG_DIR: config, WT_PLUGIN_ROOT: plugin, CLAUDE_PLUGIN_ROOT: plugin }
  return { root, config, repo, plugin, request, out: join(root, 'answer.log'), env }
}

function fence(text, language) {
  return text.match(new RegExp('```' + language + '\\r?\\n([\\s\\S]*?)```'))?.[1]
}

function shellWord(value, windows) {
  return windows ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`
}

function completed(out) {
  if (existsSync(out) && /\nEXIT=\d+\r?\n?$/.test(readFileSync(out, 'utf8'))) return true
  const log = `${out}.launch.log`
  return existsSync(log) && /Error|not found|No such file|REFUSED:/.test(readFileSync(log, 'utf8'))
}

function waitForLaunch(out) {
  const deadline = Date.now() + 5_000
  while (!completed(out) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
}

function launchCommand(f, options, windows) {
  const text = readFileSync(options.skill ?? skillPath, 'utf8')
  const bootstrap = fence(text, 'javascript')
  if (bootstrap) writeFileSync(`${f.out}.launch.mjs`, bootstrap)
  const platform = options.platform ?? process.platform
  const language = windows ? 'powershell' : platform === 'darwin' ? 'sh' : 'bash'
  let command = fence(text, language)
  assert.ok(command, `skill must contain the ${language} launch block`)
  for (const [token, value] of [['<request-file>', f.request], ['<out-file>', f.out], ['<repository>', f.repo]]) {
    command = command.replaceAll(token, shellWord(value, windows))
  }
  return command.replaceAll('<low|medium|high>', 'low').replaceAll('<auto|astra|opus>', 'astra')
}

export function documentedLaunch(f, options = {}) {
  const windows = process.platform === 'win32'
  const command = launchCommand(f, options, windows)
  const shell = windows ? 'powershell.exe' : '/bin/bash'
  const args = windows ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command]
  const result = spawnSync(shell, args, { cwd: f.repo, env: { ...f.env, ...options.env }, encoding: 'utf8', timeout: 10_000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  waitForLaunch(f.out)
  return { out: existsSync(f.out) ? readFileSync(f.out, 'utf8') : null,
    log: existsSync(`${f.out}.launch.log`) ? readFileSync(`${f.out}.launch.log`, 'utf8') : null }
}

function updatedInstallation(f) {
  const loaded = join(f.root, 'loaded-skill.md')
  writeFileSync(loaded, readFileSync(skillPath, 'utf8'))
  mkdirSync(join(f.config, 'plugins'))
  const registry = join(f.config, 'plugins/installed_plugins.json')
  const entry = (installPath) => JSON.stringify({ plugins: { 'workflow-toolbox@test': [{ scope: 'user', installPath }] } })
  writeFileSync(registry, entry(f.plugin))
  rmSync(f.plugin, { recursive: true })
  writeFileSync(registry, entry(pluginRoot))
  return loaded
}

export function runLaunchE2e() {
  const missing = launchFixture()
  const real = launchFixture()
  try {
    const failed = documentedLaunch(missing)
    assert.equal(failed.out, null, 'missing CLI must not create --out')
    assert.ok(failed.log, 'documented launch must preserve startup diagnostics beside --out')
    assert.match(failed.log, /MODULE_NOT_FOUND|Cannot find module/)
    console.log(`missing CLI: --out absent; launch log: ${failed.log.split(/\r?\n/).find((line) => /Error.*(module|MODULE_NOT_FOUND)/.test(line))?.replaceAll(missing.root, '<temporary>')}`)
    const loaded = updatedInstallation(real)
    const refused = documentedLaunch(real, { skill: loaded, env: { WT_PLUGIN_ROOT: undefined } })
    assert.match(refused.out ?? '', /^REFUSED: Astra requires active GPT lane consent\.\nEXIT=1\n$/)
    console.log('updated registry: loaded skill survived removal of its old plugin root')
    console.log(`real CLI first line: ${refused.out.split(/\r?\n/)[0]}`)
    console.log(`real CLI last line: ${refused.out.trimEnd().split(/\r?\n/).at(-1)}`)
    console.log('E2E OK: startup failure captured; real CLI refused before any model call')
  } finally {
    for (const f of [missing, real]) rmSync(f.root, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runLaunchE2e()
