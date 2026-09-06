// Resolve one config-scoped state root for every plugin and shell caller.
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join, win32 } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..', '..')

export function pluginName() {
  return JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).name
}

function pathBasename(value) {
  return basename(value) === value ? win32.basename(value) : basename(value)
}

function startsWithPluginName(value, name, platform) {
  const comparable = platform === 'win32' ? value.toLowerCase() : value
  const prefix = platform === 'win32' ? `${name}-`.toLowerCase() : `${name}-`
  return comparable.startsWith(prefix)
}

function readInstalledPlugins(configDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'))
    return parsed && typeof parsed.plugins === 'object' ? parsed.plugins : parsed
  } catch {
    return null
  }
}

function installedEntry(configDir, name) {
  const installed = readInstalledPlugins(configDir)
  if (!installed || typeof installed !== 'object') return null
  const prefix = `${name}@`
  const key = Object.keys(installed).find((candidate) => candidate.startsWith(prefix))
  if (!key) return null
  const value = installed[key]
  const entry = Array.isArray(value) ? value[0] : value
  return { marketplace: key.slice(prefix.length), version: entry && typeof entry.version === 'string' ? entry.version : null }
}

function installedMarketplace(configDir, name) {
  return installedEntry(configDir, name)?.marketplace ?? null
}

function ownVersion() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

function versionAtLeast(candidate, floor) {
  if (!candidate || !floor) return false
  const a = candidate.split('.').map(Number)
  const b = floor.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

/** Carry-over is safe only once the INSTALLED plugin resolves canonical too. Measured 2026-09-06:
 *  a develop checkout carried the legacy dirs over while the installed 0.170.0 still read them —
 *  the installed actionability gate then reported its snapshot missing. So a checkout newer than
 *  the installed plugin reads canonical (if present) but never moves anything; the installed
 *  plugin, once updated, carries over on its first resolution. */
export function carryOverAllowed({ configDir, pluginName: name, minimumVersion = ownVersion() }) {
  const entry = installedEntry(configDir, name)
  return Boolean(entry && versionAtLeast(entry.version, minimumVersion))
}

function moveLegacyDir(legacyDir, dir, stderr) {
  // MERGE, not move-once: an OLDER installed plugin keeps writing the legacy dir until the owner
  // updates it, while a newer checkout already resolves canonical — measured 2026-09-06, the
  // split existed within an hour. So every canonical resolution carries over whatever the legacy
  // dir holds that the canonical one lacks (name-wise, never overwriting), file by file, and
  // removes the legacy dir only once it is empty. Idempotent and cheap when nothing is there.
  let entries
  try {
    if (!existsSync(legacyDir)) return
    entries = readdirSync(legacyDir)
  } catch {
    return
  }
  let moved = 0
  for (const name of entries) {
    const from = join(legacyDir, name)
    const to = join(dir, name)
    if (existsSync(to)) continue
    try {
      mkdirSync(dir, { recursive: true })
      try {
        renameSync(from, to)
      } catch (error) {
        if (error?.code !== 'EXDEV') continue
        cpSync(from, to, { recursive: true })
        rmSync(from, { recursive: true, force: true })
      }
      moved += 1
    } catch {
      // leave it in place; the next resolution retries
    }
  }
  try {
    if (readdirSync(legacyDir).length === 0) rmSync(legacyDir, { recursive: true, force: true })
  } catch {
    // a non-empty legacy dir stays: something there already exists canonically under the same name
  }
  if (moved > 0) stderr.write(`[workflow-toolbox] carried ${moved} legacy plugin state entr${moved === 1 ? 'y' : 'ies'} from ${legacyDir} to ${dir}\n`)
}

/**
 * The installed-plugin registry makes every caller share one canonical directory.
 * CLAUDE_PLUGIN_DATA is used only for an uninstalled --plugin-dir session; its value
 * never overrides an installed plugin's canonical directory.
 */
export function resolvePluginDataDir({ env = process.env, configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), pluginName: name = pluginName(), fallback, platform = process.platform, stderr = process.stderr, minimumVersion = ownVersion() }) {
  const legacyDir = fallback || join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), name)
  const candidate = env.CLAUDE_PLUGIN_DATA
  const marketplace = installedMarketplace(configDir, name)
  if (marketplace) {
    const dataDir = join(configDir, 'plugins', 'data', `${name}-${marketplace}`)
    const dir = join(dataDir, basename(legacyDir))
    const pluginData = typeof candidate !== 'string' || !candidate
      ? 'unset'
      : candidate === dataDir ? 'agrees' : 'disagrees'
    const carry = carryOverAllowed({ configDir, pluginName: name, minimumVersion })
    if (carry) moveLegacyDir(legacyDir, dir, stderr)
    else if (!existsSync(dir)) return { dir: legacyDir, source: 'fallback', reason: `installed ${name} is older than ${minimumVersion}; canonical dir not created yet`, pluginData }
    return { dir, source: 'installed_plugins', reason: `installed_plugins.json selects ${name}@${marketplace}${carry ? '' : ' (read-only until the installed plugin is updated)'}`, pluginData }
  }
  if (typeof candidate === 'string' && candidate && startsWithPluginName(pathBasename(candidate), name, platform)) {
    return { dir: candidate, source: 'env', reason: 'CLAUDE_PLUGIN_DATA names an uninstalled plugin session' }
  }
  return {
    dir: legacyDir,
    source: 'fallback',
    reason: typeof candidate === 'string' && candidate
      ? 'CLAUDE_PLUGIN_DATA does not name this uninstalled plugin'
      : 'CLAUDE_PLUGIN_DATA is unset and no installed plugin key exists',
  }
}
