import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SDK = '@anthropic-ai/claude-agent-sdk'
const OWN_TOOLKIT_MANIFEST = resolve(dirname(fileURLToPath(import.meta.url)), '../../../toolkit/package.json')
let cachedGlobalNpmRoot

function globalNpmRoot() {
  if (cachedGlobalNpmRoot !== undefined) return cachedGlobalNpmRoot
  try {
    const windows = process.platform === 'win32'
    cachedGlobalNpmRoot = execFileSync(windows ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', shell: windows, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    cachedGlobalNpmRoot = null
  }
  return cachedGlobalNpmRoot
}

export function resolveAgentSdkRequire(options = {}) {
  const {
    projectDir = process.cwd(),
    env = process.env,
    ownToolkitManifest = OWN_TOOLKIT_MANIFEST,
  } = options
  const candidates = []
  if (ownToolkitManifest && existsSync(ownToolkitManifest)) candidates.push(ownToolkitManifest)
  if (projectDir) candidates.push(join(resolve(projectDir), 'package.json'))
  if (env.CLAUDE_PLUGIN_DATA) candidates.push(join(resolve(env.CLAUDE_PLUGIN_DATA), 'package.json'))
  for (const base of candidates) {
    const require = createRequire(base)
    try {
      require.resolve(SDK)
      return require
    } catch {
      // A manifest alone is insufficient: the SDK must resolve from this install.
    }
  }
  const npmRoot = Object.hasOwn(options, 'npmRoot') ? options.npmRoot : globalNpmRoot()
  if (npmRoot) {
    const require = createRequire(join(dirname(resolve(npmRoot)), 'package.json'))
    try {
      require.resolve(SDK)
      return require
    } catch {
      // A broken or stale global npm root is not a startup error by itself.
    }
  }
  // The literal path on every platform: the variable is set for the plugin's own processes, not in the
  // terminal where the owner pastes the remedy.
  const install = env.CLAUDE_PLUGIN_DATA
    ? `npm install --prefix "${resolve(env.CLAUDE_PLUGIN_DATA)}" ${SDK}`
    : `npm install -g ${SDK}`
  throw new Error(`${SDK} is not installed; run: ${install}`)
}
