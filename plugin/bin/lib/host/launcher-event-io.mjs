import { closeSync, constants, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export function refuseEventSymlink(file) {
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error('launcher storage refuses a symlink')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}

export function readEventOffset(file) {
  let fd
  try {
    refuseEventSymlink(file)
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const text = readFileSync(fd, 'utf8'), value = Number(text)
    if (!/^(0|[1-9]\d*)$/.test(text) || !Number.isSafeInteger(value)) throw new Error('invalid launcher cursor')
    return value
  } catch (error) { if (error.code === 'ENOENT') return 0; throw error }
  finally { if (fd !== undefined) closeSync(fd) }
}

export function writeEventOffset(file, offset) {
  const staging = `${file}.${randomUUID()}.tmp`
  const fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    writeFileSync(fd, String(offset))
    renameSync(staging, file)
  } finally {
    closeSync(fd)
    try { unlinkSync(staging) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

// Stream.write may only enqueue bytes. Complete the entire fd write before committing delivery.
export function writeLauncherLine(line, fd = 1) {
  const bytes = Buffer.from(`${line}\n`)
  let offset = 0
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset)
    if (written <= 0) throw new Error('launcher synchronous write made no progress')
    offset += written
  }
}

export function completeLauncherWrite(write, line) {
  const result = write(line)
  if (typeof result === 'boolean' || result?.then) throw new Error('launcher delivery requires a synchronous complete writer')
}
