// Host access for the model-fallback parent-transcript cache: the transcript file descriptor,
// the cache entry files, and the module sources the entry version is derived from.
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// One descriptor per call: every byte of the transcript the cache or the scanner reads goes through read().
export const transcriptIo = {
  open: (file) => openSync(file, 'r'),
  // bigint stat keeps 64-bit inode numbers (Windows file indexes) exact; they are compared as strings.
  fstat(fd) {
    const stat = fstatSync(fd, { bigint: true })
    return { size: Number(stat.size), dev: String(stat.dev), ino: String(stat.ino) }
  },
  read: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
  close: (fd) => closeSync(fd),
}

function pruneEntry(dir, name, cutoff) {
  try {
    const file = join(dir, name)
    if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true })
  } catch { /* a concurrent writer may have renamed or removed it */ }
}

export const cacheFiles = {
  // Refuses a file larger than limit before reading its content.
  read(file, limit = Infinity) {
    if (statSync(file).size > limit) throw new Error('cache entry larger than the read bound')
    return readFileSync(file, 'utf8')
  },
  // Whole-entry replacement: a reader sees the previous entry or the new one, never a mix.
  writeAtomic(file, text) {
    mkdirSync(dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      writeFileSync(temporary, text)
      renameSync(temporary, file)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  },
  remove: (file) => rmSync(file, { force: true }),
  prune(dir, maxAgeMs, now) {
    const cutoff = now - maxAgeMs
    for (const name of readdirSync(dir)) if (name.endsWith('.json') || name.endsWith('.tmp')) pruneEntry(dir, name, cutoff)
  },
}

export const readModuleSources = (urls) => urls.map((url) => readFileSync(fileURLToPath(url)))

export function defaultCacheBase(env) {
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'wt-model-fallback')
}
