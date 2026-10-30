#!/usr/bin/env node
// Execute the skill's copyable launch blocks using only temporary profiles and a consent refusal.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isInvokedDirectly } from '../../plugin/bin/lib/host/entry-guard.mjs'
import { cleanupLaunch, launchDiagnostics, launchFailureDiagnostics, runShell, waitForLaunch } from './second-opinion-launch-lifecycle.mjs'

export { cleanupLaunch } from './second-opinion-launch-lifecycle.mjs'
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

function launchCommand(f, options, windows) {
  const text = readFileSync(options.skill ?? skillPath, 'utf8')
  const bootstrap = fence(text, 'javascript')
  if (bootstrap) {
    const recordPid = `import { writeFileSync as recordFixturePid } from 'node:fs'\nrecordFixturePid(${JSON.stringify(`${f.out}.child.pid`)}, String(process.pid))\n`
    writeFileSync(`${f.out}.launch.mjs`, recordPid + bootstrap)
  }
  const platform = options.platform ?? process.platform
  const language = windows ? 'powershell' : platform === 'darwin' ? 'sh' : 'bash'
  let command = fence(text, language)
  assert.ok(command, `skill must contain the ${language} launch block`)
  for (const [token, value] of [['<request-file>', f.request], ['<out-file>', f.out], ['<repository>', f.repo]]) {
    command = command.replaceAll(token, shellWord(value, windows))
  }
  command = command.replaceAll('<low|medium|high>', 'low').replaceAll('<auto|astra|opus>', 'astra')
  // Track even a cold node before its bootstrap has executed. The published POSIX blocks stay verbatim.
  return windows ? command : `${command}\nprintf '%s\\n' "$!" > ${shellWord(`${f.out}.launch.pid`, false)}`
}

function assertShellLaunch(f, result) {
  if (result.error !== null) assert.equal(result.error, null, `launch shell failed; ${launchFailureDiagnostics(f)}`)
  if (result.status !== 0) assert.equal(result.status, 0, `launch shell failed; ${launchFailureDiagnostics(f)}`)
}

export async function documentedLaunch(f, options = {}) {
  const windows = process.platform === 'win32'
  const command = launchCommand(f, options, windows)
  const shell = windows ? 'powershell.exe' : '/bin/bash'
  const args = windows ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command]
  const result = await runShell(f, shell, args, { env: { ...f.env, ...options.env }, command,
    shellTimeoutMs: options.shellTimeoutMs ?? (windows ? 60_000 : 10_000) })
  assertShellLaunch(f, result)
  await waitForLaunch(f, options.completionTimeoutMs ?? (windows ? 120_000 : 10_000))
  return { out: existsSync(f.out) ? readFileSync(f.out, 'utf8') : null,
    log: existsSync(`${f.out}.launch.log`) ? readFileSync(`${f.out}.launch.log`, 'utf8') : null,
    diagnostics: launchDiagnostics(f) }
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

export async function runLaunchE2e() {
  const missing = launchFixture()
  const real = launchFixture()
  try {
    const failed = await documentedLaunch(missing)
    assert.equal(failed.out, null, `missing CLI must not create --out; ${failed.diagnostics}`)
    assert.ok(failed.log, `documented launch must preserve startup diagnostics beside --out; ${failed.diagnostics}`)
    assert.match(failed.log, /MODULE_NOT_FOUND|Cannot find module/)
    console.log(`missing CLI: --out absent; launch log: ${failed.log.split(/\r?\n/).find((line) => /Error.*(module|MODULE_NOT_FOUND)/.test(line))?.replaceAll(missing.root, '<temporary>')}`)
    const loaded = updatedInstallation(real)
    const refused = await documentedLaunch(real, { skill: loaded, env: { WT_PLUGIN_ROOT: undefined } })
    assert.match(refused.out ?? '', /^REFUSED: Astra requires active GPT lane consent\.\nEXIT=1\n$/, refused.diagnostics)
    console.log('updated registry: loaded skill survived removal of its old plugin root')
    console.log(`real CLI first line: ${refused.out.split(/\r?\n/)[0]}`)
    console.log(`real CLI last line: ${refused.out.trimEnd().split(/\r?\n/).at(-1)}`)
    console.log('E2E OK: startup failure captured; real CLI refused before any model call')
  } finally {
    for (const f of [missing, real]) {
      await cleanupLaunch(f)
      rmSync(f.root, { recursive: true, force: true })
    }
  }
}

if (isInvokedDirectly(import.meta.url)) await runLaunchE2e()
