import path from 'node:path'
import { walkFilesystem as nodeFs } from './host/walk-filesystem.mjs'

export function createBudget({ maxDepth = 12, maxEntries = 20000, maxDirs = 2000, maxBytes = 8 * 1024 * 1024 } = {}) {
  return { maxDepth, maxEntries, maxDirs, maxBytes, entries: 0, dirs: 0, bytes: 0, exhausted: null }
}

function deletedSinceListing(item, fs, budget, errors) {
  const parent = path.dirname(item.file), name = path.basename(item.file)
  // The confirmation scan spends a directory visit, its own entry, and each name read.
  if (++budget.dirs > budget.maxDirs) { budget.exhausted = 'dirs'; return false }
  if (++budget.entries > budget.maxEntries) { budget.exhausted = 'entries'; return false }
  let dir, absent = true, unchanged = true, readable = true
  try {
    dir = fs.opendirSync(parent)
    let entry
    while ((entry = dir.readSync())) {
      if (++budget.entries > budget.maxEntries) { budget.exhausted = 'entries'; break }
      if (entry.name === name) absent = false
      if (!item.siblings.has(entry.name)) unchanged = false
    }
  } catch (error) { errors.push({ path: parent, code: error.code ?? 'IO' }); readable = false }
  finally {
    if (dir) try { dir.closeSync() } catch (error) { errors.push({ path: parent, code: error.code ?? 'IO' }); readable = false }
  }
  // New names could hide a renamed definition, even if the failed name disappeared.
  return readable && !budget.exhausted && absent && unchanged
}

export function walkFiles(roots, { accept = () => true, budget = createBudget(), fs = nodeFs } = {}) {
  const files = [], errors = []
  const stack = [...new Set(roots)].reverse().map((root) => ({ root, file: root, rel: '', depth: 0, ancestors: new Set() }))
  while (stack.length && !budget.exhausted) {
    const item = stack.pop()
    // Count before lstat, including roots, dangling links and cycle edges.
    if (++budget.entries > budget.maxEntries) { budget.exhausted = 'entries'; break }
    let link, stat
    try {
      link = fs.lstatSync(item.file)
    } catch (error) {
      if (error.code === 'ENOENT' && (!item.rel || deletedSinceListing(item, fs, budget, errors))) continue
      errors.push({ path: item.file, code: error.code ?? 'IO' })
      continue
    }
    try {
      stat = link.isSymbolicLink() ? fs.statSync(item.file) : link
    } catch (error) {
      if (error.code !== 'ENOENT' || item.rel) errors.push({ path: item.file, code: error.code ?? 'IO' })
      continue
    }
    if (stat.isDirectory()) {
      let real
      try { real = fs.realpathSync(item.file) } catch (error) { errors.push({ path: item.file, code: error.code ?? 'IO' }); continue }
      if (item.ancestors.has(real)) continue
      if (item.depth > budget.maxDepth) { budget.exhausted = 'depth'; break }
      if (++budget.dirs > budget.maxDirs) { budget.exhausted = 'dirs'; break }
      const ancestors = new Set(item.ancestors)
      ancestors.add(real)
      let dir
      const names = []
      try {
        dir = fs.opendirSync(item.file)
        let entry
        // At most remaining budget + 1 names are materialized, even for enormous directories.
        while ((entry = dir.readSync())) {
          names.push(entry.name)
          if (names.length + budget.entries + stack.length > budget.maxEntries) { budget.exhausted = 'entries'; break }
        }
      } catch (error) { errors.push({ path: item.file, code: error.code ?? 'IO' }) }
      finally { if (dir) try { dir.closeSync() } catch (error) { errors.push({ path: item.file, code: error.code ?? 'IO' }) } }
      if (budget.exhausted) break
      names.sort()
      const siblings = new Set(names)
      for (let i = names.length - 1; i >= 0; i--) {
        const name = names[i]
        stack.push({ root: item.root, file: path.join(item.file, name), rel: item.rel ? path.join(item.rel, name) : name, depth: item.depth + 1, ancestors, siblings })
      }
    } else if (stat.isFile()) {
      if (!item.rel || accept(item.rel, path.basename(item.file))) files.push({ root: item.root, file: item.file, rel: item.rel || path.basename(item.file) })
    } else if (!item.rel || accept(item.rel, path.basename(item.file))) errors.push({ path: item.file, code: 'NOT_REGULAR' })
  }
  return { files, errors, exhausted: budget.exhausted }
}
