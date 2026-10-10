// Skill counterpart to agent-definitions.mjs / plugin-root-state.mjs: use the
// harness's installed_plugins.json installPath and scope, not cached version guesses.
// Default plugin layout: <plugin>:<name> => skills/<name>/SKILL.md.
// Ambiguous or unreadable sources resolve to null at the hook's fail-open boundary.
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homeDirectory } from './host/home-directory.mjs'

function optionalJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
function skillFile(root, name) {
  const file = join(root, 'skills', name, 'SKILL.md')
  try { return statSync(file).isFile() ? file : null }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error }
}
function sameDirectory(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  try { return realpathSync(a) === realpathSync(b) } catch { return false }
}

export function resolveSkillPath(skill, { cwd, env = process.env } = {}) {
  if (typeof skill !== 'string') return null
  const parts = skill.split(':')
  if (parts.length > 2 || parts.some(part => !part || part === '.' || part === '..' || /[/\\\0]/.test(part))) return null
  const config = env.CLAUDE_CONFIG_DIR || join(homeDirectory(), '.claude')
  const project = env.CLAUDE_PROJECT_DIR || cwd
  if (parts.length === 1) {
    // Project skills override personal skills; discover ancestor skills for nested cwd.
    for (let dir = resolve(cwd || project || process.cwd());; dir = dirname(dir)) {
      const file = skillFile(join(dir, '.claude'), skill)
      if (file) return file
      if (dirname(dir) === dir || sameDirectory(dir, project)) break
    }
    if (project) {
      const file = skillFile(join(project, '.claude'), skill)
      if (file) return file
    }
    return skillFile(config, skill)
  }
  const [namespace, name] = parts
  // A --plugin-dir / loaded plugin wins over an older installed copy of itself.
  if (env.CLAUDE_PLUGIN_ROOT) {
    const manifest = optionalJson(join(env.CLAUDE_PLUGIN_ROOT, '.claude-plugin', 'plugin.json'))
    if (manifest?.name === namespace) return skillFile(env.CLAUDE_PLUGIN_ROOT, name)
  }
  const registry = optionalJson(join(config, 'plugins', 'installed_plugins.json'))
  const plugins = registry?.plugins ?? registry ?? {}
  const settings = Object.assign({}, optionalJson(join(config, 'settings.json'))?.enabledPlugins,
    ...(project ? [optionalJson(join(project, '.claude/settings.json'))?.enabledPlugins,
      optionalJson(join(project, '.claude/settings.local.json'))?.enabledPlugins] : []))
  const candidates = []
  for (const [key, entries] of Object.entries(plugins)) {
    if (!key.startsWith(`${namespace}@`) || settings[key] === false) continue
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      if (typeof entry?.installPath !== 'string') continue
      if (['project', 'local'].includes(entry.scope) && !sameDirectory(entry.projectPath, project)) continue
      const file = skillFile(entry.installPath, name)
      if (file) candidates.push({ file, rank: entry.scope === 'local' ? 0 : entry.scope === 'project' ? 1 : 2 })
    }
  }
  candidates.sort((a, b) => a.rank - b.rank)
  const best = candidates.filter(item => item.rank === candidates[0]?.rank)
  const unique = [...new Set(best.map(item => item.file))]
  return unique.length === 1 ? unique[0] : null
}
