import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

function stagedPaths(root) {
  return execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
}

function tracked(root, file) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--cached', '--', file], { cwd: root, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function stagedJson(root, file) {
  return JSON.parse(execFileSync('git', ['show', `:${file}`], { cwd: root, encoding: 'utf8' }))
}

function compareVersions(left, right) {
  const parts = (version) => version.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  const a = parts(left)
  const b = parts(right)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1
    if (b[i] === undefined) return 1
    if (a[i] === b[i]) continue
    if (typeof a[i] === 'number' && typeof b[i] === 'number') return a[i] - b[i]
    return String(a[i]).localeCompare(String(b[i]))
  }
  return 0
}

function pluginRoots(root, staged) {
  const roots = new Set()
  // One `git ls-files` per DISTINCT manifest path, not per staged file × depth: a 300-file commit
  // five levels deep would otherwise spawn ~1500 git processes inside the hook's 5 s budget and
  // fail open in silence.
  const seen = new Map()
  const isTracked = (manifest) => {
    if (!seen.has(manifest)) seen.set(manifest, tracked(root, manifest))
    return seen.get(manifest)
  }
  for (const file of staged) {
    let directory = path.posix.dirname(file)
    while (true) {
      const manifest = directory === '.' ? '.claude-plugin/plugin.json' : `${directory}/.claude-plugin/plugin.json`
      if (isTracked(manifest)) {
        roots.add(directory === '.' ? '' : directory)
        break
      }
      if (directory === '.') break
      directory = path.posix.dirname(directory)
    }
  }
  return [...roots].sort()
}

function rootFile(pluginRoot, file) {
  return pluginRoot ? `${pluginRoot}/${file}` : file
}

function carriersForRoot(root, pluginRoot) {
  const pluginManifest = rootFile(pluginRoot, '.claude-plugin/plugin.json')
  const carriers = [{ file: pluginManifest, label: pluginManifest, json: stagedJson(root, pluginManifest) }]
  const packageManifest = rootFile(pluginRoot, 'package.json')
  if (tracked(root, packageManifest)) {
    const json = stagedJson(root, packageManifest)
    if (Object.hasOwn(json, 'version')) carriers.push({ file: packageManifest, label: packageManifest, json })
  }

  const marketplace = '.claude-plugin/marketplace.json'
  if (tracked(root, marketplace)) {
    const json = stagedJson(root, marketplace)
    if (Array.isArray(json.plugins)) {
      for (const [index, entry] of json.plugins.entries()) {
        if (!entry || typeof entry.source !== 'string' || !Object.hasOwn(entry, 'version')) continue
        if (path.resolve(root, entry.source) !== path.resolve(root, pluginRoot || '.')) continue
        carriers.push({ file: marketplace, label: `${marketplace}#plugins[${index}]`, json, entry, index })
      }
    }
  }
  return carriers
}

function checkedRoot(root, pluginRoot) {
  const carriers = carriersForRoot(root, pluginRoot)
  const versions = Object.fromEntries(carriers.map((carrier) => [carrier.label, carrier.entry ? carrier.entry.version : carrier.json.version]))
  if (Object.values(versions).some((version) => typeof version !== 'string' || !version)) {
    throw new Error(`plugin version carriers under ${pluginRoot || '.'} must contain non-empty string versions`)
  }
  const target = Object.values(versions).sort(compareVersions).at(-1)
  return { root: pluginRoot || '.', carriers, files: carriers.map(({ label }) => label), versions, target }
}

function remedy(checked) {
  return `Versions diverged for ${checked.root}: ${checked.files.map((file) => `${file} is ${JSON.stringify(checked.versions[file])}`).join('; ')}.\n` +
    `Set every carrier to ${JSON.stringify(checked.target)}, stage them, then rerun git commit.`
}

function align(root, checked) {
  const files = new Map()
  for (const carrier of checked.carriers) {
    if (carrier.entry) carrier.entry.version = checked.target
    else carrier.json.version = checked.target
    files.set(carrier.file, carrier.json)
  }
  for (const [file, json] of files) {
    fs.writeFileSync(path.join(root, file), `${JSON.stringify(json, null, 2)}\n`)
  }
  execFileSync('git', ['add', ...files.keys()], { cwd: root, stdio: 'ignore' })
}

/** Discover staged plugin roots and align each root's version carriers when requested. */
export function checkPluginVersionAlignment(root, mode = process.env.WT_VERSION_GUARD_MODE) {
  const roots = pluginRoots(root, stagedPaths(root))
  if (!roots.length) return { status: 'not-a-plugin-commit' }

  const checked = roots.map((pluginRoot) => checkedRoot(root, pluginRoot))
  const diverged = checked.filter((item) => item.carriers.length > 1 && new Set(Object.values(item.versions)).size > 1)
  if (!diverged.length) {
    return { status: checked.every((item) => item.carriers.length === 1) ? 'single-carrier' : 'aligned' }
  }

  if (String(mode).toLowerCase() !== 'align') {
    const item = diverged[0]
    return { status: 'diverged', root: item.root, files: item.files, versions: item.versions, remedy: remedy(item) }
  }

  for (const item of diverged) align(root, item)
  return { status: 'aligned' }
}
