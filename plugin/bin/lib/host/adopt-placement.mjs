import fs from 'node:fs'
import path from 'node:path'

const ON_DEMAND_NAME = 'rules-on-demand'

// The engine-owned on-demand roots. Mirrors ruleDirectories() in
// plugins/wt-rules-on-demand/paths.js; swap in the engine's placement API once it exposes one.
const clean = (value) => {
  let text = String(value)
  while (text.endsWith('/') || text.endsWith('\\')) text = text.slice(0, -1)
  return text
}

export function onDemandRoots({ project, config }) {
  return { project: `${clean(project)}/.claude/${ON_DEMAND_NAME}`, user: `${clean(config)}/${ON_DEMAND_NAME}` }
}

// The static roots the engine loads recursively (projectStatic / userStatic in the same file).
export function staticRoots({ project, config }) {
  return { project: `${clean(project)}/.claude/rules`, user: `${clean(config)}/rules` }
}

export function placementRoots(scope) {
  return { onDemand: onDemandRoots(scope), static: staticRoots(scope) }
}

/** Resolve `dir` through its nearest existing ancestor: realpath that ancestor, then append the
 *  segments that do not exist yet. A fully missing path resolves to itself. */
function resolveThroughAncestor(dir) {
  let current = path.resolve(dir)
  const missing = []
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(dir)
      missing.unshift(path.basename(current))
      current = parent
    }
  }
}

/** Filesystem identity (device + inode) of an existing directory, or null. A filesystem that
 *  reports inode 0 has no usable identity; it degrades to "no identity", never to a match. */
function directoryIdentity(dir) {
  try {
    const stat = fs.statSync(dir, { bigint: true })
    if (!stat.isDirectory() || stat.ino === 0n) return null
    return { dev: stat.dev, ino: stat.ino }
  } catch {
    return null
  }
}

const namedOnDemand = (dir) => path.basename(dir).toLowerCase() === ON_DEMAND_NAME

const sameIdentity = (a, b) => a !== null && b !== null && a.dev === b.dev && a.ino === b.ino

/** True when the resolved directory is, or lies under, a static root (by identity). Its real
 *  storage is then a static tree: the static loader reads it, and the engine does not serve an
 *  on-demand copy that is also loaded statically. */
function insideStaticTree(resolved, statics) {
  const identities = Object.values(statics).map(directoryIdentity).filter(Boolean)
  if (!identities.length) return false
  for (let current = resolved; ; current = path.dirname(current)) {
    const identity = directoryIdentity(current)
    if (identities.some((root) => sameIdentity(root, identity))) return true
    if (path.dirname(current) === current) return false
  }
}

/** True when `dir` is on-demand storage. A directory whose real storage is inside a static root
 *  never is. Otherwise: its own final name or its resolved final name is `rules-on-demand`
 *  (case-insensitively, every platform), or it is the same directory as an existing on-demand
 *  root by filesystem identity, never by path text. `roots` comes from placementRoots(). */
export function isOnDemandDir(dir, roots = {}) {
  const resolved = resolveThroughAncestor(dir)
  if (insideStaticTree(resolved, roots.static ?? {})) return false
  if (namedOnDemand(path.resolve(dir)) || namedOnDemand(resolved)) return true
  const identity = directoryIdentity(resolved)
  if (!identity) return false
  return Object.values(roots.onDemand ?? {}).some((root) => sameIdentity(directoryIdentity(root), identity))
}

export function readRuleText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}
