import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { artifactStateDir, assignArtifactMounts, atomicWriteJson } from './artifact-server.mjs'
import { resolveWorkflowToolboxOption } from './plugin-options.mjs'
import { artifactRetainedIO as fs, artifactRetainedPlatform } from './host/artifact-retained-io.mjs'

const DAY_MS = 86_400_000
const NAME = /^[A-Za-z0-9._-]+$/
const NONCE = /^[0-9a-f-]{36}$/i

export function configuredArtifactRetainMs(env = process.env) {
  const days = Number(resolveWorkflowToolboxOption('artifact_server_retain_days', { env }).value)
  if (!Number.isFinite(days) || days < 0 || days > 3650) {
    throw new Error('WT_ARTIFACT_SERVER_RETAIN_DAYS must be a finite number from 0 to 3650')
  }
  return days * DAY_MS
}

/** @knipTestSeam Canonical record identity is locked by tests outside the Knip workspace. */
export function retainedRootFile(stateDir, canonical, directory = 'retained') {
  const hash = createHash('sha256').update(canonical).digest('hex')
  return path.join(stateDir, directory, `${hash}.json`)
}

function validIdentity(value) {
  return value && typeof value.canonical === 'string' && path.isAbsolute(value.canonical) &&
    typeof value.name === 'string' && NAME.test(value.name)
}

function validRecord(value) {
  return validIdentity(value) && validDeclaredPolicy(value) &&
    Number.isFinite(value.lastLiveAt) && value.lastLiveAt >= 0 && typeof value.eligible === 'boolean' &&
    (value.forgetNonce === null || (typeof value.forgetNonce === 'string' && NONCE.test(value.forgetNonce)))
}

function validDeclaredPolicy(value) {
  return typeof value.declared === 'string' && path.isAbsolute(value.declared) &&
    Array.isArray(value.deny) && value.deny.every((item) => typeof item === 'string')
}

function validMarker(value) {
  return validIdentity(value) && typeof value.nonce === 'string' && NONCE.test(value.nonce) &&
    Number.isFinite(value.at) && value.at >= 0
}

/** @knipTestSeam Security refusals are locked with injected file metadata. */
export function readRetainedEntries(stateDir, directory = 'retained', io = fs, platform = artifactRetainedPlatform, { strict = false } = {}) {
  const entries = new Map()
  for (const file of io.readdirSync(path.join(stateDir, directory))) {
    if (!/^[0-9a-f]{64}\.json$/.test(file)) continue
    collectRetainedEntry(entries, stateDir, directory, file, io, platform, strict)
  }
  return entries
}

function collectRetainedEntry(entries, stateDir, directory, file, io, platform, strict) {
  try {
    const destination = path.join(stateDir, directory, file)
    const value = readRetainedEntry(destination, stateDir, directory, io, platform)
    if (!value && strict) throw new Error(`invalid forget marker: ${file}`)
    if (value) entries.set(value.canonical, value)
  } catch (error) {
    if (strict) throw error
    // Invalid or unreadable retained records grant no serving authority.
  }
}

function readRetainedEntry(destination, stateDir, directory, io, platform) {
  const info = io.lstatSync(destination)
  if (!info.isFile() || (platform !== 'win32' && (info.mode & 0o777) !== 0o600)) return null
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return null
  const value = JSON.parse(io.readFileSync(destination, 'utf8'))
  const valid = directory === 'retained' ? validRecord(value) : validMarker(value)
  return valid && retainedRootFile(stateDir, value.canonical, directory) === destination ? value : null
}

/** @knipTestSeam Unit locks inject write/fsync failures and inspect call ordering. */
export function writeRetainedRecord(destination, value, io = fs, platform = artifactRetainedPlatform) {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.tmp-${randomUUID()}`)
  let descriptor
  try {
    descriptor = io.openSync(temporary, 'wx', 0o600)
    io.writeFileSync(descriptor, `${JSON.stringify(value)}\n`)
    if (platform !== 'win32') io.fchmodSync(descriptor, 0o600)
    io.fsyncSync(descriptor)
    io.closeSync(descriptor)
    descriptor = undefined
    io.renameSync(temporary, destination)
    syncRecordDirectory(path.dirname(destination), io, platform)
  } catch (error) {
    if (descriptor !== undefined) { try { io.closeSync(descriptor) } catch { /* Preserve the write failure. */ } }
    try { io.rmSync(temporary, { force: true }) } catch { /* Preserve the write failure. */ }
    throw error
  }
}

function syncRecordDirectory(directory, io, platform) {
  if (platform === 'win32') return
  const descriptor = io.openSync(directory, 'r')
  try { io.fsyncSync(descriptor) } finally { io.closeSync(descriptor) }
}

function declaredMatches(record, io) {
  try { return io.realpathSync(record.declared) === record.canonical } catch { return false }
}

/** @knipTestSeam Unit locks exercise exact expiry and canonical-path boundaries. */
export function retainedRootEligible(record, now, retainMs, io = fs) {
  return retainMs > 0 && record.eligible && now - record.lastLiveAt <= retainMs && declaredMatches(record, io)
}

function uniqueRecordNames(records, log) {
  const names = new Map()
  for (const record of records.values()) names.set(record.name, (names.get(record.name) ?? 0) + 1)
  const duplicates = [...names].filter(([, count]) => count > 1).map(([name]) => name)
  if (duplicates.length) log(`duplicate retained mount names ignored: ${duplicates.join(', ')}`)
  return new Map([...records].filter(([, record]) => names.get(record.name) === 1))
}

export class RetainedRootCatalog {
  constructor(stateDir, retainMs, { io = fs, log = (line) => process.stderr.write(`wt-artifact-server: ${line}\n`) } = {}) {
    this.stateDir = stateDir
    this.retainMs = retainMs
    this.io = io
    this.log = log
    this.blocked = new Map()
    this.records = uniqueRecordNames(readRetainedEntries(stateDir, 'retained', io), log)
    this.live = []
    this.markers = new Map()
    this.markersKnown = false
    this.markers = this.readMarkers()
  }

  seed(assignments) {
    for (const record of this.records.values()) assignments.set(record.canonical, record.name)
  }

  invalidate(canonical) {
    const root = this.records.get(canonical) ?? this.blocked.get(canonical) ?? this.live.find((entry) => entry.canonical === canonical)
    this.records.delete(canonical)
    try {
      const destination = retainedRootFile(this.stateDir, canonical)
      this.io.rmSync(destination, { force: true })
      syncRecordDirectory(path.dirname(destination), this.io, artifactRetainedPlatform)
      this.blocked.delete(canonical)
    } catch (error) {
      if (!this.blocked.has(canonical)) this.log(`retained root unservable: ${canonical}: ${error.message}`)
      this.blocked.set(canonical, root)
      this.markInvalidation(root)
    }
  }

  markInvalidation(root) {
    try {
      const marker = { canonical: root.canonical, name: root.name, nonce: randomUUID(), at: Date.now() }
      writeRetainedRecord(retainedRootFile(this.stateDir, root.canonical, 'forgotten'), marker, this.io)
      this.markers.set(root.canonical, marker)
      return marker
    } catch (error) {
      this.log(`retained root recovery marker failed: ${root?.canonical}: ${error.message}`)
    }
  }

  readMarkers() {
    try {
      const markers = readRetainedEntries(this.stateDir, 'forgotten', this.io, artifactRetainedPlatform, { strict: true })
      this.markersKnown = true
      return markers
    } catch (error) {
      if (!this.markerReadFailed) this.log(`forget markers unreadable: ${error.message}`)
      this.markerReadFailed = true
      this.markersKnown = false
      return this.markers
    }
  }

  persist(record) {
    try {
      writeRetainedRecord(retainedRootFile(this.stateDir, record.canonical), record, this.io)
      this.records.set(record.canonical, record)
      this.blocked.delete(record.canonical)
    } catch (error) {
      this.log(`retained root update failed: ${record.canonical}: ${error.message}`)
      this.invalidate(record.canonical)
    }
  }

  observe(root, marker, now) {
    const previous = this.previousRecord(root)
    if (this.retainMs === 0) { this.invalidate(root.canonical); return }
    const declared = previous && declaredMatches(previous, this.io) ? previous.declared : root.declared
    const record = { canonical: root.canonical, declared, name: root.name, deny: root.deny,
      lastLiveAt: now, forgetNonce: previous?.forgetNonce ?? null, eligible: true }
    if (marker && marker.nonce !== record.forgetNonce) {
      record.forgetNonce = marker.nonce
      this.log(`forget ignored while live: ${root.name}`)
    }
    if (recordNeedsRefresh(previous, record, this.retainMs) && this.prepareTransition(previous, record)) this.persist(record)
  }

  previousRecord(root) {
    return this.records.get(root.canonical) ?? this.blocked.get(root.canonical)
  }

  prepareTransition(previous, record) {
    if (!previous || !recordPolicyChanged(previous, record)) return true
    const marker = this.markInvalidation(record)
    if (!marker) { this.invalidate(record.canonical); return false }
    record.forgetNonce = marker.nonce
    return true
  }

  retire(record, marker) {
    if (!marker || marker.nonce === record.forgetNonce) return
    this.persist({ ...record, eligible: false, forgetNonce: marker.nonce })
  }

  scan(candidates, assignments, now = Date.now()) {
    this.markers = this.readMarkers()
    // Sorting makes the first live declared spelling deterministic; union remains the live union.
    this.live = assignArtifactMounts([...candidates].sort((a, b) => a.declared.localeCompare(b.declared)), assignments)
    const liveCanonicals = new Set(this.live.map((root) => root.canonical))
    for (const canonical of this.blocked.keys()) if (!liveCanonicals.has(canonical)) this.invalidate(canonical)
    for (const root of this.live) this.observe(root, this.markers.get(root.canonical), now)
    if (this.retainMs > 0) this.scanRetained(liveCanonicals, this.markers, assignments, now)
    return this.servedRoots(now)
  }

  scanRetained(liveCanonicals, markers, assignments, now) {
    for (const record of this.records.values()) {
      if (liveCanonicals.has(record.canonical)) continue
      if (now - record.lastLiveAt > this.retainMs) {
        this.invalidate(record.canonical)
        assignments.delete(record.canonical)
      } else this.retire(record, markers.get(record.canonical))
    }
  }

  servedRoots(now = Date.now()) {
    const live = this.live.map((root) => ({ ...root, retained: false, lastLiveAt: this.records.get(root.canonical)?.lastLiveAt }))
    const canonicals = new Set(live.map((root) => root.canonical))
    const retained = [...this.records.values()].filter((record) => !canonicals.has(record.canonical) &&
      this.retainedEligible(record, now))
    return [...live, ...retained.map((record) => ({ ...record, retained: true }))].sort((a, b) => a.name.localeCompare(b.name))
  }

  retainedEligible(record, now) {
    const marker = this.markers.get(record.canonical)
    return this.markersKnown && !this.blocked.has(record.canonical) && (!marker || marker.nonce === record.forgetNonce) &&
      retainedRootEligible(record, now, this.retainMs, this.io)
  }
}

function recordNeedsRefresh(previous, record, retainMs) {
  if (!previous) return true
  const { lastLiveAt: before, ...beforePolicy } = previous
  const { lastLiveAt: after, ...afterPolicy } = record
  return JSON.stringify(beforePolicy) !== JSON.stringify(afterPolicy) || after - before >= Math.min(3_600_000, retainMs / 24)
}

function recordPolicyChanged(previous, record) {
  const { lastLiveAt: _before, ...beforePolicy } = previous
  const { lastLiveAt: _after, ...afterPolicy } = record
  return JSON.stringify(beforePolicy) !== JSON.stringify(afterPolicy)
}

export function forgetRetainedRoot(name, stateDir = artifactStateDir()) {
  const records = uniqueRecordNames(readRetainedEntries(stateDir), () => {})
  const record = [...records.values()].find((entry) => entry.name === name)
  if (!record) throw new Error(`no retained root named ${name}`)
  atomicWriteJson(retainedRootFile(stateDir, record.canonical, 'forgotten'), {
    canonical: record.canonical, name, nonce: randomUUID(), at: Date.now(),
  })
  return `forget requested: ${name} (${record.canonical}). The server stops serving it at its next scan unless a live session registers it; a live session keeps it served and retained.`
}

export function formatRetainedRoot(root) {
  return `${root.name}=${root.path}` + (root.retained ? ' (retained, last live ' + new Date(root.lastLiveAt).toISOString() + ')' : '')
}
