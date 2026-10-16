import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'

// File-based managed policy locations; MDM, registry and server policy are not exposed here.
function managedSettingsFile(platform = process.platform, env = process.env) {
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
  return { enabled, floor: floor.value, interactive, fetching: featureFetching(layers, env) }
}

function enabledValue(idle, disable, floor) {
  if (['1', 'true'].includes(disable.value) || idle.value === false) return false
  if (!idle.known || !disable.known || !floor.known) return null
  if (idle.value !== undefined && typeof idle.value !== 'boolean') return null
  return true
}

const BOOLEAN_FETCH_SWITCHES = ['DISABLE_GROWTHBOOK', 'DO_NOT_TRACK']
const NONEMPTY_FETCH_SWITCHES = ['DISABLE_TELEMETRY', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']
const PROVIDER_SWITCHES = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_MANTLE']

function switchValue(reading, nonempty = false) {
  // Boolean spellings are case-insensitive; set-or-unset flags keep their own rule.
  if (!reading.known) return null
  const value = reading.value
  if (value === undefined || value === '') return false
  if (typeof value !== 'string') return null
  if (nonempty) return value.length > 0
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false
  return null
}

function featureFetching(layers, env) {
  const read = (key, nonempty = false) => switchValue(envValue(layers, env, key), nonempty)
  const blockers = [...BOOLEAN_FETCH_SWITCHES.map((key) => read(key)),
    ...NONEMPTY_FETCH_SWITCHES.map((key) => read(key, true))]
  const managed = read('CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', true)
  if (managed !== true) blockers.push(...PROVIDER_SWITCHES.map((key) => read(key)))
  if (blockers.includes(true)) return false
  return managed === null || blockers.includes(null) ? null : true
}
