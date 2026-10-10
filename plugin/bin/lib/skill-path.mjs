// Skill counterpart to agent-definitions.mjs / plugin-root-state.mjs: use the
// harness's installed_plugins.json installPath and scope, not cached version guesses.
// Default plugin layout: <plugin>:<name> => skills/<name>/SKILL.md.
// Ambiguous or unreadable sources resolve to null at the hook's fail-open boundary.
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homeDirectory } from './host/home-directory.mjs'

function optionalJson(file) {
  try { return statSync(file).isFile() ? JSON.parse(readFileSync(file, 'utf8')) : null }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error }
}
function skillFile(root, name) {
  const file = join(root, 'skills', name, 'SKILL.md')
  try {
    if (!statSync(file).isFile()) return null
    const real = realpathSync(file)
    const child = relative(realpathSync(join(root, 'skills')), real)
    return child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child) ? real : null
  }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error }
}
function sameDirectory(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  try { return realpathSync(a) === realpathSync(b) } catch { return false }
}

function personalSkill(skill, cwd, project, config) {
  // Check each ancestor, including the explicit project boundary, before stopping.
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

function installedSkill(namespace, name, config, project) {
  const registry = optionalJson(join(config, 'plugins', 'installed_plugins.json'))
  const plugins = registry?.plugins ?? registry ?? {}
  const settings = enabledPlugins(config, project)
  const candidates = []
  for (const [key, entries] of Object.entries(plugins)) {
    if (!key.startsWith(`${namespace}@`) || settings[key] === false) continue
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      const file = scopedSkillFile(entry, namespace, name, project)
      if (file) candidates.push({ file, rank: scopeRank(entry.scope) })
    }
  }
  return bestCandidate(candidates)
}

function bestCandidate(candidates) {
  candidates.sort((a, b) => a.rank - b.rank)
  const best = candidates.filter(item => item.rank === candidates[0]?.rank)
  const unique = [...new Set(best.map(item => item.file))]
  return unique.length === 1 ? unique[0] : null
}

function enabledPlugins(config, project) {
  const settings = Object.assign({}, optionalJson(join(config, 'settings.json'))?.enabledPlugins,
    ...(project ? [optionalJson(join(project, '.claude/settings.json'))?.enabledPlugins,
      optionalJson(join(project, '.claude/settings.local.json'))?.enabledPlugins] : []))
  return settings
}

function scopedSkillFile(entry, namespace, name, project) {
  if (typeof entry?.installPath !== 'string') return null
  if (['project', 'local'].includes(entry.scope) && !sameDirectory(entry.projectPath, project)) return null
  return installedSkillFile(entry.installPath, namespace, name)
}

function installedSkillFile(root, namespace, name) {
  const manifest = optionalJson(join(root, '.claude-plugin', 'plugin.json'))
  if (manifest && manifest.name !== namespace) return null
  return skillFile(root, name)
}

function scopeRank(scope) {
  return scope === 'local' ? 0 : scope === 'project' ? 1 : 2
}

function validPart(part) {
  return part && part !== '.' && part !== '..' && !/[/\\\0]/.test(part)
}

function loadedPluginRoot(namespace, root) {
  if (!root) return null
  const manifest = optionalJson(join(root, '.claude-plugin', 'plugin.json'))
  return manifest?.name === namespace ? root : null
}

export function resolveSkillPath(skill, { cwd, env = process.env } = {}) {
  if (typeof skill !== 'string') return null
  const parts = skill.split(':')
  if (parts.length > 2 || !parts.every(validPart)) return null
  const config = env.CLAUDE_CONFIG_DIR || join(homeDirectory(), '.claude')
  if (parts.length === 1) return personalSkill(skill, cwd, env.CLAUDE_PROJECT_DIR, config)
  const [namespace, name] = parts
  // Only this hook's own loaded plugin directory is exposed by the harness.
  const loaded = loadedPluginRoot(namespace, env.CLAUDE_PLUGIN_ROOT)
  if (loaded) return skillFile(loaded, name)
  return installedSkill(namespace, name, config, env.CLAUDE_PROJECT_DIR || cwd)
}
