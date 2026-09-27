import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { createBudget, walkFiles } from './bounded-walk.mjs'
import { readFrontmatterFile } from './frontmatter.mjs'
import { boundedJson } from './host/bounded-json.mjs'

const OWN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function ancestorRoots(cwd, env) {
  const roots = []
  const seen = new Map()
  for (const start of [cwd, env.CLAUDE_PROJECT_DIR]) {
    if (!start) continue
    let dir = path.resolve(start)
    let boundary = dir
    for (let scan = dir;; scan = path.dirname(scan)) {
      if (fs.existsSync(path.join(scan, '.git'))) { boundary = scan; break }
      if (path.dirname(scan) === scan) break
    }
    let above = false
    for (;;) {
      let real = dir
      try { real = fs.realpathSync(dir) } catch { /* Preserve candidate even when cwd vanished. */ }
      if (!seen.has(real)) {
        const candidate = { root: path.join(dir, '.claude', 'agents'), speculative: above }
        roots.push(candidate)
        seen.set(real, candidate)
      } else if (!above) seen.get(real).speculative = false
      if (dir === boundary) above = true
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  // Above the nearest .git boundary we inspect for uncertainty, never give project precedence.
  return roots
}

function registryDirs(configDir, env) {
  return [...new Set([path.join(configDir, 'plugins'), env.CLAUDE_CODE_PLUGIN_CACHE_DIR].filter(Boolean))]
}

function registryEntries(configDir, env, budget, errors) {
  const found = []
  let present = false
  for (const dir of registryDirs(configDir, env)) {
    const registry = path.join(dir, 'installed_plugins.json')
    try {
      const parsed = boundedJson(registry, budget)
      const entries = parsed.plugins ?? parsed
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw Error('invalid registry')
      present = true
      for (const [key, value] of Object.entries(entries)) for (const entry of Array.isArray(value) ? value : [value]) found.push({ key, entry, dir, registry })
    } catch (error) { if (error.code !== 'ENOENT') errors.push({ path: registry, code: 'REGISTRY' }) }
  }
  return { found, present }
}

function pluginRoots(context, pluginRoot, name, budget, errors, cwd, registries) {
  const { configDir, env } = context
  const roots = []
  for (const { key, entry, dir, registry } of registries.found) {
    const registryName = key.split('@')[0]
    let namespace = registryName
    if (typeof entry?.installPath !== 'string' || !entry.installPath.trim()) {
      errors.push({ path: registry, code: 'INSTALL_PATH' })
      continue
    }
    try {
      const manifest = boundedJson(path.join(entry.installPath, '.claude-plugin', 'plugin.json'), budget)
      if (manifest.name !== undefined) {
        if (typeof manifest.name !== 'string' || !manifest.name) throw Error('invalid manifest name')
        namespace = manifest.name
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // An unreadable manifest may have declared any namespace.
        errors.push({ path: entry.installPath, code: 'MANIFEST_NAMESPACE' })
        continue
      }
    }
    if (namespace !== name) continue
    roots.push({ root: entry.installPath, marketplace: key.slice(registryName.length + 1), registryName, registryDir: dir, applicability: entry.scope === 'project' && entry.projectPath && ![env.CLAUDE_PROJECT_DIR, cwd].some((project) => project && (project === entry.projectPath || project.startsWith(`${entry.projectPath}${path.sep}`))) ? 'outside-project' : null })
  }
  if (!registries.present && name !== 'workflow-toolbox') errors.push({ path: configDir, code: 'REGISTRY_MISSING' })
  if (name === 'workflow-toolbox') for (const root of [env.CLAUDE_PLUGIN_ROOT, pluginRoot, OWN_ROOT]) if (root) roots.push({ root, marketplace: null, applicability: null })
  return roots.filter((item, index) => roots.findIndex((other) => other.root === item.root && other.marketplace === item.marketplace) === index)
}

function marketplaceListing(marketplace, registryDir, config, env, budget) {
  const locations = []
  for (const dir of [...new Set([registryDir, ...registryDirs(config, env)])]) {
    try {
      const known = boundedJson(path.join(dir, 'known_marketplaces.json'), budget)
      const location = known[marketplace]?.installLocation
      if (location !== undefined && (typeof location !== 'string' || !location)) throw Error('invalid marketplace location')
      if (location) locations.push(path.join(location, '.claude-plugin', 'marketplace.json'), location)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    locations.push(path.join(dir, 'marketplaces', marketplace, '.claude-plugin', 'marketplace.json'))
  }
  for (const location of new Set(locations)) {
    try { return boundedJson(location, budget) } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error }
  }
  throw Error('marketplace not found')
}

function agentRoots(root, budget, errors, context, marketplace, name, registryDir) {
  const { config, env } = context
  try {
    let paths
    try { paths = boundedJson(path.join(root, '.claude-plugin', 'plugin.json'), budget).agents }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    // Marketplace entry overrides the installed manifest's component paths:
    // docs/en/plugin-marketplaces#optional-plugin-fields, component path fields.
    if (marketplace) {
      const listing = marketplaceListing(marketplace, registryDir, config, env, budget)
      const entry = (Array.isArray(listing.plugins) ? listing.plugins : Object.values(listing.plugins ?? {})).find((value) => value?.name === name || value?.name === marketplace)
      if (entry?.agents !== undefined) paths = entry.agents
    }
    if (paths === undefined) paths = ['agents']
    else if (typeof paths === 'string') paths = [paths]
    if (!Array.isArray(paths) || paths.some((item) => typeof item !== 'string')) throw Error('invalid agents manifest')
    return [...new Set(paths.map((item) => path.resolve(root, item)))]
  } catch {
    // Only the source and category are retained; exception details are not used here.
    errors.push({ path: root, code: marketplace ? 'MARKETPLACE' : 'MANIFEST' })
    return []
  }
}

function agentDefinitionCandidates(type, { cwd = process.cwd(), configDir, env = process.env, pluginRoot = OWN_ROOT, budget = createBudget(), readDefinition = readFrontmatterFile } = {}) {
  const candidates = []
  const errors = []
  const scoped = type.includes(':')
  const [pluginName, ...segments] = scoped ? type.split(':') : [null, type]
  const leaf = segments.at(-1)
  const wanted = segments.join(':')
  const config = configDir || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  let unresolved = null
  if (!leaf || leaf === '.' || leaf === '..' || leaf.includes('\0') || /[/\\]/.test(leaf) || segments.some((segment) => !segment || segment === '.' || segment === '..' || /[/\\\0]/.test(segment))) return { candidates, unresolved: null, errors }
  const processRoot = (root, scope, rank, pluginBase = '', speculative = false, installation = '', applicability = null) => {
    const walked = walkFiles([root], { budget, accept: (_rel, name) => name.endsWith('.md') })
    errors.push(...walked.errors)
    if (walked.errors.length) unresolved ||= `unreadable definition: ${leaf}`
    if (walked.exhausted) unresolved = `budget: ${walked.exhausted}`
    for (const { file, rel } of walked.files) {
      const basename = path.basename(file, '.md')
      const parsed = readDefinition(file, { budget })
      if (!parsed.ok) { unresolved ||= `ambiguous definition: ${file} (${parsed.reason})`; continue }
      const data = parsed.data
      if (data.name !== undefined && typeof data.name !== 'string') { unresolved ||= `invalid definition name: ${file}`; continue }
      const name = typeof data.name === 'string' ? data.name : basename
      if (data.description !== undefined && typeof data.description !== 'string') {
        if (name === leaf || basename === leaf) unresolved ||= `invalid definition description: ${file}`
        continue
      }
      if (scope !== 'plugin' && (!data.name || typeof data.name !== 'string' || name.startsWith('-') || name.includes(':') || !data.description)) {
        if (name === leaf || basename === leaf) unresolved = `ambiguous ineligible definition: ${file}`
        continue
      }
      const prefix = scope === 'plugin' ? path.dirname(pluginBase || rel).split(path.sep).filter((part) => part !== '.') : []
      const identity = [...prefix, name].join(':')
      if (scoped ? scope !== 'plugin' || (identity !== wanted && [...prefix, basename].join(':') !== wanted) : name !== leaf && (scope !== 'plugin' || basename !== leaf)) continue
      candidates.push({ file, scope, rank, identity, data, root, installation, speculative, applicability, uncertain: Boolean(parsed.hadBom), ambiguous: false })
    }
  }
  if (!scoped) {
    ancestorRoots(cwd, env).forEach(({ root, speculative }, rank) => processRoot(root, speculative ? 'speculative' : 'project', speculative ? 30000 + rank : rank, '', speculative))
    processRoot(path.join(config, 'agents'), 'user', 10000)
  }
  const registries = registryEntries(config, env, budget, errors)
  const names = scoped ? [pluginName] : [...new Set(registries.found.map(({ key, entry }) => {
    try { return boundedJson(path.join(entry.installPath, '.claude-plugin', 'plugin.json'), budget).name || key.split('@')[0] }
    catch { return key.split('@')[0] }
  }).concat('workflow-toolbox'))]
  for (const name of names) for (const installation of pluginRoots({ configDir: config, env }, pluginRoot, name, budget, errors, cwd, registries)) {
    for (const dir of agentRoots(installation.root, budget, errors, { config, env }, installation.marketplace, installation.registryName, installation.registryDir)) processRoot(dir, 'plugin', 20000 + candidates.length, '', false, installation.root, installation.applicability)
  }
  if (errors.some((error) => ['REGISTRY', 'REGISTRY_MISSING', 'MANIFEST', 'MANIFEST_NAMESPACE', 'MARKETPLACE', 'INSTALL_PATH'].includes(error.code))) unresolved ||= 'registry or manifest unreadable'
  if (budget.exhausted) unresolved = `budget: ${budget.exhausted}`
  return { candidates, unresolved, errors }
}

function conflictingPluginInstallations(candidates) {
  const seen = new Map()
  for (const candidate of candidates) {
    if (candidate.scope !== 'plugin') continue
    const prior = seen.get(candidate.identity)
    if (prior && prior.installation !== candidate.installation && !isDeepStrictEqual(prior.data, candidate.data)) return true
    if (!prior) seen.set(candidate.identity, candidate)
  }
  return false
}

export function resolveAgentDefinition(type, opts) {
  const { candidates, unresolved } = agentDefinitionCandidates(type, opts)
  const winner = candidates.filter((item) => !item.speculative).sort((a, b) => a.rank - b.rank)[0]
  const speculativeConflict = candidates.some((item) => item.speculative && (!winner || !isDeepStrictEqual(item.data, winner.data)))
  const competingMatch = winner && candidates.some((other) => other !== winner && other.file !== winner.file &&
    (other.root === winner.root || other.installation && other.installation === winner.installation ||
      other.scope === 'plugin' && winner.scope === 'plugin' && !isDeepStrictEqual(other.data, winner.data)))
  if (unresolved || winner?.uncertain || winner?.ambiguous || winner?.applicability || speculativeConflict || competingMatch || conflictingPluginInstallations(candidates)) {
    return { unresolved: unresolved || 'ambiguous or uncertain definition' }
  }
  return winner ?? null
}
