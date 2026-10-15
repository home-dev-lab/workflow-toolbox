import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'

// File-based managed policy locations; MDM, registry and server policy are not exposed here.
export function managedSettingsFile(platform = process.platform, env = process.env) {
  if (platform === 'linux') return '/etc/claude-code/managed-settings.json'
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json'
  if (platform === 'win32') return path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json')
  return null
}

async function readSettings(file) {
  if (!file) return null
  try {
    const value = JSON.parse(await readFile(file, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch (error) {
    return error.code === 'ENOENT' ? absentSettings(file) : null
  }
}

async function absentSettings(file) {
  try { await lstat(file); return null } catch (error) {
    return error.code === 'ENOENT' ? {} : null
  }
}

function resolveKey(layers, key, nested = false) {
  for (const layer of layers) {
    if (layer === null) return { known: false }
    const source = nested ? layer.env : layer
    if (source && Object.hasOwn(source, key)) return { known: true, value: source[key] }
  }
  return { known: true, value: undefined }
}

function envValue(layers, env, key) {
  return env[key] !== undefined ? { known: true, value: env[key] } : resolveKey(layers, key, true)
}

export async function compactionSettings(configDir, projectDir, options = {}) {
  const env = options.env ?? process.env
  const managed = options.managedFile ?? managedSettingsFile(options.platform, env)
  const files = [managed, path.join(projectDir, '.claude', 'settings.local.json'),
    path.join(projectDir, '.claude', 'settings.json'), path.join(configDir, 'settings.json')]
  const layers = []
  for (const file of files) layers.push(await readSettings(file))
  const idle = resolveKey(layers, 'idleCompaction')
  const disable = envValue(layers, env, 'DISABLE_AUTO_COMPACT')
  const floor = envValue(layers, env, 'CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS')
  const enabled = enabledValue(idle, disable, floor)
  // The SDK documents these as headless entrypoints; monitor stdout alone is always piped.
  const interactive = ['sdk-cli', 'sdk-ts', 'sdk-py'].includes(env.CLAUDE_CODE_ENTRYPOINT) ? false : null
  return { enabled, floor: floor.value, interactive }
}

function enabledValue(idle, disable, floor) {
  if (['1', 'true'].includes(disable.value) || idle.value === false) return false
  if (!idle.known || !disable.known || !floor.known) return null
  if (idle.value !== undefined && typeof idle.value !== 'boolean') return null
  return true
}
