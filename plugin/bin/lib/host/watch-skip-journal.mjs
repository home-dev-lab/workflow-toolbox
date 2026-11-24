import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

function rotateIfFull(path) {
  let size
  try { size = statSync(path).size } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  if (size > 1024 * 1024) renameSync(path, `${path}.1`)
}

/** Reads only the last byte: a newline is needed before an append that follows a partial line. */
export function lineBoundary(path) {
  let fd
  try { fd = openSync(path, 'r') } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
  try {
    const { size } = fstatSync(fd)
    if (size === 0) return ''
    const last = Buffer.alloc(1)
    readSync(fd, last, 0, 1, size - 1)
    return last[0] === 0x0a ? '' : '\n'
  } finally { closeSync(fd) }
}

/** Synchronous append lets a watcher fall back to emitting before marking a line handled. */
export function appendSkippedWake(path, encoded) {
  mkdirSync(dirname(path), { recursive: true })
  rotateIfFull(path)
  appendFileSync(path, lineBoundary(path) + encoded, 'utf8')
}
