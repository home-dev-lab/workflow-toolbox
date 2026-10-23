import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error plugin runtime module
import { LOGIC_MODULES, cacheDirectory, cachedTargets, entryPathFor, entryVersion, versionOf } from '../../../../plugin/bin/lib/model-fallback-cache.mjs'
// @ts-expect-error plugin runtime module
import { analyseTranscript, createModelTracker } from '../../../../plugin/bin/lib/model-fallback-core.mjs'
// @ts-expect-error plugin runtime module
import { scanFile, scanRange } from '../../../../plugin/bin/lib/model-fallback-scan.mjs'
// @ts-expect-error host module
import { transcriptIo } from '../../../../plugin/bin/lib/host/model-fallback-cache-files.mjs'

type Io = { open(file: string): number; read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number }
type Stats = { hit: boolean; start: number; end: number; committedEnd: number; written: boolean; fallbacks: number }

const hook = fileURLToPath(new URL('../../../../plugin/bin/wt-model-fallback-hook.mjs', import.meta.url))
const from = 'claude-opus-5-5'
const to = 'claude-opus-4-8'
const NEEDLE = 'fallback'
const scratch: string[] = []
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'wt-fallback-cache-'))
  scratch.push(root)
  const state = join(root, 'cache')
  return { root, state, file: join(root, 'parent.jsonl') }
}

// Test-only reference, independent of the byte scanner: whole file, split, filter, observe.
function reference(file: string) {
  const tracker = createModelTracker(null, process.env)
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim() || !line.includes(NEEDLE)) continue
    try { tracker.observe(JSON.parse(line)) } catch { /* corrupt lines are skipped by every reader */ }
  }
  return normal(tracker.result())
}
const normal = (result: object) => JSON.parse(JSON.stringify({ ...result, env: undefined }))

function countingIo(failFrom = Infinity) {
  const counts = { opens: 0, bytes: 0 }
  const io: Io = {
    ...transcriptIo,
    open(file) { counts.opens += 1; return transcriptIo.open(file) },
    read(fd, buffer, offset, length, position) {
      if (position + length > failFrom) throw new Error('injected read failure')
      const count = transcriptIo.read(fd, buffer, offset, length, position)
      counts.bytes += count
      return count
    },
  }
  return { io, counts }
}

const structured = (i: number, original = from) => ({ type: 'system', subtype: 'model_refusal_fallback', originalModel: original, fallbackModel: to, apiRefusalCategory: 'cyber', requestId: `req-${i}`, timestamp: `2026-10-01T00:00:${String(i % 60).padStart(2, '0')}Z` })
const fallbackItem = (i: number) => ({ type: 'assistant', timestamp: '2026-10-01T00:01:00Z', message: { id: `fb-${i % 4}`, model: to, content: [{ type: 'fallback', from: { model: from }, to: { model: to } }] } })
const mention = (i: number, model: string) => ({ type: 'assistant', message: { id: `m-${i}`, model, content: [{ type: 'text', text: `about the ${NEEDLE} é ${'x'.repeat(i % 7 * 300)}` }] } })
const refusal = (i: number) => ({ type: 'assistant', uuid: `u-${i}`, message: { id: `r-${i % 3}`, model: from, stop_reason: 'refusal', content: [{ type: 'text', text: NEEDLE }] } })
const notice = (i: number) => ({ type: 'system', subtype: 'informational', content: `Safeguards stopped this response (${NEEDLE})`, timestamp: `t-${i}` })
const noise = (i: number) => ({ type: 'user', message: { content: 'n'.repeat(i % 11 * 50) } })

function seeded(seed: number) {
  let value = seed >>> 0
  return (limit: number) => {
    value = (value + 0x6d2b79f5) >>> 0
    let t = value
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296 * limit) | 0
  }
}

const KINDS = [structured, fallbackItem, (i: number) => mention(i, from), (i: number) => mention(i, to), refusal, notice, noise,
  (i: number) => ({ ...structured(i), parent_tool_use_id: 'child' }), () => '{"broken": "fallback', () => '', () => ({ type: 'system', subtype: 'init', model: from, note: NEEDLE })]

// Lines as raw strings, with the byte offsets where each structured or fallback-item record ends (before its newline).
function transcript(random: (limit: number) => number, count: number) {
  let text = ''
  const recordEnds: number[] = []
  for (let i = 0; i < count; i++) {
    const kind = random(KINDS.length)
    const value = KINDS[kind]!(i)
    text += typeof value === 'string' ? value : JSON.stringify(value)
    if (kind <= 1) recordEnds.push(Buffer.byteLength(text))
    text += random(5) === 0 ? '\r\n' : '\n'
  }
  return { bytes: Buffer.from(text), recordEnds }
}

// Append split points: random offsets, plus offsets that leave a complete structured or assistant
// record without its newline as the unterminated last line.
function splitPoints(random: (limit: number) => number, size: number, recordEnds: number[]) {
  const points = new Set<number>([size])
  for (let i = 0; i < 8; i++) points.add(random(size))
  for (let i = 0; i < 4 && recordEnds.length; i++) points.add(recordEnds[random(recordEnds.length)]!)
  return [...points].sort((a, b) => a - b)
}

describe('byte scanner chunk boundaries', () => {
  const lines = (file: string, chunkSize: number) => { const found: string[] = []; scanFile(file, NEEDLE, { chunkSize, onLine: (line: string) => found.push(line) }); return found }

  it('finds the needle at every split offset of a chunk boundary', () => {
    const { file } = sandbox()
    for (const chunkSize of [3, 5, 8, 13]) for (let pad = 0; pad <= 2 * chunkSize; pad++) {
      const text = `${'a'.repeat(pad)}${NEEDLE}z`
      writeFileSync(file, `fallbac\nk\n${text}\nfall back\n`)
      expect(lines(file, chunkSize), `chunk ${chunkSize} pad ${pad}`).toEqual([text])
    }
  })

  it('decodes a matching line spanning three chunks with the needle only in the last one, keeping a BOM', () => {
    const { file } = sandbox()
    const long = `﻿${'é'.repeat(30)}${NEEDLE}`
    writeFileSync(file, `${long}\r\n${long}`)
    expect(lines(file, 16)).toEqual([long, long])
    const fd = transcriptIo.open(file)
    try {
      const scan = scanRange({ fd, needle: NEEDLE, chunkSize: 16, onLine: () => {} })
      expect(scan.tail).toBe(long)
      expect(scan.committedEnd).toBe(Buffer.byteLength(`${long}\r\n`))
      expect(scanRange({ fd, needle: NEEDLE, start: scan.committedEnd + 1, chunkSize: 16, onLine: () => {} }).committedEnd).toBe(scan.committedEnd + 1)
    } finally { transcriptIo.close(fd) }
  })
})

describe('incremental parent cache', () => {
  it('I1 equals the independent full-scan reference over random append sequences and chunk sizes', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const random = seeded(seed)
      const { state, file } = sandbox()
      const { bytes, recordEnds } = transcript(random, 40 + random(40))
      writeFileSync(file, '')
      let written = 0
      for (const point of splitPoints(random, bytes.length, recordEnds)) {
        appendFileSync(file, bytes.subarray(written, point))
        written = point
        const chunkSize = 1 + random(2600)
        expect(normal(cachedTargets(file, { stateDir: state, chunkSize })), `seed ${seed} at ${point} chunk ${chunkSize}`).toEqual(reference(file))
      }
      expect(normal(analyseTranscript(file, { targetsOnly: true }))).toEqual(reference(file))
    }
  })

  it('I2 a second call on an unchanged large transcript reads only the two hash windows, through one open', () => {
    const { state, file } = sandbox()
    writeFileSync(file, Array.from({ length: 4000 }, (_, i) => JSON.stringify(i % 500 ? noise(i) : structured(i))).join('\n') + '\n')
    const first = countingIo()
    cachedTargets(file, { stateDir: state, io: first.io })
    expect(first.counts.bytes).toBe(readFileSync(file).length)
    const second = countingIo()
    expect(normal(cachedTargets(file, { stateDir: state, io: second.io }))).toEqual(reference(file))
    expect(second.counts).toEqual({ opens: 1, bytes: 2 * 4096 })
  })

  it('I3 a grown transcript reads the appended bytes and the two windows only', () => {
    const { state, file } = sandbox()
    writeFileSync(file, Array.from({ length: 2000 }, (_, i) => JSON.stringify(i % 300 ? noise(i) : structured(i))).join('\n') + '\n')
    cachedTargets(file, { stateDir: state })
    const appended = `${JSON.stringify(structured(9001))}\n${JSON.stringify(noise(3))}\n`
    appendFileSync(file, appended)
    const grown = countingIo()
    const stats: Stats[] = []
    expect(normal(cachedTargets(file, { stateDir: state, io: grown.io, onStats: (s: Stats) => stats.push(s) }))).toEqual(reference(file))
    expect(grown.counts).toEqual({ opens: 1, bytes: 2 * 4096 + Buffer.byteLength(appended) })
    expect(stats[0]).toMatchObject({ hit: true, written: true })
  })
})

// A file whose committed part is well over two windows, with fallbacks at the start, middle and end.
function largeParent(file: string) {
  const records = Array.from({ length: 300 }, (_, i) => [0, 150, 296].includes(i) ? structured(i) : noise(i + 7))
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
  return readFileSync(file, 'utf8')
}
// Same-length edit of the n-th fallback record's original model: the answer changes, the size does not.
function editFallback(text: string, nth: number) {
  let at = -1
  for (let i = 0; i <= nth; i++) at = text.indexOf(`"originalModel":"${from}"`, at + 1)
  return `${text.slice(0, at)}"originalModel":"claude-opus-5-6"${text.slice(at + `"originalModel":"${from}"`.length)}`
}

describe('cache validation: each check alone rejects a stale entry', () => {
  const primed = () => { const box = sandbox(); const text = largeParent(box.file); cachedTargets(box.file, { stateDir: box.state }); return { ...box, text } }
  const answer = (box: { file: string; state: string }) => normal(cachedTargets(box.file, { stateDir: box.state }))

  it('inode: a same-size copy renamed over the transcript is a miss', () => {
    const box = primed()
    writeFileSync(join(box.root, 'copy.jsonl'), editFallback(box.text, 1))
    renameSync(join(box.root, 'copy.jsonl'), box.file)
    expect(answer(box).fallbacks.map((event: { from: string }) => event.from)).toEqual([from, 'claude-opus-5-6', from])
    expect(answer(box)).toEqual(reference(box.file))
  })

  it('head hash: a same-length in-place edit inside the first window is a miss', () => {
    const box = primed()
    writeFileSync(box.file, editFallback(box.text, 0))
    expect(answer(box).fallbacks[0].from).toBe('claude-opus-5-6')
    expect(answer(box)).toEqual(reference(box.file))
  })

  it('tail window: a same-length in-place edit inside the window before the offset is a miss', () => {
    const box = primed()
    writeFileSync(box.file, editFallback(box.text, 2))
    expect(answer(box).fallbacks[2].from).toBe('claude-opus-5-6')
    expect(answer(box)).toEqual(reference(box.file))
  })

  // No fixture can make the size check the ONLY rejecter: truncation below the offset also shortens
  // the tail-window read and changes its hash. This lock covers the behaviour, not that one check.
  it('size: a transcript truncated below the offset is a miss', () => {
    const box = primed()
    truncateSync(box.file, box.text.indexOf(JSON.stringify(structured(150))) + 10)
    expect(answer(box).fallbacks).toHaveLength(1)
    expect(answer(box)).toEqual(reference(box.file))
  })

  it('version: an entry written by other logic is a miss, and a malformed snapshot is a miss', () => {
    const box = primed()
    const entryPath = entryPathFor(box.state, box.file)
    const entry = JSON.parse(readFileSync(entryPath, 'utf8'))
    writeFileSync(entryPath, JSON.stringify({ ...entry, version: 'other-logic', snapshot: { ...entry.snapshot, fallbacks: [] } }))
    expect(answer(box).fallbacks).toHaveLength(3)
    writeFileSync(entryPath, JSON.stringify({ ...entry, snapshot: { ...entry.snapshot, runs: 'not-an-array' } }))
    expect(answer(box)).toEqual(reference(box.file))
    expect(JSON.parse(readFileSync(entryPath, 'utf8')).snapshot.runs).toEqual([])
  })
})

describe('cache failures fall back to a correct answer', () => {
  it('a read failure inside the appended bytes answers unknown and writes no entry', () => {
    const { state, file } = sandbox()
    largeParent(file)
    cachedTargets(file, { stateDir: state })
    const entryPath = entryPathFor(state, file)
    const before = readFileSync(entryPath, 'utf8')
    const size = readFileSync(file).length
    appendFileSync(file, Array.from({ length: 40 }, (_, i) => JSON.stringify(structured(500 + i))).join('\n') + '\n')
    const failing = countingIo(size + 2000)
    const answer = cachedTargets(file, { stateDir: state, io: failing.io, chunkSize: 1024 })
    expect(answer.unknown).toBe(true)
    expect(normal(answer)).toEqual(normal(analyseTranscript(file, { targetsOnly: true, io: countingIo(size + 2000).io, chunkSize: 1024 })))
    expect(readFileSync(entryPath, 'utf8')).toBe(before)
    expect(normal(cachedTargets(file, { stateDir: state }))).toEqual(reference(file))
  })

  it('an unusable cache directory, entry store or restored state still gives the full-scan answer', () => {
    const { root, file } = sandbox()
    largeParent(file)
    writeFileSync(join(root, 'not-a-dir'), '')
    expect(normal(cachedTargets(file, { stateDir: join(root, 'not-a-dir') }))).toEqual(reference(file))
    const broken = { read() { throw new Error('read') }, writeAtomic() { throw new Error('write') }, remove() { throw new Error('remove') }, prune() { throw new Error('prune') } }
    expect(normal(cachedTargets(file, { stateDir: root, files: broken }))).toEqual(reference(file))
    cachedTargets(file, { stateDir: join(root, 'ok') })
    appendFileSync(file, '{"type":"assistant","message":{"model":"claude-opus-4-8","content":[null,{"type":"fallback"}]}}\n')
    const stats: Stats[] = []
    expect(normal(cachedTargets(file, { stateDir: join(root, 'ok'), onStats: (s: Stats) => stats.push(s) }))).toEqual(reference(file))
    expect(stats[0]).toMatchObject({ fallback: true })
  })

  it('resolves the cache directory from the override, else under the state home', () => {
    const { root } = sandbox()
    expect(cacheDirectory({ WT_MODEL_FALLBACK_CACHE_DIR: join(root, 'x') })).toBe(join(root, 'x'))
    const config = join(root, 'config')
    mkdirSync(config)
    expect(cacheDirectory({ XDG_STATE_HOME: join(root, 'state'), CLAUDE_CONFIG_DIR: config })).toBe(join(root, 'state', 'wt-model-fallback', 'fallback-cache'))
  })
})

function hookEnv(root: string) {
  const env = { ...process.env, HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'xdg'), CLAUDE_CONFIG_DIR: join(root, 'config'), WT_MODEL_FALLBACK_CACHE_DIR: join(root, 'cache'), WT_MODEL_FALLBACK_CACHE_DEBUG: '1' }
  for (const dir of [env.HOME, env.XDG_STATE_HOME, env.CLAUDE_CONFIG_DIR]) mkdirSync(dir, { recursive: true })
  return env
}
const postToolUse = (parent: string) => JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Agent', transcript_path: parent, tool_input: { model: 'opus' }, tool_response: { resolvedModel: to } })
const statsOf = (stderr: string): Stats => JSON.parse(stderr.split('\n').find((line) => line.startsWith('model-fallback-cache '))!.slice('model-fallback-cache '.length))

function runHook(input: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ stdout: string; stderr: string; status: number | null }>((done) => {
    const child = spawn(process.execPath, [hook], { env })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (data) => { stdout += data })
    child.stderr.on('data', (data) => { stderr += data })
    child.on('close', (status) => done({ stdout, stderr, status }))
    child.stdin.end(input)
  })
}

describe('hook with the cache', () => {
  it('I2 through the hook: the second call on an unchanged parent scans nothing', () => {
    const { root, file } = sandbox()
    largeParent(file)
    const env = hookEnv(root)
    const first = spawnSync(process.execPath, [hook], { input: postToolUse(file), env, encoding: 'utf8' })
    const second = spawnSync(process.execPath, [hook], { input: postToolUse(file), env, encoding: 'utf8' })
    expect(statsOf(first.stderr)).toMatchObject({ hit: false, written: true, fallbacks: 3 })
    expect(statsOf(second.stderr)).toMatchObject({ hit: true, start: readFileSync(file).length, end: readFileSync(file).length, written: false, fallbacks: 3 })
    expect(JSON.parse(second.stdout).systemMessage).toContain('session fallback target')
    expect(existsSync(join(root, 'home', '.local'))).toBe(false)
  })

  it('I5 concurrent instances on a growing parent answer consistently and leave a valid entry', async () => {
    const { root, file } = sandbox()
    largeParent(file)
    const env = hookEnv(root)
    spawnSync(process.execPath, [hook], { input: postToolUse(file), env, encoding: 'utf8' })
    const runs = Array.from({ length: 6 }, () => runHook(postToolUse(file), env))
    for (let i = 0; i < 20; i++) appendFileSync(file, `${JSON.stringify(structured(700 + i))}\n${JSON.stringify(noise(i))}\n`)
    const results = await Promise.all(runs)
    const stats = results.map((run) => statsOf(run.stderr))
    for (const [i, run] of results.entries()) {
      expect(run.status).toBe(0)
      expect(JSON.parse(run.stdout).systemMessage).toContain('session fallback target')
      expect(stats[i]!.fallbacks).toBeGreaterThanOrEqual(3)
      expect(stats[i]!.fallbacks).toBeLessThanOrEqual(23)
    }
    expect(stats.some((entry) => entry.hit)).toBe(true)
    JSON.parse(readFileSync(entryPathFor(env.WT_MODEL_FALLBACK_CACHE_DIR, file), 'utf8'))
    expect(normal(cachedTargets(file, { stateDir: env.WT_MODEL_FALLBACK_CACHE_DIR }))).toEqual(reference(file))
    expect(reference(file).fallbacks).toHaveLength(23)
  })
})

// Fix round 1. Each case primes an entry, damages it or the read path, and requires the plain full-scan answer.
const primedEntry = () => { const box = sandbox(); largeParent(box.file); cachedTargets(box.file, { stateDir: box.state }); return { ...box, entryPath: entryPathFor(box.state, box.file) } }
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const editEntry = (entryPath: string, edit: (entry: Record<string, unknown>) => void) => { const entry = JSON.parse(readFileSync(entryPath, 'utf8')); edit(entry); writeFileSync(entryPath, JSON.stringify(entry)) }
const fullScan = (file: string) => normal(analyseTranscript(file, { targetsOnly: true }))

describe('fix round 1: damaged entries are misses', () => {
  it('F1 an entry whose snapshot is missing, null, false or carries malformed events is a miss', () => {
    const edits = [(e: Record<string, unknown>) => { delete e.snapshot }, (e: Record<string, unknown>) => { e.snapshot = null }, (e: Record<string, unknown>) => { e.snapshot = false },
      (e: Record<string, unknown>) => { (e.snapshot as { fallbacks: unknown[] }).fallbacks = [{}] }, (e: Record<string, unknown>) => { (e.snapshot as { runs: unknown[] }).runs = [{ model: 'x', calls: 0, position: 1 }] }]
    for (const [i, edit] of edits.entries()) {
      const box = primedEntry()
      editEntry(box.entryPath, edit)
      expect(normal(cachedTargets(box.file, { stateDir: box.state })), `edit ${i}`).toEqual(fullScan(box.file))
    }
  })

  it('F4 an entry whose offset is not just after a newline is a miss, even with matching hashes', () => {
    const box = primedEntry()
    const bytes = readFileSync(box.file)
    editEntry(box.entryPath, (entry) => {
      const offset = (entry.offset as number) - 5
      Object.assign(entry, { offset, headHash: sha(bytes.subarray(0, 4096)), tailHash: sha(bytes.subarray(offset - 4096, offset)), snapshot: { ...(entry.snapshot as object), fallbacks: [] } })
    })
    expect(normal(cachedTargets(box.file, { stateDir: box.state }))).toEqual(fullScan(box.file))
  })
})

describe('fix round 1: read path', () => {
  it('F2 a transcript truncated during the call gives the full scan of what is there, and no entry', () => {
    const box = primedEntry()
    const text = readFileSync(box.file, 'utf8')
    const size = Buffer.byteLength(text)
    appendFileSync(box.file, `${JSON.stringify(structured(800))}\n`)
    const before = readFileSync(box.entryPath, 'utf8')
    let truncated = false
    // After the windows validate, the file is cut before the last cached fallback: the cached answer is now wrong.
    const io = { ...transcriptIo, read(fd: number, buffer: Buffer, offset: number, length: number, position: number) {
      if (position >= size && !truncated) { truncated = true; truncateSync(box.file, Buffer.byteLength(text.slice(0, text.indexOf(JSON.stringify(structured(296)))))) }
      return transcriptIo.read(fd, buffer, offset, length, position)
    } }
    expect(normal(cachedTargets(box.file, { stateDir: box.state, io }))).toEqual(fullScan(box.file))
    expect(fullScan(box.file).fallbacks).toHaveLength(2)
    expect(readFileSync(box.entryPath, 'utf8')).toBe(before)
  })

  it('F3 a one-time read error at the append offset gives the full-scan answer, not the cached part', () => {
    const box = primedEntry()
    const size = readFileSync(box.file).length
    appendFileSync(box.file, `${JSON.stringify(structured(801))}\n`)
    let failed = false
    const io = { ...transcriptIo, read(fd: number, buffer: Buffer, offset: number, length: number, position: number) {
      if (position >= size && !failed) { failed = true; throw new Error('one-time read failure') }
      return transcriptIo.read(fd, buffer, offset, length, position)
    } }
    const answer = normal(cachedTargets(box.file, { stateDir: box.state, io }))
    expect(failed).toBe(true)
    expect(answer).toEqual(fullScan(box.file))
    expect(answer.unknown).toBe(false)
  })
})

describe('fix round 1: entry size, reporting and version', () => {
  it('F5 an entry file larger than the write bound is never parsed', () => {
    const box = primedEntry()
    const padded = `${readFileSync(box.entryPath, 'utf8')}${' '.repeat(4 * 1024 * 1024)}`
    writeFileSync(box.entryPath, padded)
    const parse = vi.spyOn(JSON, 'parse')
    const stats: Stats[] = []
    try {
      expect(normal(cachedTargets(box.file, { stateDir: box.state, onStats: (s: Stats) => stats.push(s) }))).toEqual(fullScan(box.file))
      expect(parse.mock.calls.some(([text]) => text === padded)).toBe(false)
    } finally { parse.mockRestore() }
    expect(stats[0]).toMatchObject({ hit: false })
  })

  it('F6 a throwing onStats callback never changes the answer', () => {
    const box = primedEntry()
    expect(normal(cachedTargets(box.file, { stateDir: box.state, onStats: () => { throw new Error('reporter') } }))).toEqual(fullScan(box.file))
  })

  it('F7 the entry version is derived from every logic module, byte for byte', () => {
    const sources = (LOGIC_MODULES as URL[]).map((url) => readFileSync(fileURLToPath(url)))
    expect(entryVersion()).toBe(versionOf(sources))
    const versions = new Set([versionOf(sources)])
    for (const i of sources.keys()) {
      const flipped = sources.map((bytes, j) => j === i ? Buffer.concat([bytes.subarray(0, 0), Buffer.from([bytes[0]! ^ 1]), bytes.subarray(1)]) : bytes)
      versions.add(versionOf(flipped))
    }
    expect(versions.size).toBe(sources.length + 1)
    expect(sources.length).toBeGreaterThanOrEqual(4)
  })
})
