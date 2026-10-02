// Filesystem boundary for session-scoped wake attribution. Keep host primitives here:
// attribution in ../delegate-wake.mjs operates on records, never on ambient paths.
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { pluginName, resolvePluginDataDir } from '../plugin-data-dir.mjs'

export function defaultRegistryDir() {
  return process.env.WT_OUTBOUND_GUARD_DIR || resolvePluginDataDir({
    fallback: path.join(homedir(), '.local', 'state', 'wt-outbound-guard'), pluginName: pluginName(),
  }).dir
}

const CHUNK_BYTES = 1 << 20

function parseLine(line, strict) {
  try { return JSON.parse(line.toString('utf8')) } catch (error) {
    if (strict) throw error
    return null
  }
}

// Incremental line reader: fixed buffer, one line held at a time. A transcript can pass V8's
// string limit and the heap; nothing here materialises the whole file. Memory kept is the
// records `project` returns, and `accept` may reject a raw line before it is decoded at all.
// cursor: { offset, tailBytes, records } — offset includes the unterminated tail held in tailBytes.
export function advanceJsonl(file, cursor, { strict = true, accept = null, project = null } = {}) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    if (size < cursor.offset) { cursor.offset = 0; cursor.tailBytes = Buffer.alloc(0); cursor.records = [] }
    const fresh = []
    const pending = cursor.tailBytes?.length ? [cursor.tailBytes] : []
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES)
    const take = (line) => {
      if (!line.length || (accept && !accept(line))) return
      const record = parseLine(line, strict)
      const kept = record && project ? project(record) : record
      if (kept) fresh.push(kept)
    }
    let position = cursor.offset
    while (position < size) {
      const read = fs.readSync(fd, chunk, 0, Math.min(CHUNK_BYTES, size - position), position)
      if (read <= 0) break
      position += read
      const data = chunk.subarray(0, read)
      let from = 0
      for (let newline = data.indexOf(10); newline >= 0; newline = data.indexOf(10, from)) {
        const piece = data.subarray(from, newline)
        take(pending.length ? Buffer.concat([...pending, piece]) : piece)
        pending.length = 0
        from = newline + 1
      }
      if (from < read) pending.push(Buffer.from(data.subarray(from)))
    }
    for (const record of fresh) cursor.records.push(record)
    cursor.tailBytes = pending.length ? Buffer.concat(pending) : Buffer.alloc(0)
    cursor.offset = position
    return cursor.records
  } finally { fs.closeSync(fd) }
}

export function readJsonl(file, strict = false, project = null, accept = null) {
  return advanceJsonl(file, { offset: 0, tailBytes: Buffer.alloc(0), records: [] }, { strict, project, accept })
}

export function appendRecord(file, record) {
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`)
}

export function readThrottle(file) {
  let state = {}
  let degraded = null
  try {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)
      || Object.values(loaded).some((v) => !v || !Number.isFinite(v.lastEmittedAt) || !Number.isSafeInteger(v.count) || v.count < 1)) {
      throw new Error('invalid state')
    }
    state = loaded
  } catch (error) { degraded = error.code === 'ENOENT' ? 'throttle state absent' : 'throttle state unreadable' }
  // Probe the actual atomic-write route before eligibility uses this state. File access bits
  // alone do not establish that its directory permits creation and rename (including ACLs).
  const writeError = writeThrottle(file, state)
  return { state: writeError ? {} : state, degraded: writeError ?? degraded }
}

// Windows refuses `rename` over a file another process holds open (EPERM, EACCES or EBUSY), and two
// watchers writing this state meet exactly that while the other's rename or read is in flight. The
// refusal is transient: retry it, bounded (under a second in all), before reporting the state
// unwritable. Any other error is not retried. The retry is not limited to Windows: elsewhere a refused
// rename is a lasting permission problem and is reported after the same bound. `rename` and `pause` are
// seams for tests only.
const RENAME_TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_ATTEMPTS = 10
const RENAME_PAUSE_MS = 20

function pauseSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function renameRetrying(rename, pause, from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try { return rename(from, to) } catch (error) {
      if (!RENAME_TRANSIENT_CODES.has(error?.code) || attempt >= RENAME_ATTEMPTS) throw error
      pause(RENAME_PAUSE_MS * attempt)
    }
  }
}

export function writeThrottle(file, state, seams) {
  let tmp
  try {
    const rename = seams?.rename ?? fs.renameSync
    const pause = seams?.pause ?? pauseSync
    tmp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(state))
    renameRetrying(rename, pause, tmp, file)
    return null
  } catch { return 'throttle state unwritable' }
  finally { if (tmp) { try { fs.unlinkSync(tmp) } catch { /* renamed or unwritable */ } } }
}

// Byte tail (rather than a decoded string) preserves UTF-8 characters split over polls.
export function readNewMain(file, cursor, project = null, accept = null) {
  return advanceJsonl(file, cursor, { strict: true, project, accept })
}

export function readAgents(sessionDir, cache = new Map(), project = null) {
  const dir = path.join(sessionDir, 'subagents')
  const agents = {}, meta = {}
  const stamp = (file) => { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}` }
  for (const name of fs.readdirSync(dir).filter((entry) => /^agent-a[a-z0-9-]{6,80}\.jsonl$/.test(entry))) {
    const id = name.slice(6, -6)
    const transcript = path.join(dir, name)
    const metadata = path.join(dir, `agent-${id}.meta.json`)
    let item = cache.get(id)
    if (!item) { item = { offset: 0, tailBytes: Buffer.alloc(0), records: [], metaStamp: null, info: null }; cache.set(id, item) }
    if (fs.statSync(transcript).size !== item.offset) advanceJsonl(transcript, item, { strict: true, project })
    const metaStamp = stamp(metadata)
    if (item.metaStamp !== metaStamp) { item.info = JSON.parse(fs.readFileSync(metadata, 'utf8')); item.metaStamp = metaStamp }
    agents[id] = item.records
    meta[id] = item.info
  }
  return { agents, meta }
}
