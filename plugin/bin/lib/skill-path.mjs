// Skill counterpart to agent-definitions.mjs / plugin-root-state.mjs: use the
// harness's installed_plugins.json installPath and scope, not cached version guesses.
// Plugin names come from frontmatter, falling back to the directory name.
// Ambiguous or unreadable sources resolve to null at the hook's fail-open boundary.
import { readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homeDirectory } from './host/home-directory.mjs'
import { containedPath, readBoundedText, withRegularFile, withSkillFile } from './skill-file.mjs'
import { parseFrontmatter } from './frontmatter.mjs'

const MAX_JSON_BYTES = 1024 * 1024
const MAX_FRONTMATTER_BYTES = 4096

function optionalJson(file) {
  return withRegularFile(file, (fd, stat) => stat.size > MAX_JSON_BYTES ? null : JSON.parse(readBoundedText(fd, stat.size)))
}
function skillFile(root, name) {
  const file = join(root, 'skills', name, 'SKILL.md')
  try {
    if (!statSync(file).isFile()) return null
    const skillsRoot = realpathSync(join(root, 'skills'))
    const real = containedPath(skillsRoot, file)
    return real ? { file: real, skillsRoot } : null
  }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error }
}
function sameDirectory(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  try { return realpathSync(a) === realpathSync(b) } catch { return false }
}

function personalSkill(skill, cwd, project, config) {
  const personal = skillFile(config, skill)
  if (personal) return personal
  if (project) {
    const root = skillFile(join(project, '.claude'), skill)
    if (root) return root
  }
  // Check each ancestor, including the explicit project boundary, before stopping.
  for (let dir = resolve(cwd || project || process.cwd());; dir = dirname(dir)) {
    const file = skillFile(join(dir, '.claude'), skill)
    if (file) return file
    if (dirname(dir) === dir || sameDirectory(dir, project)) break
  }
  return null
}

function declaredName(text) {
  const parsed = parseFrontmatter(text)
  if (!parsed.ok) return parsed.reason === 'absent' ? undefined : null
  if (!Object.hasOwn(parsed.data, 'name')) return undefined
  return typeof parsed.data.name === 'string' && parsed.data.name ? parsed.data.name : null
}

function pluginSkill(root, name, inspect) {
  let entries
  try { entries = readdirSync(join(root, 'skills'), { withFileTypes: true }) } catch { return null }
  const matches = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const source = skillFile(root, entry.name)
    if (!source) continue
    const found = withSkillFile(source, (fd, stat) => {
      const declared = declaredName(readBoundedText(fd, Math.min(stat.size, MAX_FRONTMATTER_BYTES)))
      if ((declared === undefined ? entry.name : declared) !== name) return null
      // Measure the selected body on the same containment-checked descriptor.
      return inspect ? { ...source, measurement: inspect(fd, stat) } : source
    })
    if (found) matches.push(found)
  }
  return matches.length === 1 ? matches[0] : null
}

function installedSkill(namespace, name, config, project, inspect) {
  const registry = optionalJson(join(config, 'plugins', 'installed_plugins.json'))
  const plugins = registry?.plugins ?? registry ?? {}
  const settings = enabledPlugins(config, project)
  const candidates = []
  for (const [key, entries] of Object.entries(plugins)) {
    if (!key.startsWith(`${namespace}@`) || settings[key] === false) continue
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      const file = scopedSkillFile(entry, namespace, name, project, inspect)
      if (file) candidates.push({ file, rank: scopeRank(entry.scope) })
    }
  }
  return bestCandidate(candidates)
}

function bestCandidate(candidates) {
  candidates.sort((a, b) => a.rank - b.rank)
  const best = candidates.filter(item => item.rank === candidates[0]?.rank)
  const unique = new Map(best.map(item => [item.file.file, item.file]))
  return unique.size === 1 ? unique.values().next().value : null
}

function enabledPlugins(config, project) {
  const settings = Object.assign({}, optionalJson(join(config, 'settings.json'))?.enabledPlugins,
    ...(project ? [optionalJson(join(project, '.claude/settings.json'))?.enabledPlugins,
      optionalJson(join(project, '.claude/settings.local.json'))?.enabledPlugins] : []))
  return settings
}

function scopedSkillFile(entry, namespace, name, project, inspect) {
  if (typeof entry?.installPath !== 'string') return null
  if (['project', 'local'].includes(entry.scope) && !sameDirectory(entry.projectPath, project)) return null
  return installedSkillFile(entry.installPath, namespace, name, inspect)
}

function installedSkillFile(root, namespace, name, inspect) {
  const manifest = optionalJson(join(root, '.claude-plugin', 'plugin.json'))
  if (manifest && manifest.name !== namespace) return null
  return pluginSkill(root, name, inspect)
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

function qualifiedProjectSkill(directory, name, project) {
  if (!project || !directory.split('/').every(validPart) || directory.includes('\\')) return null
  try {
    const nested = containedPath(project, resolve(project, directory))
    return nested ? skillFile(join(nested, '.claude'), name) : null
  } catch { return null }
}

function namespacedSkill(namespace, name, config, cwd, env, inspect) {
  const qualified = qualifiedProjectSkill(namespace, name, env.CLAUDE_PROJECT_DIR)
  if (qualified) return qualified
  if (!validPart(namespace)) return null
  // Only this hook's own loaded plugin directory is exposed by the harness.
  const loaded = loadedPluginRoot(namespace, env.CLAUDE_PLUGIN_ROOT)
  if (loaded) return pluginSkill(loaded, name, inspect)
  return installedSkill(namespace, name, config, env.CLAUDE_PROJECT_DIR || cwd, inspect)
}

export function resolveSkillPath(skill, { cwd, env = process.env, inspect } = {}) {
  if (typeof skill !== 'string') return null
  const parts = skill.split(':')
  if (parts.length > 2 || !validPart(parts.at(-1))) return null
  const config = env.CLAUDE_CONFIG_DIR || join(homeDirectory(), '.claude')
  if (parts.length === 1) return personalSkill(skill, cwd, env.CLAUDE_PROJECT_DIR, config)
  return namespacedSkill(parts[0], parts[1], config, cwd, env, inspect)
}
