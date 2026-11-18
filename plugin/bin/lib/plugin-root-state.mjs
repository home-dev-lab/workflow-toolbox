// Read-only classification of the loaded plugin root versus an enabled installed copy.
// A plugin-dir replacement is a single loaded plugin. Only a separate settings hook
// registration can run in addition to an installed manifest registration.
// Without CLAUDE_PLUGIN_DATA's loaded id, a stale session and a session-only
// replacement are indistinguishable; a missing id makes no root claim.
// A hook invoked by the harness (its payload names the event) without CLAUDE_PLUGIN_ROOT
// is a settings registration by construction, whichever source declared it: a settings
// file, managed settings or a --settings argument this process cannot read. That
// invocation counts as registered evidence for its own script; other settings hooks are
// listed only when a readable settings file declares them. A manual run without a
// payload event makes no claim.
import { readFileSync, realpathSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { declaredHookPaths } from './hook-manifest.mjs'
import { homeDirectory } from './host/home-directory.mjs'
import { settingsHookScripts } from './settings-hook-command.mjs'

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

function canonical(file) {
  try { return realpathSync(file) } catch { return null }
}

// Settings files in precedence order: later wins per key. These are the documented
// sources for enabledPlugins and for hooks; <configDir>/settings.local.json is not one.
function settingsSources(configDir, projectDir) {
  return [join(configDir, 'settings.json'),
    ...(projectDir ? [join(projectDir, '.claude', 'settings.json'), join(projectDir, '.claude', 'settings.local.json')] : [])]
}

function enabledPlugins(configDir, projectDir) {
  const merged = {}
  for (const source of settingsSources(configDir, projectDir)) {
    const enabled = readJson(source)?.enabledPlugins
    if (enabled && typeof enabled === 'object' && !Array.isArray(enabled)) Object.assign(merged, enabled)
  }
  return merged
}

// A project- or local-scope entry belongs to the project it names, never to another one.
function appliesHere(entry, projectDir) {
  if (entry?.scope !== 'project' && entry?.scope !== 'local') return true
  const entryProject = typeof entry.projectPath === 'string' && canonical(entry.projectPath)
  const here = typeof projectDir === 'string' && canonical(projectDir)
  return Boolean(entryProject) && entryProject === here
}

function installedCopies(configDir, projectDir, name) {
  const registry = readJson(join(configDir, 'plugins', 'installed_plugins.json'))
  const plugins = registry?.plugins ?? registry
  const enabled = enabledPlugins(configDir, projectDir)
  if (!plugins || typeof plugins !== 'object') return []
  return Object.entries(plugins).flatMap(([key, entries]) => {
    if (!key.startsWith(`${name}@`) || enabled[key] !== true) return []
    return (Array.isArray(entries) ? entries : [entries]).flatMap((entry) => {
      if (typeof entry?.installPath !== 'string' || !appliesHere(entry, projectDir)) return []
      const root = canonical(entry.installPath)
      const manifest = root && readJson(join(root, '.claude-plugin', 'plugin.json'))
      return manifest?.name === name ? [{ key, root, version: manifest.version ?? entry.version,
        manifestPath: join(root, '.claude-plugin', 'plugin.json') }] : []
    })
  })
}

function registeredScript(ownRoot, script, event) {
  const resolved = canonical(script)
  if (!resolved) return []
  const rel = relative(ownRoot, resolved)
  return rel && rel !== '..' && !rel.startsWith(`..${sep}`) ? [{ event, rel: `/${rel.split(sep).join('/')}` }] : []
}

function groupHooks(group, ownRoot, event) {
  return (Array.isArray(group?.hooks) ? group.hooks : []).flatMap((entry) => {
    if (entry?.type !== 'command' || typeof entry.command !== 'string') return []
    return settingsHookScripts(entry.command).flatMap((script) => registeredScript(ownRoot, script, event))
  })
}

function settingsHooks(configDir, projectDir, ownRoot, event) {
  return settingsSources(configDir, projectDir).flatMap((source) => {
    const groups = readJson(source)?.hooks?.[event]
    return (Array.isArray(groups) ? groups : []).flatMap((group) => groupHooks(group, ownRoot, event))
  })
}

function sharedHooks(ownManifestPath, installedManifestPath, registered) {
  const own = new Set(declaredHookPaths(ownManifestPath).map(({ event, rel }) => `${event}:${rel}`))
  const installed = new Set(declaredHookPaths(installedManifestPath).map(({ event, rel }) => `${event}:${rel}`))
  return [...new Set(registered.filter(({ event, rel }) => own.has(`${event}:${rel}`) && installed.has(`${event}:${rel}`))
    .map(({ event, rel }) => `${event}: ${rel.slice(1)}`))]
}

function loadedRootState(copies, manifest, runningRoot, env) {
  const loadedId = env.CLAUDE_PLUGIN_DATA && basename(env.CLAUDE_PLUGIN_DATA)
  if (!loadedId) return { kind: 'none' }
  if (loadedId === `${manifest.name}@inline`.replace(/[^A-Za-z0-9_-]/g, '-')) return { kind: 'session-only' }
  const loaded = copies.filter(({ key }) => loadedId === key.replace(/[^A-Za-z0-9_-]/g, '-'))
  // An applicable entry at the running root proves no drift, even beside other scopes.
  if (loaded.some(({ root }) => root === runningRoot)) return { kind: 'none' }
  const roots = new Map(loaded.map((copy) => [copy.root, copy]))
  const drifted = [...roots.values()].filter(({ version }) => typeof version === 'string' && version !== manifest.version)
  // Without a candidate at another version there is no drift to report, whichever copy loads.
  if (typeof manifest.version !== 'string' || !drifted.length) return { kind: 'none' }
  // The loaded id identifies a key, not a scope or an entry's precedence. Registry
  // order cannot establish which distinct root a reload would select.
  if (roots.size > 1) return { kind: 'ambiguous-installed', name: manifest.name, runningRoot }
  const installed = drifted[0]
  return { kind: 'stale', name: manifest.name, runningRoot, runningVersion: manifest.version,
    installedRoot: installed.root, installedVersion: installed.version }
}

function settingsRootState(copies, registered, runningRoot, ownManifestPath) {
  if (!registered.length) return { kind: 'none' }
  // The same root counts too: settings runs beside its manifest registration.
  for (const { key, root, manifestPath } of copies) {
    const duplicates = sharedHooks(ownManifestPath, manifestPath, registered)
    if (!duplicates.length) continue
    return { kind: 'settings-double', key, runningRoot, installedRoot: root, duplicates }
  }
  return { kind: 'none' }
}

function invokedHooks(runningRoot, event, invokedEvent, invokedScript) {
  return invokedEvent === event && typeof invokedScript === 'string'
    ? registeredScript(runningRoot, invokedScript, event) : []
}

/** A none result means the available read-only inputs cannot prove a root-state finding. */
function classifyRoot({ ownRoot, projectDir: payloadDir, event = 'SessionStart', invokedEvent, invokedScript, env = process.env }) {
  // Scope and project settings belong to the directory the session started in. The harness
  // keeps CLAUDE_PROJECT_DIR there, while a payload's cwd follows a later cd or worktree entry.
  const projectDir = env.CLAUDE_PROJECT_DIR || payloadDir
  const runningRoot = canonical(env.CLAUDE_PLUGIN_ROOT || ownRoot)
  if (!runningRoot) return { kind: 'none' }
  const ownManifestPath = join(runningRoot, '.claude-plugin', 'plugin.json')
  const manifest = readJson(ownManifestPath)
  if (typeof manifest?.name !== 'string') return { kind: 'none' }
  const configDir = env.CLAUDE_CONFIG_DIR || join(homeDirectory(), '.claude')
  const copies = installedCopies(configDir, projectDir, manifest.name)

  if (env.CLAUDE_PLUGIN_ROOT) return loadedRootState(copies, manifest, runningRoot, env)

  const registered = settingsHooks(configDir, projectDir, runningRoot, event)
  registered.push(...invokedHooks(runningRoot, event, invokedEvent, invokedScript))
  return settingsRootState(copies, registered, runningRoot, ownManifestPath)
}

export function pluginRootState(options) {
  try { return classifyRoot(options) } catch { return { kind: 'none' } }
}
