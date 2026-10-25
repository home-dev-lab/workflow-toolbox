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

const ENTRY_CHUNK = 64 * 1024
const tooLarge = () => new Error('cache entry larger than the read bound')

// Entry-file primitives, kept on one object so the bounded read below can be observed on its real path.
export const entryFs = {
  open: (file) => openSync(file, 'r'),
  size: (fd) => fstatSync(fd).size,
  read: (fd, buffer, offset, length) => readSync(fd, buffer, offset, length, null),
  close: (fd) => closeSync(fd),
}

// The size is checked on the descriptor that is read, and at most limit + 1 bytes are ever read from
// it: an entry replaced or grown after its size was measured is refused, never read whole.
function readBounded(fd, limit) {
  if (entryFs.size(fd) > limit) throw tooLarge()
  const chunks = []
  let total = 0
  for (;;) {
    const want = Math.min(ENTRY_CHUNK, limit + 1 - total)
    const chunk = Buffer.alloc(want)
    const count = entryFs.read(fd, chunk, 0, want)
    if (count <= 0) return Buffer.concat(chunks, total).toString('utf8')
    chunks.push(chunk.subarray(0, count))
    total += count
    if (total > limit) throw tooLarge()
  }
}

export const cacheFiles = {
  // One descriptor for the whole read; refuses a file larger than limit without reading past limit + 1 bytes.
  read(file, limit = Infinity) {
    const fd = entryFs.open(file)
    try { return readBounded(fd, limit) } finally { entryFs.close(fd) }
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
