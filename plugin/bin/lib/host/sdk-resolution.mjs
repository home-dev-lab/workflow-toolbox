import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SDK = '@anthropic-ai/claude-agent-sdk'
const MIN_AGENT_SDK_VERSION = '0.3.280'
const OWN_TOOLKIT_MANIFEST = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../toolkit/package.json')
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

// A Bash shell started from a Claude Code session can inherit ANOTHER plugin's CLAUDE_PLUGIN_DATA
// (measured: a clean-install run printed the codex plugin's data dir as the install prefix). Claude Code
// names a plugin's data dir `<plugin>-<marketplace>`, so only a dir named for this plugin is trusted.
function ownPluginData(env) {
  if (!env.CLAUDE_PLUGIN_DATA) return null
  const dir = resolve(env.CLAUDE_PLUGIN_DATA)
  return basename(dir).startsWith('workflow-toolbox-') ? dir : null
}

function sdkManifest(entry) {
  let directory = dirname(entry)
  while (true) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
        if (parsed.name === SDK && typeof parsed.version === 'string') return { manifest, version: parsed.version, root: directory }
      } catch {}
    }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

function meetsMinimum(version) {
  const parsed = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version)
  const floor = MIN_AGENT_SDK_VERSION.split('.').map(Number)
  if (!parsed) return false
  const actual = parsed.slice(1, 4).map(Number)
  for (let index = 0; index < floor.length; index += 1) {
    if (actual[index] !== floor[index]) return actual[index] > floor[index]
  }
  return parsed[4] === ''
}

export function resolveAgentSdkRequire(options = {}) {
  return resolveAgentSdk(options).require
}

function contained(root, target) {
  const from = realpathSync(root)
  const to = realpathSync(target)
  const rel = relative(from, to)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function resolvedCandidate(require, explicitEntry = null) {
  const entryPath = realpathSync(explicitEntry ?? require.resolve(SDK))
  const packageInfo = sdkManifest(entryPath)
  if (!packageInfo) return null
  return { ...packageInfo, entryPath, require: createRequire(entryPath) }
}

export function resolveAgentSdk(options = {}) {
  const {
    projectDir = process.cwd(),
    env = process.env,
    ownToolkitManifest = OWN_TOOLKIT_MANIFEST,
    writableRoots = [],
    sdkEntry = env.WT_AGENT_SDK_PATH || null,
  } = options
  const candidates = []
  const incompatible = []
  const unsafe = []
  if (sdkEntry) candidates.push({ base: sdkEntry, entry: sdkEntry })
  if (!sdkEntry && ownToolkitManifest && existsSync(ownToolkitManifest)) candidates.push(ownToolkitManifest)
  if (!sdkEntry && projectDir) candidates.push(join(resolve(projectDir), 'package.json'))
  const pluginData = ownPluginData(env)
  if (!sdkEntry && pluginData) candidates.push(join(pluginData, 'package.json'))
  const accept = (candidate) => {
    if (!candidate) return null
    if (!meetsMinimum(candidate.version)) { incompatible.push(candidate.version); return null }
    const writable = writableRoots.find((root) => existsSync(root) && contained(root, candidate.root))
    if (writable) { unsafe.push(`${candidate.root} is inside writer-writable root ${realpathSync(writable)}`); return null }
    return candidate
  }
  for (const value of candidates) {
    try {
      const descriptor = typeof value === 'string'
        ? resolvedCandidate(createRequire(value))
        : resolvedCandidate(createRequire(value.base), value.entry)
      const accepted = accept(descriptor)
      if (accepted) return accepted
    } catch {
      // A manifest alone is insufficient: the SDK must resolve from this install.
    }
  }
  const npmRoot = sdkEntry ? null : Object.hasOwn(options, 'npmRoot') ? options.npmRoot : globalNpmRoot()
  if (npmRoot) {
    const require = createRequire(join(dirname(resolve(npmRoot)), 'package.json'))
    try {
      const accepted = accept(resolvedCandidate(require))
      if (accepted) return accepted
    } catch {
      // A broken or stale global npm root is not a startup error by itself.
    }
  }
  // The literal path on every platform: the variable is set for the plugin's own processes, not in the
  // terminal where the owner pastes the remedy.
  const install = pluginData
    ? `npm install --prefix "${pluginData}" '${SDK}@>=${MIN_AGENT_SDK_VERSION}'`
    : `npm install -g '${SDK}@>=${MIN_AGENT_SDK_VERSION}'`
  const reason = unsafe.length > 0
    ? `refuses writer-influenceable install: ${unsafe.join('; ')}`
    : incompatible.length > 0
    ? `found ${[...new Set(incompatible)].join(', ')}, require >=${MIN_AGENT_SDK_VERSION}`
    : `is not installed; require >=${MIN_AGENT_SDK_VERSION}`
  throw new Error(`${SDK} ${reason}; run: ${install}`)
}

function importedSpecifiers(source) {
  const values = []
  const pattern = /(?:\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?|\bimport\s*\(|\brequire\s*\()\s*['"]([^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) values.push(match[1])
  return values
}

function resolveImportedFile(specifier, importer) {
  if (specifier.startsWith('node:')) return null
  try {
    const resolved = createRequire(importer).resolve(specifier)
    return isAbsolute(resolved) && existsSync(resolved) ? realpathSync(resolved) : null
  } catch { return null }
}

export function resolvedAgentSdkCodePaths(resolution) {
  const descriptor = resolution.entryPath ? resolution : resolvedCandidate(resolution)
  const pending = [descriptor.entryPath]
  const loaded = new Set([descriptor.manifest])
  while (pending.length > 0) {
    const file = pending.pop()
    if (loaded.has(file)) continue
    loaded.add(file)
    if (!['.js', '.cjs', '.mjs'].includes(extname(file))) continue
    let source
    try { source = readFileSync(file, 'utf8') } catch { continue }
    for (const specifier of importedSpecifiers(source)) {
      const imported = resolveImportedFile(specifier, file)
      if (!imported || loaded.has(imported)) continue
      const manifest = sdkManifest(imported)?.manifest
      if (manifest) loaded.add(manifest)
      pending.push(imported)
    }
  }
  return [...loaded]
}
