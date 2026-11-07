import path from 'node:path'
import { realpathSync } from './worktree-sweep-io.mjs'

function containsKeys(root, target, separator) {
  return root === target || target.startsWith(root.endsWith(separator) ? root : `${root}${separator}`)
}

function parentResolver(paths, realpath) {
  const cache = new Map()
  function resolve(parent) {
    if (cache.has(parent)) return cache.get(parent)
    let value
    try { value = realpath(parent) } catch (error) {
      if (typeof error?.code !== 'string') throw error
      const ancestor = paths.dirname(parent)
      value = ancestor === parent ? parent : paths.join(resolve(ancestor), paths.basename(parent))
    }
    cache.set(parent, value)
    return value
  }
  return resolve
}

// Identity describes a location, not its leaf's target. Realpath is parent-only.
export function sweepPathIdentity({ platform = process.platform, realpath } = {}) {
  // A mocked process reader can be Linux while fixture files still live on NTFS.
  const paths = platform === 'win32' || path === path.win32 ? path.win32 : path.posix
  const foldName = value => paths === path.win32 || platform === 'darwin' ? value.toLowerCase() : value
  const fold = value => {
    const resolved = paths.resolve(value)
    const trimmed = resolved.length > paths.parse(resolved).root.length ? resolved.replace(paths === path.win32 ? /[\\/]$/ : /\/$/, '') : resolved
    return foldName(platform === 'darwin' && paths === path.posix ? trimmed.replace(/^\/var(?=\/|$)/, '/private/var') : trimmed)
  }
  // Never send a foreign-flavour path to the native host filesystem.
  const readParent = realpath ?? (paths.sep === path.sep ? realpathSync.native : value => value)
  const parent = parentResolver(paths, readParent)
  const key = value => {
    const resolved = paths.resolve(value)
    return fold(paths.join(parent(paths.dirname(resolved)), paths.basename(resolved)))
  }
  return { paths, fold, foldName, key, equals: (a, b) => key(a) === key(b),
    contains: (root, target) => containsKeys(key(root), key(target), paths.sep),
    lexicalContains: (root, target) => containsKeys(fold(root), fold(target), paths.sep) }
}
