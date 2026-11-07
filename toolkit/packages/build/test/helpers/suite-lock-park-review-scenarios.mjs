import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const asideReference = readFileSync(new URL('./suite-lock-park-asides-before-split.txt', import.meta.url), 'utf8')
const { beforeSplit } = await import('data:text/javascript;base64,' + Buffer.from(asideReference).toString('base64'))

async function fixture(cli, action) {
  const root = mkdtempSync(join(tmpdir(), 'wt-park-review-'))
  const directory = join(root, 'private')
  mkdirSync(directory, { mode: 0o700 })
  writeFileSync(join(directory, 'key'), 'review-key-with-at-least-thirty-two-bytes')
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (/^WT_SUITE_(?:LOCK(?:_|$)|LEASE(?:_|$))/i.test(name)) delete env[name]
  env.WT_SUITE_LOCK_DIR = root
  const flags = ['--park-dir', directory, '--park-s', '60', '--park-owner-pid', String(process.pid)]
  const run = (args = flags, script = '') => spawnSync(process.execPath, [cli, 'run', ...args, '--', process.execPath, '-e', script], { env, encoding: 'utf8', timeout: 3000 })
  const load = (name) => import(pathToFileURL(join(dirname(cli), 'lib', name)).href)
  const { acquireSuiteLock, releaseSuiteLock, readSuiteLockStatus } = await load('suite-lock.mjs')
  const { parseParkOptions } = await load('suite-lock-park.mjs')
  const context = parseParkOptions([...flags], env)
  const queue = join(root, 'queue.d')
  const file = (number, extension = 'parked') => join(queue, `${String(number).padStart(16, '0')}.${extension}`)
  const park = () => {
    assert.equal(run(flags, 'require("fs").writeFileSync(process.env.WT_SUITE_LOCK_PARK_REQUEST,"busy")').status, 0)
    const named = JSON.parse(readFileSync(join(directory, 'parked.json'), 'utf8'))
    return { ...named, data: JSON.parse(readFileSync(file(named.number), 'utf8')) }
  }
  const acquire = (options = {}) => acquireSuiteLock({ root, env, waitS: 1, pollMs: 5, ...options })
  try { return await action({ root, directory, env, flags, run, load, context, queue, file, park, acquire, release: releaseSuiteLock, status: () => readSuiteLockStatus({ root }) }) } finally { rmSync(root, { recursive: true, force: true }) }
}

function waitingChild(cli, f, signal) {
  const child = spawn(process.execPath, [cli, 'run', ...f.flags, '--', process.execPath, '-e', ''], { env: f.env, stdio: ['ignore', 'ignore', 'pipe'] })
  const exit = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject) })
  const ready = new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => reject(new Error('waiter never queued')), 3000)
    child.stderr.on('data', (chunk) => {
      text += chunk
      if (!text.includes('waiting for suite lock:')) return
      clearTimeout(timer)
      if (signal) child.kill(signal)
      resolve()
    })
  })
  return { child, ready, exit }
}

export const parkReviewScenarios = {
  'does not publish a partial attempt claim when its write is interrupted': async (cli) => fixture(cli, async (f) => {
    const script = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
      const original=fs.writeFileSync;fs.writeFileSync=function(file,content,options){
        if(file===${JSON.stringify(join(f.directory, 'attempt'))}){original(file,'',options);throw Object.assign(new Error('interrupted claim write'),{code:'EIO'})}
        return original.call(this,file,content,options)};syncBuiltinESMExports();
      const {runSuiteLockCliEntrypoint}=await import(${JSON.stringify(pathToFileURL(cli).href)});
      process.exitCode=await runSuiteLockCliEntrypoint(${JSON.stringify(['run', ...f.flags, '--', process.execPath, '-e', ''])})`
    const first = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: f.env, encoding: 'utf8', timeout: 3000 })
    assert.equal(first.error, undefined)
    assert.equal(f.run().status, 0, 'an interrupted attempt publication must not poison subsequent attempts')
  }),
  'tolerates an unavailable SIGQUIT handler': async (cli) => fixture(cli, async (f) => {
    const { watchParkWait, watchParkChildSignals } = await f.load('host/suite-lock-park-files.mjs')
    const once = process.once
    process.once = function (signal, handler) {
      if (signal === 'SIGQUIT') throw Object.assign(new Error('unsupported signal'), { code: 'EINVAL' })
      return once.call(this, signal, handler)
    }
    try {
      assert.doesNotThrow(() => watchParkWait().close(), 'uncatchable SIGQUIT must not prevent park acquisition')
      assert.doesNotThrow(() => watchParkChildSignals(() => {})(), 'uncatchable SIGQUIT must not prevent a leased child')
    } finally { process.once = once }
  }),
  'matches aside recovery before extraction across outputs errors effects and calls': async (cli) => fixture(cli, async (f) => {
    const { readParkJson, recoverParkAsides } = await f.load('host/suite-lock-park-files.mjs')
    const cases = ['dead', 'live', 'unknown-old', 'unknown-young', 'expired', 'parked', 'claimed', 'owner-throws', 'live-throws', 'unreadable', 'directory', 'missing']
    for (const kind of cases) {
      const expected = observeAsideRecovery(f.root, 'before', kind, beforeSplit(readParkJson))
      const actual = observeAsideRecovery(f.root, 'after', kind, recoverParkAsides)
      assert.deepEqual(actual, expected, `aside recovery extraction must match every observation: ${kind}`)
    }
  }),
  'retains an old but live attempt claim without a silence timeout': async (cli) => fixture(cli, async (f) => {
    const claim = join(f.directory, 'attempt')
    writeFileSync(claim, JSON.stringify({ ...f.context.owner, nonce: 'live-attempt' }))
    const old = new Date(Date.now() - 180_000)
    utimesSync(claim, old, old)
    const result = f.run()
    assert.equal(result.status, 2, 'a live attempt cannot be reclaimed merely because it is old')
    assert.match(result.stderr, /another attempt holds this park directory/)
    assert.equal(JSON.parse(readFileSync(claim, 'utf8')).nonce, 'live-attempt')
  }),
  'takes over an attempt whose process is proven gone': async (cli) => fixture(cli, async (f) => {
    writeFileSync(join(f.directory, 'attempt'), JSON.stringify({ ...f.context.owner, pid: 2_147_483_647, nonce: 'dead-attempt' }))
    assert.equal(f.run().status, 0, 'a dead attempt claim can be taken over')
    assert(!existsSync(join(f.directory, 'attempt')))
  }),
  'takes over a Linux attempt after proven PID reuse': async (cli) => fixture(cli, async (f) => {
    writeFileSync(join(f.directory, 'attempt'), JSON.stringify({ ...f.context.owner, startTime: -1, nonce: 'reused-attempt' }))
    assert.equal(f.run().status, 0, 'attempt takeover uses process start time, not PID alone')
    assert(!existsSync(join(f.directory, 'attempt')))
  }),
  'serializes attempts before stale-pointer cleanup': async (cli) => fixture(cli, async (f) => {
    const parked = f.park()
    const blocker = await f.acquire()
    const waiting = waitingChild(cli, f)
    try {
      await waiting.ready
      writeFileSync(f.file(parked.number + 10), JSON.stringify({ ...parked.data, nonce: 'new-generation' }))
      const second = f.run([...f.flags, '--wait-s', '0'])
      assert.equal(second.status, 2, 'another concurrent attempt must be refused before cleanup')
      assert.match(second.stderr, /another attempt holds this park directory/)
      assert(existsSync(f.file(parked.number + 10)), 'a refused second attempt cannot clean a newer park')
    } finally { waiting.child.kill('SIGTERM'); await waiting.exit; f.release(blocker) }
    assert(!existsSync(join(f.directory, 'attempt')), 'the completed attempt releases its claim')
  }),
  'rechecks the resumed claim after winning the mutex': async (cli) => fixture(cli, async (f) => {
    const parked = f.park()
    let lease
    try {
      await assert.rejects(async () => { lease = await f.acquire({ park: f.context, beforePublish: () => writeFileSync(f.file(parked.number, 'json'), JSON.stringify({ ...parked.data.record, leaseId: 'replacement' })) }) }, { code: 'WT_SUITE_LOCK_UNAVAILABLE' }, 'admission must reject a replaced resumed claim after winning the mutex')
      assert(!existsSync(join(f.root, 'lock.d')), 'failed claim confirmation hands back the provisional lease')
    } finally { if (lease) f.release(lease) }
  }),
  'retains parked allocation markers beyond the pruning horizon': async (cli) => fixture(cli, async (f) => {
    const parked = f.park()
    const { takeTicket } = await f.load('host/suite-lock-queue.mjs')
    for (let i = 0; i < 260; i++) rmSync(f.file(takeTicket(f.queue, parked.data.record), 'json'))
    assert(existsSync(f.file(parked.number, 'ticket')), 'a parked number marker must survive pruning beyond 256 allocations')
  }),
  'recovers a live park left aside by a dead reclaimer': async (cli) => fixture(cli, async (f) => {
    const parked = f.park()
    const identity = Buffer.from(JSON.stringify({ pid: 2_147_483_647, startTime: null, pidNamespace: f.context.owner.pidNamespace })).toString('hex')
    const aside = f.file(parked.number) + '.reclaimed-' + identity + '.probe'
    renameSync(f.file(parked.number), aside)
    assert.equal(f.run([]).status, 0)
    assert(existsSync(f.file(parked.number)), 'a live nonce left by a dead reclaimer must be restored')
    assert(!existsSync(aside), 'a recovered aside must be removed')
    assert.equal(JSON.parse(readFileSync(f.file(parked.number), 'utf8')).nonce, parked.nonce)
  }),
  'removes expired and unknown old reclaimer asides without replacing a current claim': async (cli) => fixture(cli, async (f) => {
    const parked = f.park()
    const aside = f.file(parked.number) + '.reclaimed-unknown'
    writeFileSync(aside, JSON.stringify(parked.data))
    const old = new Date(Date.now() - 61_000)
    utimesSync(aside, old, old)
    assert.equal(f.run([]).status, 0)
    assert(!existsSync(aside), 'unknown old reclaimer asides must be removed')
    assert.equal(JSON.parse(readFileSync(f.file(parked.number), 'utf8')).nonce, parked.nonce)
  }),
  'cleans up a resumed wait on SIGHUP': async (cli) => signalScenario(cli, 'SIGHUP', 129),
  'cleans up a resumed wait on SIGQUIT': async (cli) => signalScenario(cli, 'SIGQUIT', 131),
  'forwards SIGHUP to a leased child and finalizes its park': async (cli) => fixture(cli, async (f) => {
    const script = 'require("fs").writeFileSync(process.env.WT_SUITE_LOCK_PARK_REQUEST,"signal park");console.log(process.pid);setInterval(()=>{},1000)'
    const child = spawn(process.execPath, [cli, 'run', ...f.flags, '--', process.execPath, '-e', script], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const exit = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
    let coveredPid
    child.stdout.once('data', (chunk) => { coveredPid = Number(String(chunk).trim()); child.kill('SIGHUP') })
    try {
      assert.equal(await exit, 129, 'SIGHUP must finalize a granted park after forwarding to the child')
      assert.match(readFileSync(join(f.directory, 'outcome'), 'utf8'), /^parked /)
      assert(!existsSync(join(f.root, 'lock.d')))
    } finally { child.kill('SIGKILL'); if (coveredPid) { try { process.kill(coveredPid, 'SIGKILL') } catch { /* already stopped */ } } }
  }),
  'scopes same-key cleanup to the full owner identity': async (cli) => fixture(cli, async (f) => {
    const parked = f.park()
    rmSync(join(f.directory, 'parked.json'))
    const { resumeParkedTicket } = await f.load('suite-lock-park.mjs')
    for (const field of ['pid', 'startTime', 'pidNamespace']) {
      const context = structuredClone(f.context)
      context.owner[field] = field === 'pidNamespace' ? 'different namespace' : -1
      resumeParkedTicket(f.queue, { leaseId: 'other-owner' }, context, Date.now(), () => false)
      assert(existsSync(f.file(parked.number)), `same-key cleanup must preserve a different owner (${field})`)
    }
  }),
  'publishes an outcome when the request is a directory': async (cli) => fixture(cli, async (f) => {
    const result = f.run(f.flags, 'require("fs").mkdirSync(process.env.WT_SUITE_LOCK_PARK_REQUEST)')
    assert.equal(result.status, 0, 'a non-regular request is ignored without failing the child outcome')
    assert.equal(readFileSync(join(f.directory, 'outcome'), 'utf8'), 'not-parked\n', 'request cleanup failure must not prevent the outcome')
    assert.match(result.stderr, /request.*regular|regular.*request/)
    assert(!existsSync(join(f.root, 'lock.d')))
  }),
  'ignores FIFO park and request files without blocking': async (cli) => fixture(cli, async (f) => {
    f.park()
    const fifo = f.file(123)
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0)
    const ordinary = f.run([])
    assert.equal(ordinary.error, undefined, 'a FIFO park artifact must not block ordinary admission')
    assert.equal(ordinary.status, 0)
  }),
  'ignores a FIFO request without blocking finalization': async (cli) => fixture(cli, async (f) => {
    const result = f.run(f.flags, 'require("child_process").execFileSync("mkfifo",[process.env.WT_SUITE_LOCK_PARK_REQUEST])')
    assert.equal(result.error, undefined, 'a FIFO request must not block lease finalization')
    assert.equal(result.status, 0)
    assert.equal(readFileSync(join(f.directory, 'outcome'), 'utf8'), 'not-parked\n')
  }),
  'ignores symlink and oversized park records': async (cli) => fixture(cli, async (f) => {
    const parked = f.park()
    renameSync(f.file(parked.number), join(f.root, 'target'))
    symlinkSync(join(f.root, 'target'), f.file(parked.number))
    assert.deepEqual(f.status().parked, [], 'park reads must not follow symlinks')
  }),
  'ignores oversized park records': async (cli) => fixture(cli, async (f) => {
    const parked = f.park()
    rmSync(f.file(parked.number))
    writeFileSync(f.file(parked.number), JSON.stringify(parked.data) + ' '.repeat(70_000))
    assert.deepEqual(f.status().parked, [], 'park reads must be size bounded')
  }),
  'admits ordinary runs despite failed park reclamation': async (cli) => fixture(cli, async (f) => {
    f.park()
    mkdirSync(f.file(123))
    const old = new Date(Date.now() - 11_000)
    utimesSync(f.file(123), old, old)
    const result = f.run([])
    assert.equal(result.status, 0, 'park reclamation errors must not abort ordinary admission')
    assert.match(result.stderr, /park.*reclamation/)
    assert(readdirSync(f.queue).some((name) => name.includes('parked')))
  }),
}

function observeAsideRecovery(root, label, kind, recover) {
  const queue = join(root, label)
  const now = Date.now()
  const owner = Buffer.from(JSON.stringify({ pid: 123, startTime: 456, pidNamespace: null })).toString('hex')
  const suffix = kind.startsWith('unknown') ? 'unknown' : owner + '.probe'
  const name = '0000000000000001.parked.reclaimed-' + suffix
  const calls = []
  if (kind !== 'missing') {
    mkdirSync(queue)
    if (kind === 'directory') mkdirSync(join(queue, name))
    else writeFileSync(join(queue, name), kind === 'unreadable' ? '{' : JSON.stringify({ nonce: 'live' }))
    const age = new Date(now - (kind === 'unknown-old' ? 61_000 : 1000))
    utimesSync(join(queue, name), age, age)
    if (kind === 'parked') writeFileSync(join(queue, '0000000000000001.parked'), 'replacement')
    if (kind === 'claimed') writeFileSync(join(queue, '0000000000000001.json'), 'claim')
  }
  let value, error
  const stale = function (owner) { calls.push(['owner', owner, this === undefined]); if (kind === 'owner-throws') throw new Error('owner error'); return kind !== 'live' }
  const live = function (park) { calls.push(['live', park, this === undefined]); if (kind === 'live-throws') throw new Error('live error'); return park !== null && kind !== 'expired' }
  const restore = traceRecoveryFiles(queue, calls)
  try { value = recover(queue, now, stale, live) } catch (caught) { error = { name: caught.name, code: caught.code, message: caught.message.replaceAll(queue, '<queue>') } } finally { restore() }
  const files = existsSync(queue) ? readdirSync(queue).map((name) => [name, kind === 'directory' ? '<directory>' : readFileSync(join(queue, name), 'utf8')]) : []
  rmSync(queue, { recursive: true, force: true })
  return { value, error, calls, files }
}

function traceRecoveryFiles(queue, calls) {
  const originals = new Map()
  for (const name of ['existsSync', 'linkSync', 'lstatSync', 'readdirSync', 'rmSync', 'openSync', 'fstatSync', 'readSync', 'closeSync']) {
    const original = fs[name]
    originals.set(name, original)
    fs[name] = function (...args) {
      calls.push(['fs', name, this === undefined, args.map((value, i) => typeof value === 'string' ? value.replaceAll(queue, '<queue>') : Buffer.isBuffer(value) ? `<buffer:${value.length}>` : i === 0 && typeof value === 'number' ? '<fd>' : value)])
      return original.apply(this, args)
    }
  }
  syncBuiltinESMExports()
  return () => { for (const [name, original] of originals) fs[name] = original; syncBuiltinESMExports() }
}

async function signalScenario(cli, signal, expected) {
  return fixture(cli, async (f) => {
    const parked = f.park()
    const blocker = await f.acquire()
    const waiting = waitingChild(cli, f, signal)
    try {
      await waiting.ready
      const result = await waiting.exit
      assert.equal(result.code, expected, `${signal} must run pre-grant cleanup and publish an outcome`)
      assert.equal(readFileSync(join(f.directory, 'outcome'), 'utf8'), 'not-parked\n')
      assert.equal(JSON.parse(readFileSync(f.file(parked.number), 'utf8')).nonce, parked.nonce)
    } finally { waiting.child.kill('SIGKILL'); f.release(blocker) }
  })
}
