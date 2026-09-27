// Host filesystem lookup of agent definitions; an unresolved type is unknown, never unpinned.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const BUILTIN_TYPES = new Set(['general-purpose', 'Explore', 'Plan'])

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

function installedPluginRoots(plugin) {
  try {
    const registry = JSON.parse(readFileSync(join(configDir(), 'plugins', 'installed_plugins.json'), 'utf8'))
    const entries = registry?.plugins ?? registry
    if (!entries || typeof entries !== 'object') return []
    return Object.entries(entries)
      .filter(([key]) => key.startsWith(`${plugin}@`))
      .flatMap(([, value]) => Array.isArray(value) ? value : [value])
      .map((entry) => entry?.installPath)
      .filter((root) => typeof root === 'string' && root.length > 0)
  } catch {
    return []
  }
}

function definitionFiles(type, cwd) {
  const parts = type.split(':')
  if (parts.length === 1) {
    const files = []
    if (cwd) {
      let current = resolve(cwd)
      for (;;) {
        files.push(join(current, '.claude', 'agents', `${type}.md`))
        const parent = dirname(current)
        if (parent === current) break
        current = parent
      }
    }
    return [...files, join(configDir(), 'agents', `${type}.md`)]
  }
  if (parts.length !== 2) return []
  const [plugin, name] = parts
  const roots = installedPluginRoots(plugin)
  if (plugin === 'workflow-toolbox') {
    if (process.env.CLAUDE_PLUGIN_ROOT) roots.unshift(process.env.CLAUDE_PLUGIN_ROOT)
    roots.push(PLUGIN_ROOT)
  }
  return roots.map((root) => join(root, 'agents', `${name}.md`))
}

function declaredModel(source) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1]
  if (frontmatter === undefined) return null
  const value = /^model:([^\r\n]*)$/m.exec(frontmatter)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2')
  return value && value.toLowerCase() !== 'inherit' && value.toLowerCase() !== 'null' ? value : null
}

/** Unknown definitions stay unknown; absence of a model in a known definition is unpinned. */
export function resolveAgentModelPin(type, cwd, requestedModel) {
  if (type === 'fork') return 'exempt'
  if (typeof type !== 'string' || !/^[\w-]+(?::[\w-]+)?$/.test(type)) return 'unknown'
  const explicitPin = typeof requestedModel === 'string' && requestedModel.trim().length > 0 && requestedModel.trim().toLowerCase() !== 'inherit'
  if (BUILTIN_TYPES.has(type)) return explicitPin ? 'pinned' : 'unpinned'

  for (const file of definitionFiles(type, cwd)) {
    try {
      const source = readFileSync(file, 'utf8')
      if (!/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(source)) return 'unknown'
      if (requestedModel !== undefined) return explicitPin ? 'pinned' : 'unpinned'
      return declaredModel(source) ? 'pinned' : 'unpinned'
    } catch {
      // Missing or unreadable definitions cannot justify a warning.
    }
  }
  return 'unknown'
}
