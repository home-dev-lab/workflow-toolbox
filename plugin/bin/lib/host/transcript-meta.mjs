import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs'

// A sub-agent's `agent-<id>.meta.json`, parsed, with the mtime of the SAME open file: one open,
// so the content and the mtime cannot come from two different writes. Null when the file is
// missing, unreadable or not JSON — callers treat null as "not finished".
export function readMetaWithMtime(metaPath) {
  let fd
  try {
    fd = openSync(metaPath, 'r')
    const mtimeMs = fstatSync(fd).mtimeMs
    return { meta: JSON.parse(readFileSync(fd, 'utf8')), mtimeMs }
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
