import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const suite = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const root = mkdtempSync(path.join(tmpdir(), 'wt-clean-plugin-sdk-'))
const installed = path.join(root, 'plugin')
const project = path.join(root, 'project')
const config = path.join(root, 'config')
const pluginData = path.join(root, 'plugin data')
const isolatedGlobal = path.join(root, 'empty-global')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function runRunner(env) {
  return spawnSync(process.execPath, [
    path.join(installed, 'bin', 'wt-pilot-runner.mjs'),
    '--card', '1',
    '--dir', project,
    '--card-file', path.join(root, 'card.md'),
    '--contract', path.join(root, 'contract.md'),
    '--profile-env', path.join(root, 'bad-profile.json'),
  ], { encoding: 'utf8', env })
}

try {
  cpSync(path.join(suite, 'plugin'), installed, { recursive: true })
  mkdirSync(path.join(project, '.lane'), { recursive: true })
  mkdirSync(config)
  writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
  writeFileSync(path.join(root, 'card.md'), 'Route: LITE\nDoD: stop before query\n')
  writeFileSync(path.join(root, 'contract.md'), '# contract\n')
  writeFileSync(path.join(root, 'bad-profile.json'), '{bad')

  const baseEnv = { ...process.env, CLAUDE_CONFIG_DIR: config, NODE_PATH: '', NPM_CONFIG_PREFIX: isolatedGlobal }
  delete baseEnv.CLAUDE_PLUGIN_DATA
  const missing = runRunner(baseEnv)
  process.stdout.write(`NO_SDK_STATUS=${missing.status}\nNO_SDK_STDOUT=${missing.stdout.trim()}\nNO_SDK_STDERR=${missing.stderr.trim()}\n`)
  const expected = 'wt-pilot-runner: @anthropic-ai/claude-agent-sdk is not installed; run: npm install -g @anthropic-ai/claude-agent-sdk\n'
  if (missing.status !== 1 || missing.stdout !== '' || missing.stderr !== expected) throw new Error('clean plugin did not produce the exact global-install refusal')

  const install = spawnSync(npm, ['install', '--prefix', pluginData, '@anthropic-ai/claude-agent-sdk'], { encoding: 'utf8', env: baseEnv, shell: process.platform === 'win32' })
  process.stdout.write(`INSTALL_COMMAND=npm install --prefix ${pluginData} @anthropic-ai/claude-agent-sdk\nINSTALL_STATUS=${install.status}\n`)
  if (install.status !== 0) {
    process.stdout.write(`INSTALL_STDOUT=${install.stdout.trim()}\nINSTALL_STDERR=${install.stderr.trim()}\n`)
    throw new Error('SDK install failed')
  }

  const resolved = runRunner({ ...baseEnv, CLAUDE_PLUGIN_DATA: pluginData })
  process.stdout.write(`PLUGIN_DATA_STATUS=${resolved.status}\nPLUGIN_DATA_STDOUT=${resolved.stdout.trim()}\nPLUGIN_DATA_STDERR=${resolved.stderr.trim()}\n`)
  const passedResolution = resolved.status === 1 && resolved.stderr.includes('cannot read --profile-env') && !resolved.stderr.includes('claude-agent-sdk is not installed')
  process.stdout.write(`RESOLUTION_PASSED=${passedResolution}\n`)
  if (!passedResolution) throw new Error('runner did not pass SDK resolution from CLAUDE_PLUGIN_DATA')
} finally {
  rmSync(root, { recursive: true, force: true })
}
