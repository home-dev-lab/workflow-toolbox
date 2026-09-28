import { isAbsolute, relative, sep } from 'node:path'

export function pathWithin(root, requested, paths = { relative, isAbsolute, sep }) {
  const rel = paths.relative(root, requested)
  return rel === '' || (!paths.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${paths.sep}`))
}
