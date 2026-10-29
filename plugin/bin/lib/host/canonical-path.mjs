import fs from 'node:fs'
import path from 'node:path'

const missingPath = (error) => error?.code === 'ENOENT'

function hasParentSegment(input) {
  const parts = process.platform === 'win32' ? input.split(/[\\/]/) : input.split(path.sep)
  return parts.includes('..')
}

function danglingComponent(input, lstat) {
  try { return lstat(input).isSymbolicLink() } catch (error) {
    if (missingPath(error)) return false
    throw error
  }
}

// A deleted suffix can only live beneath a directory. POSIX reports a regular-file component as ENOTDIR, but
// Windows reports ENOENT for `<file>\\child`, so the walk must check the resolved ancestor itself.
function directoryAncestor(resolved, stat) {
  try { return stat(resolved).isDirectory() } catch (error) {
    if (missingPath(error) || error?.code === 'ENOTDIR') return false
    throw error
  }
}

// Resolve before any lexical operation. A deleted ordinary suffix retains its canonical ancestor;
// unresolved parent traversal, a dangling link or a non-directory ancestor has no defensible filesystem identity.
function deletedDirectory(input, { realpath, lstat, stat }) {
  let ancestor = path.resolve(input)
  const remainder = []
  while (true) {
    try {
      const resolved = realpath.native(ancestor)
      return directoryAncestor(resolved, stat) ? path.join(resolved, ...remainder) : null
    } catch (error) {
      if (error?.code === 'ENOTDIR') return null
      if (!missingPath(error)) throw error
      if (danglingComponent(ancestor, lstat)) return null
    }
    const parent = path.dirname(ancestor)
    if (parent === ancestor) return null
    remainder.unshift(path.basename(ancestor))
    ancestor = parent
  }
}

export function canonicalDirectory(input, { realpath = fs.realpathSync, lstat = fs.lstatSync, stat = fs.statSync } = {}) {
  try { return realpath.native(input) } catch (error) {
    if (error?.code === 'ENOTDIR') return null
    if (!missingPath(error)) throw error
  }
  if (hasParentSegment(input)) return null
  return deletedDirectory(input, { realpath, lstat, stat })
}

export function recordedWorktreeIdentity(root) {
  try { return { worktree_realpath: fs.realpathSync.native(root) } } catch (error) {
    return { worktree_realpath: null, worktree_realpath_reason: error instanceof Error ? error.message : String(error) }
  }
}
