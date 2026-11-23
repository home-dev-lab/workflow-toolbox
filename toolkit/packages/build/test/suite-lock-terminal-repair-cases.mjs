import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const bin = process.env.WT_TERMINAL_MODULE_ROOT
  ? pathToFileURL(`${process.env.WT_TERMINAL_MODULE_ROOT}/`)
  : new URL('../../../../plugin/bin/', import.meta.url)
const journal = await import(new URL('lib/host/suite-lock-journal-append.mjs', bin))
const lock = await import(new URL('lib/suite-lock.mjs', bin))
const identity = await import(new URL('lib/host/pid-namespace.mjs', bin))
const recovery = await import(new URL('lib/host/suite-lock-recovery.mjs', bin))
let spawnChild = spawn
export const setTerminalRepairSpawn = (implementation) => { spawnChild = implementation }
const owner = () => ({ pid: process.pid, platform: process.platform,
  startTime: identity.processStartTime(process.pid), pidNamespace: identity.currentPidNamespace() })
const lines = (root, id) => journal.suiteJournalLines(root).filter((line) => JSON.parse(line).leaseId === id)
const age = (file, hours) => { const time = new Date(Date.now() - hours * 3_600_000); fs.utimesSync(file, time, time) }

async function pass(root) {
  const lease = await lock.acquireSuiteLock({ root, env: { WT_SUITE_LOCK_STATIC_LANE: '0' } })
  lock.releaseSuiteLock(lease)
}

// The base has no terminal scan: exercise its existing queue pass for red proofs.
async function terminalPass(root) {
  if (recovery.reapSuiteTerminals) recovery.reapSuiteTerminals(root)
  else await pass(root)
}

function seed(root, { complete = false, hours = 25, dead = false } = {}) {
  const id = randomUUID()
  const directory = join(root, 'terminal.d')
  fs.mkdirSync(directory, { recursive: true })
  const event = { event: 'abort', leaseId: id, cause: 'stored-original' }
  const line = `${JSON.stringify(event)}\n`
  const creator = { ...owner(), ...(dead ? { pid: 2147483647 } : {}) }
  fs.writeFileSync(join(directory, id), JSON.stringify({ creator, line }))
  age(join(directory, id), hours)
  if (complete) { fs.writeFileSync(join(directory, `${id}.written`), ''); age(join(directory, `${id}.written`), hours) }
  return { id, line, file: join(directory, id) }
}

async function pausedCreator(root, stage = 'claim') {
  const id = randomUUID()
  const file = join(root, 'terminal.d', id)
  const source = `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';
    const pause=()=>{process.send('claimed');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)};
    const append=fs.writeSync;fs.writeSync=(fd,...args)=>{const result=append(fd,...args);
      if(${JSON.stringify(stage)}==='append'&&Buffer.isBuffer(args[0])&&args[0].toString().startsWith('{"event":"abort"'))pause();return result};
    const write=fs.writeFileSync;fs.writeFileSync=(file,...args)=>{const result=write(file,...args);
      if(${JSON.stringify(stage)}==='claim'&&file===${JSON.stringify(file)})pause();return result};
    syncBuiltinESMExports();const journal=await import(${JSON.stringify(new URL('lib/host/suite-lock-journal-append.mjs', bin).href)});
    journal.appendSuiteLockJournal(${JSON.stringify(root)},{event:'abort',leaseId:${JSON.stringify(id)},cause:'crash-original'})`
  const child = spawnChild(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  try {
    await Promise.race([new Promise((resolve) => child.once('message', resolve)), exited.then(() => { throw new Error('creator exited before claim') })])
    return { id, file, child, exited, timer }
  } catch (error) { clearTimeout(timer); child.kill('SIGKILL'); await exited; throw error }
}

async function postAppendCrash(root) {
  const run = await pausedCreator(root, 'append')
  try {
    assert.equal(fs.existsSync(`${run.file}.written`), false, 'fault must interrupt before completion')
    run.child.kill('SIGKILL')
    await run.exited
    assert.throws(() => process.kill(run.child.pid, 0), { code: 'ESRCH' })
    await terminalPass(root)
    assert.equal(lines(root, run.id).length, 1, 'crash after append must complete without a second line')
    assert.equal(fs.existsSync(`${run.file}.written`), true)
  } finally { clearTimeout(run.timer); run.child.kill('SIGKILL'); await run.exited }
}

async function crashRepair(root) {
  const run = await pausedCreator(root)
  try {
    await terminalPass(root)
    assert.equal(lines(root, run.id).length, 0, 'live creator must never be repaired')
    run.child.kill('SIGKILL')
    await run.exited
    assert.throws(() => process.kill(run.child.pid, 0), { code: 'ESRCH' })
    const stored = JSON.parse(fs.readFileSync(run.file, 'utf8') || '{}')
    await terminalPass(root)
    assert.equal(lines(root, run.id).length, 1, 'lock 1: killed creator must recover exactly one terminal line')
    assert.equal(`${lines(root, run.id)[0]}\n`, stored.line, 'repair must preserve the full stored line')
    await terminalPass(root)
    assert.equal(lines(root, run.id).length, 1, 'second reaper pass must not duplicate the terminal')
  } finally { clearTimeout(run.timer); run.child.kill('SIGKILL'); await run.exited }
}

async function retention(root) {
  const old = seed(root, { complete: true })
  const recent = seed(root, { complete: true, hours: 1 })
  const live = seed(root)
  const dead = seed(root, { dead: true })
  await terminalPass(root)
  assert.equal(fs.existsSync(old.file), false, 'lock 2: reaper must prune complete sets older than 24 hours')
  assert.equal(fs.existsSync(`${old.file}.written`), false, 'pruning must remove completion too')
  for (const entry of [recent, live, dead]) assert.equal(fs.existsSync(entry.file), true, 'recent and pending sets must stay')
  assert.equal(lines(root, live.id).length, 0, 'old live pending marker must not be repaired')
  assert.deepEqual(lines(root, dead.id), [dead.line.trimEnd()], 'dead pending marker must be repaired exactly')
  assert.ok(Date.now() - fs.statSync(`${dead.file}.written`).mtimeMs < 60_000, 'repair starts its own retention window')
}

function repairClaim(file, creator) {
  fs.mkdirSync(`${file}.repair`)
  fs.writeFileSync(join(`${file}.repair`, 'owner.json'), JSON.stringify({ ...creator, token: randomUUID() }))
}

function interruptedRepair(root) {
  const entry = seed(root, { dead: true })
  fs.writeFileSync(join(root, 'journal.1.jsonl'), entry.line)
  repairClaim(entry.file, { ...owner(), pid: 2147483647 })
  recovery.reapSuiteTerminals(root)
  assert.deepEqual(lines(root, entry.id), [entry.line.trimEnd()], 'dead repair takeover must detect the previous generation')
  assert.equal(fs.existsSync(`${entry.file}.written`), true, 'takeover must finish the interrupted repair')
  assert.equal(fs.existsSync(`${entry.file}.repair`), false, 'successful repair releases its active claim')
  age(`${entry.file}.written`, 25)
  recovery.reapSuiteTerminals(root)
  assert.equal(fs.readdirSync(join(root, 'terminal.d')).some((name) => name.startsWith(entry.id)), false, 'pruning must remove retired claims too')
}

function liveRepair(root) {
  const entry = seed(root, { dead: true })
  repairClaim(entry.file, owner())
  age(`${entry.file}.repair`, 25)
  recovery.reapSuiteTerminals(root)
  assert.deepEqual(lines(root, entry.id), [], 'live repair owner must exclude other repairers regardless of age')
  assert.equal(fs.existsSync(`${entry.file}.repair`), true)
  fs.writeFileSync(`${entry.file}.written`, '')
  age(`${entry.file}.written`, 25)
  recovery.reapSuiteTerminals(root)
  assert.equal(fs.existsSync(entry.file), true, 'even old complete sets with a live repair claim must stay')
}

function cheapScan(root) {
  assert.doesNotThrow(() => recovery.reapSuiteTerminals(root), 'missing terminal.d is a normal empty pass')
  seed(root)
  const readDirectory = fs.readdirSync
  const read = fs.readFileSync
  let scans = 0
  let journalReads = 0
  try {
    fs.readdirSync = (file, ...args) => { if (file === join(root, 'terminal.d')) scans++; return readDirectory(file, ...args) }
    fs.readFileSync = (file, ...args) => { if (/journal(?:\.1)?\.jsonl$/.test(String(file))) journalReads++; return read(file, ...args) }
    syncBuiltinESMExports()
    recovery.reapSuiteTerminals(root)
  } finally { fs.readdirSync = readDirectory; fs.readFileSync = read; syncBuiltinESMExports() }
  assert.equal(scans, 1, 'reaper must read terminal.d exactly once per pass')
  assert.equal(journalReads, 0, 'live pending sets must not cause journal reads')
}

async function queueIntegration(root) {
  const entry = seed(root, { dead: true })
  await pass(root)
  assert.deepEqual(lines(root, entry.id), [entry.line.trimEnd()], 'queue placement must invoke terminal recovery')
}

function completedDeadRepair(root) {
  const entry = seed(root, { complete: true })
  repairClaim(entry.file, { ...owner(), pid: 2147483647 })
  recovery.reapSuiteTerminals(root)
  assert.equal(fs.existsSync(entry.file), true, 'repair-claimed complete sets are not pruned by age')
  recovery.reapSuiteTerminals(root)
  assert.equal(fs.readdirSync(join(root, 'terminal.d')).some((name) => name.startsWith(entry.id)), false,
    'next snapshot must collect the retired dead repair together with the complete set')
}

function interruptedPrune(root) {
  const entry = seed(root, { complete: true })
  const remove = fs.rmSync
  try {
    fs.rmSync = (file, ...args) => {
      if (file === `${entry.file}.written`) throw Object.assign(new Error('interrupted prune'), { code: 'EACCES' })
      return remove(file, ...args)
    }
    syncBuiltinESMExports()
    recovery.reapSuiteTerminals(root)
  } finally { fs.rmSync = remove; syncBuiltinESMExports() }
  assert.equal(fs.existsSync(entry.file), false, 'fault must interrupt after claim removal')
  assert.equal(fs.existsSync(`${entry.file}.written`), true, 'completion must remain until cleanup finishes')
  recovery.reapSuiteTerminals(root)
  assert.equal(fs.existsSync(`${entry.file}.written`), false, 'a later scan must collect an interrupted completed prune')
}

function rotationDuringRead(root) {
  const entry = seed(root, { dead: true })
  fs.writeFileSync(join(root, 'journal.jsonl'), entry.line + JSON.stringify({ event: 'padding', text: 'x'.repeat(journal.SUITE_JOURNAL_ROTATE_BYTES) }) + '\n')
  const read = fs.readFileSync
  let triggered = false
  try {
    fs.readFileSync = (file, ...args) => {
      try { return read(file, ...args) } finally {
        if (file === join(root, 'journal.1.jsonl') && !triggered) {
          triggered = true
          journal.appendSuiteLockJournal(root, { event: 'request' })
        }
      }
    }
    syncBuiltinESMExports()
    recovery.reapSuiteTerminals(root)
  } finally { fs.readFileSync = read; syncBuiltinESMExports() }
  assert.equal(triggered, true, 'fault must attempt rotation between generation reads')
  assert.deepEqual(lines(root, entry.id), [entry.line.trimEnd()], 'rotation during repair read must not hide the original line')
  assert.equal(fs.existsSync(`${entry.file}.written`), true)
}

async function concurrentRepair(root) {
  const entry = seed(root, { dead: true })
  repairClaim(entry.file, { ...owner(), pid: 2147483647 })
  const source = `import{reapSuiteTerminals}from ${JSON.stringify(new URL('lib/host/suite-lock-terminal-repair.mjs', bin).href)};
    process.on('message',()=>{for(let n=0;n<4;n++)reapSuiteTerminals(${JSON.stringify(root)});process.disconnect()});process.send('ready')`
  const runs = Array.from({ length: 4 }, () => {
    const child = spawnChild(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    const ready = new Promise((resolve) => child.once('message', resolve))
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`repairer exit ${code}`))) })
    return { child, ready: Promise.race([ready, exited.then(() => { throw new Error('repairer exited before ready') })]), exited }
  })
  const timer = setTimeout(() => runs.forEach(({ child }) => child.kill('SIGKILL')), 10_000)
  try {
    await Promise.all(runs.map(({ ready }) => ready))
    runs.forEach(({ child }) => child.send('repair'))
    await Promise.all(runs.map(({ exited }) => exited))
    assert.deepEqual(lines(root, entry.id), [entry.line.trimEnd()], 'concurrent abandoned-claim takeovers must append exactly once')
    assert.equal(fs.existsSync(`${entry.file}.written`), true)
  } finally {
    clearTimeout(timer)
    runs.forEach(({ child }) => { if (child.exitCode === null) child.kill('SIGKILL') })
    await Promise.allSettled(runs.map(({ exited }) => exited))
  }
}

// A creator killed inside the claim's own write leaves an empty or partial file: no identity,
// no stored line. It must not pin terminal.d forever, and a recent one must not be touched.
async function unreadableClaim(root) {
  const directory = join(root, 'terminal.d')
  fs.mkdirSync(directory, { recursive: true })
  const claims = { emptyOld: [randomUUID(), '', 25], partialOld: [randomUUID(), '{"creator":{"pid"', 25], emptyRecent: [randomUUID(), '', 1] }
  for (const [id, content, hours] of Object.values(claims)) { fs.writeFileSync(join(directory, id), content); age(join(directory, id), hours) }
  await terminalPass(root)
  assert.equal(fs.existsSync(join(directory, claims.emptyOld[0])), false, 'unreadable claim older than 24 hours must be pruned')
  assert.equal(fs.existsSync(join(directory, claims.partialOld[0])), false, 'partial claim older than 24 hours must be pruned')
  assert.equal(fs.existsSync(join(directory, claims.emptyRecent[0])), true, 'recent unreadable claim must stay')
  for (const [id] of Object.values(claims)) assert.equal(lines(root, id).length, 0, 'an unreadable claim has no line to repair')
}

export const terminalRepairCases = {
  'unreadable claim from a crash inside its own write is bounded': unreadableClaim,
  'lock 1 crash repair and live creator exclusion': crashRepair,
  'lock 2 completion-based reaper retention': retention,
  'crash after append and before completion': postAppendCrash,
  'dead repair takeover preserves a line in the previous generation': interruptedRepair,
  'live repair claims exclude repair and age pruning': liveRepair,
  'one cheap terminal scan per reaper pass': cheapScan,
  'queue placement integrates terminal recovery': queueIntegration,
  'completed dead repair retirement leaves no orphan files': completedDeadRepair,
  'interrupted retention cleanup remains collectible': interruptedPrune,
  'rotation cannot hide a line between generation reads': rotationDuringRead,
  'concurrent abandoned repair claim takeovers': concurrentRepair,
}
