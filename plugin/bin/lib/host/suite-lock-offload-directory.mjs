import { closeSync, constants, openSync } from 'node:fs'
import path from 'node:path'

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW

/** Walk from pinned directory descriptors; no mutable component may redirect the command's cwd. */
export function openOffloadDirectory(root, relative) {
  const parts = relative.split(path.sep).filter((part) => part !== '.' && part !== '')
  if (path.isAbsolute(relative) || parts.includes('..')) throw new Error('offload cwd outside host launch root')
  let fd = openSync(root, DIRECTORY_FLAGS)
  try {
    for (const part of parts) {
      const next = openSync(`/proc/self/fd/${fd}/${part}`, DIRECTORY_FLAGS)
      closeSync(fd); fd = next
    }
    return fd
  } catch (error) { closeSync(fd); throw error }
}
