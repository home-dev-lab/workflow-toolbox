import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { isInvokedDirectly } from '../../../../plugin/bin/lib/host/entry-guard.mjs'
import { ensureRetainedDirectories } from '../../../../plugin/bin/lib/host/artifact-retained-io.mjs'
import { configuredArtifactRetainMs as installedRetainMs, readRetainedEntries as installedRead,
  retainedRootEligible as installedEligibility, retainedRootFile as installedFile,
  RetainedRootCatalog as InstalledCatalog, writeRetainedRecord as installedWriter } from '../../../../plugin/bin/lib/artifact-retained-roots.mjs'

const installed = { configuredArtifactRetainMs: installedRetainMs, readRetainedEntries: installedRead,
  retainedRootEligible: installedEligibility, retainedRootFile: installedFile,
  RetainedRootCatalog: InstalledCatalog, writeRetainedRecord: installedWriter }
const { configuredArtifactRetainMs, readRetainedEntries, retainedRootEligible,
  retainedRootFile, RetainedRootCatalog, writeRetainedRecord } = process.env.WT_RETAINED_TEST_MODULE
    ? await import(process.env.WT_RETAINED_TEST_MODULE) : installed

const DAY = 86_400_000

const scratch = []
function fixture(io = fs) {
  const state = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'retained-catalog-')))
  scratch.push(state)
  ensureRetainedDirectories(state)
  const canonical = path.join(state, 'reports')
  fs.mkdirSync(canonical)
  const record = { canonical, declared: canonical, name: 'reports', deny: ['*.secret'], lastLiveAt: Date.now(), forgetNonce: null, eligible: true }
  const file = retainedRootFile(state, canonical)
  const publish = (value = record) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
  const logs = []
  const catalog = () => new RetainedRootCatalog(state, DAY, { io, log: (line) => logs.push(line) })
  return { state, record, file, publish, logs, catalog }
}

const cases = [
  ['retention consumer defaults to 30 days and accepts zero and fractional days', () => {
    const env = { CLAUDE_CONFIG_DIR: fixture().state }
    assert.equal(configuredArtifactRetainMs(env), 30 * DAY)
    for (const days of [0, 0.5, 3650]) assert.equal(configuredArtifactRetainMs({ ...env, WT_ARTIFACT_SERVER_RETAIN_DAYS: String(days) }), days * DAY)
  }],
  ...['-1', 'NaN', 'Infinity', '3651'].map((days) => [
    `retention consumer refuses ${days}`, () => {
      assert.throws(() => configuredArtifactRetainMs({ CLAUDE_CONFIG_DIR: fixture().state, WT_ARTIFACT_SERVER_RETAIN_DAYS: days }), /finite number from 0 to 3650/)
    },
  ]),
  ['record identity is the canonical pathname hash; dotfiles, schema and filename mismatches grant no authority', () => {
    const f = fixture()
    f.publish()
    assert.equal(readRetainedEntries(f.state).size, 1)
    fs.renameSync(f.file, path.join(f.state, 'retained', '.private.json'))
    assert.equal(readRetainedEntries(f.state).size, 0)
    f.publish({ ...f.record, eligible: 'true' })
    assert.equal(readRetainedEntries(f.state).size, 0)
    f.publish({ ...f.record, canonical: f.state })
    assert.equal(readRetainedEntries(f.state).size, 0)
  }],
  ['record readers reject foreign uid and POSIX modes, and skip mode enforcement on Windows', () => {
    const f = fixture()
    f.publish()
    const stat = fs.lstatSync(f.file)
    const uid = typeof process.getuid === 'function' ? process.getuid() + 1 : stat.uid
    const foreign = { ...fs, lstatSync: () => ({ ...stat, isFile: () => true, uid }) }
    if (typeof process.getuid === 'function') assert.equal(readRetainedEntries(f.state, 'retained', foreign).size, 0)
    const insecure = { ...fs, lstatSync: () => ({ ...stat, isFile: () => true, mode: 0o666 }) }
    assert.equal(readRetainedEntries(f.state, 'retained', insecure, 'linux').size, 0)
    assert.equal(readRetainedEntries(f.state, 'retained', insecure, 'win32').size, 1)
  }],
  ['eligibility checks exact window, eligible flag, retention zero and pinned realpath', () => {
    const f = fixture()
    const now = f.record.lastLiveAt + DAY
    assert.equal(retainedRootEligible(f.record, now, DAY), true)
    assert.equal(retainedRootEligible(f.record, now + 1, DAY), false)
    assert.equal(retainedRootEligible({ ...f.record, eligible: false }, now, DAY), false)
    assert.equal(retainedRootEligible(f.record, now, 0), false)
    assert.equal(retainedRootEligible(f.record, now, DAY, { realpathSync: () => f.state }), false)
  }],
  ['live aggregation unions denies, chooses sorted declared path, then preserves an existing valid declared path', () => {
    const f = fixture()
    const catalog = f.catalog()
    const first = { ...f.record, declared: f.record.canonical + path.sep + '.', deny: ['first'] }
    const second = { ...f.record, deny: ['second'] }
    catalog.scan([first, second], new Map(), f.record.lastLiveAt)
    const saved = readRetainedEntries(f.state).get(f.record.canonical)
    assert.deepEqual(saved.deny, ['second', 'first'])
    assert.equal(saved.declared, second.declared)
    catalog.scan([first], new Map(), f.record.lastLiveAt + 1)
    assert.equal(readRetainedEntries(f.state).get(f.record.canonical).declared, second.declared)
  }],
  ['refresh throttles unchanged live observations to min(one hour, retention/24)', () => {
    const f = fixture()
    const catalog = f.catalog()
    const assignments = new Map()
    catalog.scan([f.record], assignments, f.record.lastLiveAt)
    catalog.scan([f.record], assignments, f.record.lastLiveAt + 3_599_999)
    assert.equal(readRetainedEntries(f.state).get(f.record.canonical).lastLiveAt, f.record.lastLiveAt)
    catalog.scan([f.record], assignments, f.record.lastLiveAt + 3_600_000)
    assert.equal(readRetainedEntries(f.state).get(f.record.canonical).lastLiveAt, f.record.lastLiveAt + 3_600_000)
  }],
  ['duplicate seeded names drop both records with one diagnostic before mount allocation', () => {
    const f = fixture()
    f.publish()
    const other = { ...f.record, canonical: f.state, declared: f.state }
    writeRetainedRecord(retainedRootFile(f.state, f.state), other)
    const catalog = f.catalog()
    const assignments = new Map()
    catalog.seed(assignments)
    assert.equal(assignments.size, 0)
    assert.equal(catalog.scan([], assignments).length, 0)
    assert.equal(f.logs.length, 1)
  }],
  ['failed stricter update removes stale policy, cleans its tmp, and cannot resurrect on restart', () => {
    const f = fixture({ ...fs, renameSync: () => { throw new Error('injected rename failure') } })
    f.publish()
    const catalog = f.catalog()
    catalog.scan([{ ...f.record, deny: ['*.secret', 'private'] }], new Map())
    assert.equal(fs.existsSync(f.file), false, 'failed policy update removed the stale record')
    assert.deepEqual(fs.readdirSync(path.dirname(f.file)), [], 'caught write failure unlinks its own temporary file')
    assert.equal(f.catalog().scan([], new Map()).length, 0)
  }],
  ['failed stale-record removal blocks retained serving in memory and retries while live', () => {
    let failure = true
    const f = fixture({ ...fs, renameSync: (...args) => { if (failure) throw new Error('write failed'); return fs.renameSync(...args) },
      rmSync: (file, options) => { if (failure && String(file).endsWith('.json')) throw new Error('remove failed'); fs.rmSync(file, options) } })
    f.publish()
    const catalog = f.catalog()
    catalog.scan([{ ...f.record, deny: ['stricter'] }], new Map())
    assert.equal(fs.existsSync(f.file), true)
    assert.equal(catalog.scan([], new Map()).length, 0, 'stale weaker record is unservable in memory')
    failure = false
    catalog.scan([{ ...f.record, deny: ['stricter'] }], new Map())
    assert.deepEqual(catalog.scan([], new Map())[0].deny, ['stricter'])
  }],
  ['retention zero invalidates live records but leaves other records untouched', () => {
    const f = fixture()
    f.publish()
    const other = { ...f.record, canonical: f.state, declared: f.state, name: 'other' }
    const otherFile = retainedRootFile(f.state, f.state)
    writeRetainedRecord(otherFile, other)
    const catalog = new RetainedRootCatalog(f.state, 0)
    catalog.scan([f.record], new Map())
    assert.equal(fs.existsSync(f.file), false)
    assert.equal(fs.existsSync(otherFile), true)
    assert.equal(catalog.scan([], new Map()).length, 0)
  }],
  ['marker-directory read failure is logged once and cannot skip stricter policy persistence', () => {
    let failure = false
    const f = fixture({ ...fs, readdirSync: (directory) => {
      if (failure && path.basename(directory) === 'forgotten') throw new Error('marker read failed')
      return fs.readdirSync(directory)
    } })
    f.publish()
    const catalog = f.catalog()
    failure = true
    for (let scan = 0; scan < 2; scan++) {
      assert.doesNotThrow(() => catalog.scan([{ ...f.record, deny: ['private.txt'] }], new Map()),
        'marker read failure must not abort policy observation')
    }
    assert.equal(catalog.scan([], new Map()).length, 0, 'unknown markers suppress retained serving')
    failure = false
    assert.deepEqual(catalog.scan([], new Map())[0].deny, ['private.txt'])
    assert.equal(f.logs.filter((line) => line.includes('marker read failed')).length, 1)
  }],
  ['failed update and removal durably fence the stale policy across a fresh catalog restart', () => {
    const f = fixture({ ...fs, renameSync: (from, to) => {
      if (path.basename(path.dirname(to)) === 'retained') throw new Error('record write failed')
      return fs.renameSync(from, to)
    }, rmSync: (file, options) => {
      if (String(file).endsWith('.json')) throw new Error('record removal failed')
      fs.rmSync(file, options)
    } })
    f.publish()
    f.catalog().scan([{ ...f.record, deny: ['private.txt'] }], new Map())
    assert.equal(fs.existsSync(f.file), true, 'weaker record survives the injected removal failure')
    const restarted = new RetainedRootCatalog(f.state, DAY)
    assert.equal(restarted.servedRoots().length, 0, 'fresh catalog must refuse the stale weaker policy before scanning')
    assert.equal(restarted.scan([], new Map()).length, 0)
    const marker = readRetainedEntries(f.state, 'forgotten').get(f.record.canonical)
    assert.ok(marker?.nonce, 'failed invalidation publishes a recovery nonce')
  }],
  ['policy transitions durably publish a recovery nonce before attempting record replacement', () => {
    let recordAttempted = false
    const calls = []
    const f = fixture({ ...fs, renameSync: (from, to) => {
      if (to === f.file) { recordAttempted = true; calls.push('record'); throw new Error('record write failed') }
      if (recordAttempted) throw new Error('post-failure marker write failed')
      calls.push('marker')
      return fs.renameSync(from, to)
    }, rmSync: (file, options) => {
      if (file === f.file) throw new Error('record removal failed')
      fs.rmSync(file, options)
    } })
    f.publish({ ...f.record, deny: ['.env'] })
    const catalog = f.catalog()
    catalog.scan([{ ...f.record, deny: ['.env', 'private.txt'] }], new Map())
    assert.equal(new RetainedRootCatalog(f.state, DAY).servedRoots().length, 0,
      'pre-transition marker must fence the weaker record after restart even when later marker writes fail')
    assert.deepEqual(calls, ['marker', 'record'], 'durable marker publication precedes record replacement')
    assert.equal(catalog.scan([], new Map()).length, 0)
  }],
  ['failed pre-transition marker prevents record replacement and removes older authority', () => {
    let recordWrites = 0
    const f = fixture({ ...fs, renameSync: (from, to) => {
      if (path.basename(path.dirname(to)) === 'forgotten') throw new Error('pre-marker failed')
      recordWrites++
      return fs.renameSync(from, to)
    } })
    f.publish()
    f.catalog().scan([{ ...f.record, deny: ['private.txt'] }], new Map())
    assert.equal(recordWrites, 0, 'failed recovery prerequisite must prevent new record writes')
    assert.equal(fs.existsSync(f.file), false, 'failed prerequisite removes the older authority')
    assert.equal(new RetainedRootCatalog(f.state, DAY).servedRoots().length, 0)
  }],
  ['unknown marker state blocks retained roots at construction and scans while live roots remain served', () => {
    let failure = true
    const f = fixture({ ...fs, readdirSync: (directory) => {
      if (failure && path.basename(directory) === 'forgotten') throw new Error('unknown markers')
      return fs.readdirSync(directory)
    } })
    f.publish()
    const marker = { canonical: f.record.canonical, name: f.record.name, nonce: randomUUID(), at: Date.now() }
    writeRetainedRecord(retainedRootFile(f.state, marker.canonical, 'forgotten'), marker)
    const catalog = f.catalog()
    assert.equal(catalog.servedRoots().length, 0, 'constructor must not treat unknown recovery state as empty')
    assert.equal(catalog.scan([], new Map()).length, 0)
    assert.equal(catalog.scan([f.record], new Map())[0].retained, false, 'unknown markers do not suppress live roots')
    assert.equal(catalog.scan([], new Map()).length, 0)
    failure = false
    catalog.scan([f.record], new Map())
    assert.equal(catalog.scan([], new Map()).length, 1, 'successful reconciliation restores acknowledged eligibility')
  }],
  ...['read', 'schema', 'mode', 'identity'].map((fault) => [
    `unreadable or invalid marker-pattern file makes marker state unknown: ${fault}`, () => {
      const f = fixture()
      f.publish()
      const canonical = f.record.canonical
      const markerFile = retainedRootFile(f.state, canonical, 'forgotten')
      const marker = { canonical, name: f.record.name, nonce: randomUUID(), at: Date.now() }
      writeRetainedRecord(markerFile, fault === 'schema' ? { ...marker, nonce: false } : marker)
      const io = { ...fs, readFileSync: (file, ...args) => {
        if (file === markerFile && fault === 'read') throw new Error('unreadable marker')
        if (file === markerFile && fault === 'identity') return JSON.stringify({ ...marker, canonical: f.state })
        return fs.readFileSync(file, ...args)
      }, lstatSync: (file) => {
        const stat = fs.lstatSync(file)
        return file === markerFile && fault === 'mode' ? { ...stat, isFile: () => false } : stat
      } }
      const catalog = new RetainedRootCatalog(f.state, DAY, { io, log: () => {} })
      assert.equal(catalog.servedRoots().length, 0, 'an unreadable or invalid marker cannot grant retained authority')
      assert.equal(catalog.scan([], new Map()).length, 0)
    },
  ]),
  ['previously known pending markers survive a failed read and recover without granting authority', () => {
    let failure = false
    const f = fixture({ ...fs, readdirSync: (directory) => {
      if (failure && path.basename(directory) === 'forgotten') throw new Error('temporary marker failure')
      return fs.readdirSync(directory)
    } })
    f.publish()
    const marker = { canonical: f.record.canonical, name: f.record.name, nonce: randomUUID(), at: Date.now() }
    writeRetainedRecord(retainedRootFile(f.state, marker.canonical, 'forgotten'), marker)
    const catalog = f.catalog()
    failure = true
    assert.equal(catalog.scan([], new Map()).length, 0, 'pending forget remains denied during read failure')
    assert.equal(catalog.markers.get(marker.canonical)?.nonce, marker.nonce, 'last known marker survives unknown state')
    failure = false
    assert.equal(catalog.scan([], new Map()).length, 0)
  }],
  ['pending forget markers suppress retained serving before the first scan', () => {
    const f = fixture()
    f.publish()
    const marker = { canonical: f.record.canonical, name: f.record.name, nonce: randomUUID(), at: Date.now() }
    writeRetainedRecord(retainedRootFile(f.state, marker.canonical, 'forgotten'), marker)
    const catalog = f.catalog()
    assert.equal(catalog.servedRoots().length, 0, 'pending nonce blocks retained authority before the first scan')
    catalog.scan([f.record], new Map())
    assert.equal(catalog.scan([], new Map()).length, 1, 'live observation acknowledges the pending nonce')
  }],
  ['invalidation syncs the retained directory after removal on POSIX', () => {
    const calls = []
    const f = fixture({ ...fs, rmSync: (...args) => { calls.push('remove'); fs.rmSync(...args) },
      fsyncSync: (fd) => { calls.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'); fs.fsyncSync(fd) } })
    f.publish()
    const catalog = new RetainedRootCatalog(f.state, 0, { io: f.catalog().io })
    catalog.scan([f.record], new Map())
    assert.deepEqual(calls, process.platform === 'win32' ? ['remove'] : ['remove', 'directory'],
      'successful invalidation must sync the containing directory after unlink')
  }],
  ['failed invalidation directory sync publishes a durable marker and keeps an in-memory block', () => {
    if (process.platform === 'win32') return
    const retainedDescriptors = new Set()
    const f = fixture({ ...fs, openSync: (file, ...args) => {
      const fd = fs.openSync(file, ...args)
      if (file === path.dirname(f.file)) retainedDescriptors.add(fd)
      else retainedDescriptors.delete(fd)
      return fd
    }, fsyncSync: (fd) => {
      if (retainedDescriptors.has(fd)) throw new Error('retained directory sync failed')
      fs.fsyncSync(fd)
    } })
    f.publish()
    const catalog = f.catalog()
    catalog.invalidate(f.record.canonical)
    assert.equal(catalog.blocked.has(f.record.canonical), true, 'failed removal sync leaves invalidation unresolved')
    assert.ok(readRetainedEntries(f.state, 'forgotten').has(f.record.canonical), 'failed removal sync writes a recovery marker')
    f.publish() // Model a directory entry surviving power loss without claiming to simulate a filesystem crash.
    assert.equal(new RetainedRootCatalog(f.state, DAY).servedRoots().length, 0)
  }],
  ['failed record removal is retried after the root stops being live', () => {
    let removalFails = true
    const f = fixture({ ...fs, renameSync: () => { throw new Error('write failed') },
      rmSync: (file, options) => { if (removalFails && String(file).endsWith('.json')) throw new Error('remove failed'); fs.rmSync(file, options) } })
    f.publish()
    const catalog = f.catalog()
    catalog.scan([{ ...f.record, deny: ['stricter'] }], new Map())
    assert.equal(fs.existsSync(f.file), true)
    removalFails = false
    catalog.scan([], new Map())
    assert.equal(fs.existsSync(f.file), false, 'next scan retries a failed removal even after departure')
  }],
  ['forget nonces apply once, ignore clocks and keep live roots eligible', () => {
    const f = fixture()
    f.publish()
    const marker = { canonical: f.record.canonical, name: 'reports', nonce: randomUUID(), at: 0 }
    const file = retainedRootFile(f.state, marker.canonical, 'forgotten')
    fs.writeFileSync(file, JSON.stringify(marker), { mode: 0o600 })
    const catalog = f.catalog()
    catalog.scan([f.record], new Map())
    assert.equal(catalog.scan([], new Map()).length, 1)
    assert.equal(f.logs.length, 1)
    fs.writeFileSync(file, JSON.stringify({ ...marker, nonce: randomUUID() }))
    assert.equal(catalog.scan([], new Map()).length, 0)
    assert.equal(f.catalog().scan([], new Map()).length, 0)
  }],
  ['durable writer syncs the file before rename and the directory afterwards; Windows skips directory fsync', () => {
    for (const platform of process.platform === 'win32' ? ['win32'] : ['linux', 'win32']) {
      const f = fixture()
      const calls = []
      const io = { ...fs, fsyncSync: (fd) => { calls.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'); fs.fsyncSync(fd) },
        renameSync: (...args) => { calls.push('rename'); fs.renameSync(...args) } }
      writeRetainedRecord(f.file, f.record, io, platform)
      assert.deepEqual(calls, platform === 'win32' ? ['file', 'rename'] : ['file', 'rename', 'directory'])
    }
  }],
  ['writer cleans temporary files on open, write, chmod, fsync and rename errors', () => {
    for (const operation of ['openSync', 'writeFileSync', 'fchmodSync', 'fsyncSync', 'renameSync']) {
      const f = fixture()
      const io = { ...fs, [operation]: () => { throw new Error(operation) } }
      assert.throws(() => writeRetainedRecord(f.file, f.record, io, 'linux'), new RegExp(operation))
      assert.deepEqual(fs.readdirSync(path.dirname(f.file)), [])
    }
  }],
]

export function registerRetainedRootUnitTests(hooks) {
  hooks.afterEach(() => { for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
  for (const [name, run] of cases) hooks.test(name, run)
}

if (isInvokedDirectly(import.meta.url)) registerRetainedRootUnitTests({ test, afterEach })
