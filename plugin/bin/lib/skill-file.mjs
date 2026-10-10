// Bounded, descriptor-owned reads for the warning-only Skill resolver.
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'

export function withRegularFile(file, visit) {
  let fd
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK || 0))
    const stat = fstatSync(fd)
    return stat.isFile() ? visit(fd, stat) : null
  } catch { return null }
  finally { if (fd !== undefined) closeSync(fd) }
}

export function containedPath(root, file) {
  const real = realpathSync(file)
  const child = relative(realpathSync(root), real)
  return child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child) ? real : null
}

export function withSkillFile(source, visit) {
  const real = containedPath(source.skillsRoot, source.file)
  if (!real) return null
  const checked = statSync(real)
  return withRegularFile(real, (fd, stat) => {
    if (stat.dev !== checked.dev || stat.ino !== checked.ino) return null
    return visit(fd, stat)
  })
}

export function readBoundedText(fd, bytes) {
  const buffer = Buffer.alloc(bytes)
  let used = 0
  while (used < bytes) {
    const count = readSync(fd, buffer, used, bytes - used, used)
    if (!count) break
    used += count
  }
  return buffer.toString('utf8', 0, used)
}
