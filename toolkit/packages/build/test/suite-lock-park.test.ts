import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { suiteLockEnv } from './helpers/suite-lock-env.js'
// @ts-expect-error Host JavaScript has no TypeScript declarations.
import { resumeParkedTicket as defaultResumeParkedTicket } from '../../../../plugin/bin/lib/suite-lock-park.mjs'
// @ts-expect-error Shared Node selftest scenarios have no TypeScript declarations.
import { assertParkClaimFailureCleanup, assertParkLegacyOptionsParity, assertParkOwnerPidRange, assertParkRequestFreshness, assertParkResumedJournal, assertParkResumedWarning } from './helpers/suite-lock-park-scenarios.mjs'
// @ts-expect-error Shared executable review scenarios have no TypeScript declarations.
import { parkReviewScenarios } from './helpers/suite-lock-park-review-scenarios.mjs'
// @ts-expect-error Executable acquisition differential has no TypeScript declarations.
import { assertSuiteAcquireParity } from './helpers/suite-lock-acquire-parity.mjs'

const PLUGIN = process.env.WT_PARK_TEST_PLUGIN_ROOT ?? fileURLToPath(new URL('../../../../plugin', import.meta.url))
const moduleUrl = (name: string) => pathToFileURL(join(PLUGIN, 'bin/lib', name)).href
const { acquireSuiteLock, readSuiteLockStatus, releaseSuiteLock } = await import(moduleUrl('suite-lock.mjs'))
const { currentPidNamespace, processStartTime } = await import(moduleUrl('host/pid-namespace.mjs'))
const { queuedTickets, readTicket, takeTicket } = await import(moduleUrl('host/suite-lock-queue.mjs'))
const CLI = join(PLUGIN, 'bin/wt-suite-lock.mjs')
const resumeParkedTicket = process.env.WT_PARK_TEST_PLUGIN_ROOT
  ? (await import(moduleUrl('suite-lock-park.mjs'))).resumeParkedTicket : defaultResumeParkedTicket
it('covered park commands keep project but never inherit declared job size', async () => {
  const { spawnParkEnvironment } = await import(moduleUrl('suite-lock-park.mjs'))
  expect(spawnParkEnvironment(null, undefined, { WT_SUITE_LOCK_SIZE: 'S', WT_SUITE_LOCK_PROJECT: 'alpha' })).toEqual({ env: { WT_SUITE_LOCK_PROJECT: 'alpha' } })
})
it('preserves acquisition outputs errors effects property reads callback receivers and microtasks', () => assertSuiteAcquireParity(CLI))
for (const [name, scenario] of Object.entries(parkReviewScenarios)) {
  it.skipIf((process.platform === 'win32' && /FIFO|SIG|symlink/.test(name) && !name.startsWith('tolerates')) || (process.platform !== 'linux' && /Linux/.test(name)))(name, () => (scenario as (cli: string) => Promise<unknown>)(CLI))
}
const scratch: string[] = []
const acquire = (options: Record<string, unknown>) => acquireSuiteLock({ waitS: 1, staleS: 1, ...options, env: options.env ?? suiteLockEnv() })
afterEach(() => { for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true }) })
type Park = { nonce: string; keyHash: string; owner: { pid: number; startTime: number | null; pidNamespace: string | null }; record: Record<string, unknown>; parkedAt: number; windowMs: number; reason: string }

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wt-park-'))
  scratch.push(root)
  const directory = join(root, 'private')
  mkdirSync(directory, { mode: 0o700 })
  const key = 'a-private-test-key-with-at-least-thirty-two-bytes'
  writeFileSync(join(directory, 'key'), key, { mode: 0o600 })
  const context = { directory, keyHash: createHash('sha256').update(key).digest('hex'), owner: { pid: process.pid, startTime: processStartTime(process.pid), pidNamespace: currentPidNamespace() }, windowMs: 60_000 }
  const queue = join(root, 'queue.d')
  const file = (number: number, extension = 'parked') => join(queue, `${String(number).padStart(16, '0')}.${extension}`)
  const run = (flags: string[] = [], script = 'process.exit(0)', extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [CLI, 'run', ...flags, '--', process.execPath, '-e', script], { encoding: 'utf8', env: suiteLockEnv(root, extra), timeout: 30_000 })
  const flags = ['--park-dir', directory, '--park-s', '60', '--park-owner-pid', String(process.pid)]
  const park = (extraFlags: string[] = [], reason = 'machine lock busy') => {
    const result = run([...flags, ...extraFlags], `require('node:fs').writeFileSync(process.env.WT_SUITE_LOCK_PARK_REQUEST, ${JSON.stringify(reason)});process.exit(17)`)
    expect(result.status, 'a park request must preserve the granted ticket and child exit').toBe(17)
    const named = JSON.parse(readFileSync(join(directory, 'parked.json'), 'utf8')) as { number: number; nonce: string }
    return { ...named, data: JSON.parse(readFileSync(file(named.number), 'utf8')) as Park }
  }
  return { root, directory, queue, context, flags, run, park, file }
}

type Fixture = ReturnType<typeof fixture>
const outcome = (f: Fixture) => readFileSync(join(f.directory, 'outcome'), 'utf8')
const writePark = (f: Fixture, number: number, data: Park) => writeFileSync(f.file(number), JSON.stringify(data))

async function resume(f: Fixture, extra: Record<string, unknown> = {}) {
  return acquire({ root: f.root, park: f.context, pollMs: 5, waitS: 1, ...extra })
}

  it('parks the saved queue record before release and publishes a private outcome', () => {
    const f = fixture()
    const parked = f.park(['--priority', 'P2'])
    expect(parked.data.record).toMatchObject({ level: 2, levelOrderVersion: expect.any(Number), startedAt: expect.any(String), lightGrantsGeneration: expect.any(String), p0GrantsGeneration: expect.any(String) })
    expect(outcome(f)).toBe(`parked ${parked.number} ${parked.nonce} machine lock busy\n`)
    expect(existsSync(join(f.root, 'lock.d'))).toBe(false)
    expect(existsSync(join(f.directory, 'request'))).toBe(false)
    expect(readdirSync(f.queue).some((name) => name.includes('.resume-'))).toBe(false)
    expect(readFileSync(f.file(parked.number), 'utf8')).not.toContain('a-private-test-key')
  })

  it('keeps park requests in the main queue when static execution was requested', () => {
    const f = fixture()
    const parked = f.park(['--static'])
    expect(readSuiteLockStatus({ root: f.root }).parked).toMatchObject([{ number: parked.number }])
    expect(existsSync(join(f.root, 'static-lane', 'queue.d'))).toBe(false)
  })

  it('gives an inherited child its request path without parking an ancestor lease or consuming an earlier park', async () => {
    const f = fixture()
    const parked = f.park()
    const parent = await acquire({ root: f.root })
    try {
      const result = f.run(f.flags, 'require("fs").writeFileSync(process.env.WT_SUITE_LOCK_PARK_REQUEST,"inherited request")', { WT_SUITE_LEASE: `${f.root}|${parent.holder.leaseId}` })
      expect(result.status).toBe(0)
      expect(outcome(f)).toBe('not-parked\n')
      expect(JSON.parse(readFileSync(f.file(parked.number), 'utf8')).nonce).toBe(parked.nonce)
      expect(existsSync(join(f.directory, 'request'))).toBe(false)
    } finally { releaseSuiteLock(parent) }
  })

  it.each([{ flags: [] }, { flags: ['--light'] }, { flags: ['--priority', 'release'] }])('admits ordinary, light and release waiters past a parked head: $flags', ({ flags }) => {
    const f = fixture()
    const parked = f.park()
    const result = f.run([...flags, '--wait-s', '0'], 'process.stdout.write("admitted")')
    expect(result.status, 'parked tickets must not block admission').toBe(0)
    expect(result.stdout).toBe('admitted')
    expect(existsSync(f.file(parked.number))).toBe(true)
  })

  it('restores the original number, startedAt, class and all queue counter fields', async () => {
    const f = fixture()
    const parked = f.park(['--priority', 'P2'])
    const lease = await resume(f, { light: true, priority: 'P0' })
    try {
      expect(lease.ticket, 'a resumed ticket keeps its number').toBe(parked.number)
      expect(lease.record).toEqual({ ...parked.data.record, leaseId: expect.any(String), pid: process.pid, startTime: processStartTime(process.pid), argv: process.argv, cwd: process.cwd() })
      expect(lease.record.leaseId).not.toBe(parked.data.record.leaseId)
      expect(lease.record.light).toBeUndefined()
      expect(existsSync(f.file(parked.number))).toBe(false)
    } finally { releaseSuiteLock(lease) }
  })

  it('gives the order B,A,C after A gives up then resumes ahead of C', async () => {
    const f = fixture()
    const parked = f.park()
    const b = await acquire({ root: f.root })
    const order = ['B']
    let cQueued!: () => void
    const cReady = new Promise<void>((resolve) => { cQueued = resolve })
    const cPromise = acquire({ root: f.root, pollMs: 5, waitS: 1, onWait: cQueued }).then((lease: { ticket: number }) => { order.push('C'); releaseSuiteLock(lease); return lease })
    await cReady
    expect(queuedTickets(f.queue), 'C must hold a ticket before A retries').toHaveLength(1)
    const aPromise = resume(f).then((lease) => { order.push('A'); releaseSuiteLock(lease); return lease })
    releaseSuiteLock(b)
    const [a] = await Promise.all([aPromise, cPromise])
    expect(order, 'give-up then retry must preserve order B,A,C').toEqual(['B', 'A', 'C'])
    expect(a.ticket).toBe(parked.number)
  })

  it('consumes every same-nonce aside before returning a resumed grant', async () => {
    const f = fixture()
    const parked = f.park()
    const creator = { ...f.context.owner, pid: process.ppid, startTime: processStartTime(process.ppid) }
    const prefix = `${f.file(parked.number)}.reclaimed-${Buffer.from(JSON.stringify(creator)).toString('hex')}`
    const asides = [`${prefix}.first`, `${prefix}.second`]
    for (const aside of asides) linkSync(f.file(parked.number), aside)
    const lease = await resume(f)
    releaseSuiteLock(lease)
    const { liveParkedTickets } = await import(moduleUrl('suite-lock-park.mjs'))
    liveParkedTickets(f.queue, Date.now(), (owner: { pid: number }) => owner.pid === creator.pid)
    expect(existsSync(f.file(parked.number)), 'recovery must never resurrect a consumed aside nonce').toBe(false)
    for (const aside of asides) expect(existsSync(aside), 'all consumed nonce asides must be removed before grant').toBe(false)
    const later = await resume(f)
    try { expect(later.ticket, 'a consumed aside must force a later retry to take a fresh ticket').toBeGreaterThan(parked.number) }
    finally { releaseSuiteLock(later) }
  })

  it.each([0, 1])('takes a fresh ticket when confirmation crosses expiry by %i ms', async (past) => {
    const f = fixture()
    const parked = f.park()
    const expiry = parked.data.parkedAt + parked.data.windowMs
    const record = { ...parked.data.record, leaseId: 'expiry-claim' }
    let clock = expiry - 1
    const claimed = resumeParkedTicket(f.queue, record, f.context, clock, () => false, {
      afterClaim: () => { clock = expiry + past }, now: () => clock,
    })
    const ticket = claimed?.number ?? takeTicket(f.queue, record)
    expect(ticket, 'confirmation at or after expiry must take a fresh ticket').toBeGreaterThan(parked.number)
    expect(existsSync(f.file(parked.number, 'json')), 'expired confirmation must return its exclusive JSON claim').toBe(false)
    const { liveParkedTickets } = await import(moduleUrl('suite-lock-park.mjs'))
    liveParkedTickets(f.queue, clock, () => false)
    expect(existsSync(f.file(parked.number)), 'expired confirmation must not restore a park').toBe(false)
  })

  it('uses the injected acquisition clock again after publishing the resume claim', async () => {
    const f = fixture()
    const parked = f.park()
    const expiry = parked.data.parkedAt + parked.data.windowMs
    let crossed = false
    const now = () => {
      crossed ||= existsSync(f.file(parked.number, 'json'))
      return expiry - (crossed ? 0 : 1)
    }
    const lease = await resume(f, { now })
    try { expect(lease.ticket, 'the real acquisition path must confirm expiry using its injected clock').toBeGreaterThan(parked.number) }
    finally { releaseSuiteLock(lease) }
  })

  it('claims json first, counts both visible files once, and keeps the original record during the overlap', async () => {
    const f = fixture()
    const parked = f.park()
    const record = { ...parked.data.record, pid: process.pid, startTime: processStartTime(process.pid), pidNamespace: currentPidNamespace(), leaseId: 'new-claim' }
    let observed = false
    const claimed = resumeParkedTicket(f.queue, record, f.context, Date.now(), () => false, { afterClaim: () => {
      observed = true
      expect(existsSync(f.file(parked.number)), 'park must remain visible until json is claimed').toBe(true)
      expect(queuedTickets(f.queue)).toEqual([parked.number])
      expect(readSuiteLockStatus({ root: f.root }).parked).toEqual([])
      const next = takeTicket(f.queue, record)
      expect(next, 'allocation counts the overlap only once').toBe(parked.number + 1)
    } })
    expect(observed).toBe(true)
    expect(claimed.number).toBe(parked.number)
  })

  it.each([false, true])('does not reallocate a parked number without its marker (stale listing %s)', (stale) => {
    const f = fixture()
    const parked = f.park()
    rmSync(f.file(parked.number, 'ticket'))
    const seams = stale ? { list: () => ({ markers: [], records: [] }) } : {}
    expect(takeTicket(f.queue, parked.data.record, seams), 'parked numbers are reserved').toBeGreaterThan(parked.number)
    expect(readdirSync(f.queue).filter((name) => /^(\d{16})\.(ticket|json)$/.test(name))).not.toContain(`${String(parked.number).padStart(16, '0')}.parked`)
  })

  it.each(['keyHash', 'pid', 'startTime', 'pidNamespace'] as const)('checks every owner capability field before claiming: %s', async (field) => {
    const f = fixture()
    const parked = f.park()
    const context = structuredClone(f.context)
    if (field === 'keyHash') context.keyHash = 'wrong'
    if (field === 'pid') context.owner.pid = process.ppid
    if (field === 'startTime') context.owner.startTime = -1
    if (field === 'pidNamespace') context.owner.pidNamespace = 'another namespace'
    const result = resumeParkedTicket(f.queue, { ...parked.data.record, leaseId: 'forged' }, context, Date.now(), () => false)
    expect(result, 'all capability and owner identity fields must match').toBeNull()
    expect(existsSync(f.file(parked.number, 'json'))).toBe(false)
  })

  it('verifies the nonce again after creating the json claim and abandons a replacement', async () => {
    const f = fixture()
    const parked = f.park()
    const result = resumeParkedTicket(f.queue, { ...parked.data.record, leaseId: 'stopped-claim' }, f.context, Date.now(), () => false, {
      afterClaim: () => writePark(f, parked.number, { ...parked.data, nonce: 'new-nonce' }),
    })
    expect(result, 'a stopped claimer must not consume a replacement nonce').toBeNull()
    expect(existsSync(f.file(parked.number, 'json'))).toBe(false)
    expect(JSON.parse(readFileSync(f.file(parked.number), 'utf8')).nonce).toBe('new-nonce')
  })

  it('never reuses a consumed place after the latest park is lost and an older orphan survives', () => {
    const a = fixture()
    const t1 = a.park()
    expect(a.run(a.flags).status).toBe(0)
    expect(outcome(a)).toBe('not-parked\n')
    expect(existsSync(join(a.directory, 'parked.json')), 'a granted place without a request is consumed').toBe(false)
    const other = join(a.root, 'other')
    mkdirSync(other, { mode: 0o700 })
    writeFileSync(join(other, 'key'), 'b'.repeat(40))
    const bFlags = a.flags.map((value) => value === a.directory ? other : value)
    expect(a.run(bFlags, 'require("fs").writeFileSync(process.env.WT_SUITE_LOCK_PARK_REQUEST,"B")').status).toBe(0)
    const b = JSON.parse(readFileSync(join(other, 'parked.json'), 'utf8'))
    const t3 = a.park()
    expect(t3.number).toBeGreaterThan(b.number)
    rmSync(a.file(t3.number))
    writePark(a, t1.number, t1.data)
    const latest = a.park()
    expect(latest.number, 'lost latest park must get a fresh place behind B, never t1').toBeGreaterThan(t3.number)
    expect(existsSync(a.file(t1.number)), 'other parks with this key are deleted, never resumed').toBe(false)
  })

  it('consumes a resumed place when only an abandoned request from an earlier attempt exists', () => assertParkRequestFreshness(CLI))

  it('refuses an out-of-range park owner pid', () => assertParkOwnerPidRange(CLI))

  it('journals a resumed ticket using its saved priority and class', () => assertParkResumedJournal(CLI))

  it('does not warn about requested light mode when the resumed lease is exclusive', () => assertParkResumedWarning(CLI))

  it('removes the exclusive JSON claim if resume publication fails', () => assertParkClaimFailureCleanup(CLI))

  it('preserves legacy parser outputs, errors, argument effects, callback order and this', () => assertParkLegacyOptionsParity(CLI))

  it.each(['key', 'pid', 'startTime', 'namespace', 'nonce', 'missing pointer'] as const)('refuses a forged or unrecorded resume: %s', async (kind) => {
    const f = fixture()
    const parked = f.park()
    if (kind === 'key') writeFileSync(join(f.directory, 'key'), 'wrong'.repeat(10))
    if (kind === 'pid') parked.data.owner = { pid: process.ppid, startTime: processStartTime(process.ppid), pidNamespace: currentPidNamespace() }
    if (kind === 'startTime') parked.data.owner.startTime = (parked.data.owner.startTime ?? 0) + 1
    if (kind === 'namespace') parked.data.owner.pidNamespace = 'pid:[unknown]'
    if (kind === 'nonce') parked.data.nonce = 'replacement-nonce'
    if (kind === 'missing pointer') rmSync(join(f.directory, 'parked.json'))
    writePark(f, parked.number, parked.data)
    const later = f.park()
    expect(later.number, 'a forged resume must take a fresh number').toBeGreaterThan(parked.number)
  })

  it.each(['expired', 'dead', 'reused', 'unreadable'] as const)('reclaims a %s park in status and in queue polls', async (kind) => {
    const f = fixture()
    const parked = f.park()
    if (kind === 'expired') parked.data.parkedAt = Date.now() - 70_000
    if (kind === 'dead') parked.data.owner.pid = 2_147_483_647
    if (kind === 'reused') parked.data.owner.startTime = (parked.data.owner.startTime ?? 0) + 1
    writePark(f, parked.number, parked.data)
    if (kind === 'unreadable') {
      writeFileSync(f.file(parked.number), '{')
      const old = new Date(Date.now() - 11_000)
      utimesSync(f.file(parked.number), old, old)
    }
    const options = { root: f.root, platform: 'linux', processStartTime: () => kind === 'reused' ? -1 : processStartTime(process.pid) }
    expect(readSuiteLockStatus(options).parked).toEqual([])
    expect(existsSync(f.file(parked.number)), 'status must reclaim the stale park').toBe(false)
    writePark(f, parked.number, { ...parked.data, parkedAt: Date.now() - 70_000 })
    const lease = await acquire({ root: f.root })
    releaseSuiteLock(lease)
    expect(existsSync(f.file(parked.number)), 'queue polls must reclaim stale parks too').toBe(false)
  })

  it('conditionally reclaims only the nonce it judged, restoring a replacement via exclusive link', async () => {
    const f = fixture()
    const parked = f.park()
    const { removeParkedInstance } = await import(moduleUrl('host/suite-lock-park-files.mjs'))
    const replacement = { ...parked.data, nonce: 'newer-instance' }
    const removed = removeParkedInstance(f.queue, parked.number, parked.nonce, { beforeAside: () => writePark(f, parked.number, replacement) })
    expect(removed, 'a replacement nonce must survive stale judgment').toBe(false)
    expect(JSON.parse(readFileSync(f.file(parked.number), 'utf8'))).toEqual(replacement)
    expect(removeParkedInstance(f.queue, parked.number, replacement.nonce)).toBe(true)
  })

  it('retains a newer instance if the filesystem refuses the exclusive restore link', async () => {
    const f = fixture()
    const parked = f.park()
    const { removeParkedInstance } = await import(moduleUrl('host/suite-lock-park-files.mjs'))
    const replacement = { ...parked.data, nonce: 'must-survive' }
    expect(() => removeParkedInstance(f.queue, parked.number, parked.nonce, {
      beforeAside: () => writePark(f, parked.number, replacement),
      link: () => { throw Object.assign(new Error('restore refused'), { code: 'EPERM' }) },
    })).toThrow('restore refused')
    const saved = readdirSync(f.queue).find((name) => name.includes('.reclaimed-'))
    expect(saved, 'a different nonce is retained even when restoration fails').toBeDefined()
    expect(JSON.parse(readFileSync(join(f.queue, saved!), 'utf8'))).toEqual(replacement)
  })

  it('does not resurrect a reclaimed resumed json on heartbeat or delete its replacement', async () => {
    const f = fixture()
    const parked = f.park()
    const blocker = await acquire({ root: f.root })
    let replaced = false
    const controller = new AbortController()
    const pending = resume(f, { signal: controller.signal, onWait: () => {
      if (replaced) return
      replaced = true
      rmSync(f.file(parked.number, 'json'))
      writeFileSync(f.file(parked.number, 'json'), JSON.stringify({ ...parked.data.record, leaseId: 'replacement' }))
    } })
    try {
      await expect(pending).rejects.toMatchObject({ code: 'WT_SUITE_LOCK_UNAVAILABLE' })
      expect(readTicket(f.queue, parked.number).holder.leaseId).toBe('replacement')
    } finally { controller.abort(); releaseSuiteLock(blocker) }
  })

  it.each(['timeout', 'signal'])('keeps the earlier park intact on pre-grant %s and writes this attempt outcome', async (kind) => {
    const f = fixture()
    const parked = f.park()
    const blocker = await acquire({ root: f.root })
    try {
      if (kind === 'timeout') {
        expect(f.run([...f.flags, '--wait-s', '0']).status).toBe(75)
        expect(outcome(f)).toBe('not-parked\n')
      } else {
        const controller = new AbortController()
        await expect(resume(f, { signal: controller.signal, onWait: () => controller.abort() })).rejects.toMatchObject({ code: 'ABORT_ERR' })
      }
      expect(JSON.parse(readFileSync(f.file(parked.number), 'utf8')).nonce, 'ungranted attempts retain the earlier park').toBe(parked.nonce)
      expect(JSON.parse(readFileSync(join(f.directory, 'parked.json'), 'utf8')).nonce).toBe(parked.nonce)
    } finally { releaseSuiteLock(blocker) }
  })

  it.skipIf(process.platform === 'win32')('writes not-parked and retains the original park on a catchable POSIX SIGTERM', async () => {
    const f = fixture()
    const parked = f.park()
    const blocker = await acquire({ root: f.root })
    const child = spawn(process.execPath, [CLI, 'run', ...f.flags, '--', process.execPath, '-e', 'process.exit(99)'], { env: suiteLockEnv(f.root), stdio: ['ignore', 'ignore', 'pipe'] })
    let text = ''
    child.stderr.on('data', (chunk: Buffer) => {
      text += String(chunk)
      if (text.includes('waiting for suite lock:')) child.kill('SIGTERM')
    })
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
      expect(code, 'a caught pre-grant signal must publish an outcome before exit').toBe(143)
      expect(outcome(f)).toBe('not-parked\n')
      expect(JSON.parse(readFileSync(f.file(parked.number), 'utf8')).nonce).toBe(parked.nonce)
    } finally { child.kill('SIGKILL'); releaseSuiteLock(blocker) }
  })

  it.each([['P1', 'P1', true], ['P2', 'release', false], ['P2', 'P0', false]] as const)('yields only when the parked %s sorts ahead of %s', (parkPriority, nextPriority, yields) => {
    const f = fixture()
    f.park(['--priority', parkPriority])
    const other = join(f.root, 'later')
    mkdirSync(other, { mode: 0o700 })
    writeFileSync(join(other, 'key'), 'y'.repeat(40))
    const flags = f.flags.map((value) => value === f.directory ? other : value)
    const marker = join(f.root, 'child-ran')
    const result = f.run([...flags, '--yield-to-parked', '--priority', nextPriority], `require('fs').writeFileSync(${JSON.stringify(marker)},'yes')`)
    expect(result.status, 'yield follows the shared queue ordering, including release and level').toBe(yields ? 75 : 0)
    expect(existsSync(marker)).toBe(!yields)
    expect(readFileSync(join(other, 'outcome'), 'utf8')).toMatch(yields ? /^parked \d+ \S+ yield\n$/ : /^not-parked\n$/)
  })

  it('shows one bounded safe parked status line and JSON with no key material', () => {
    const f = fixture()
    const parked = f.park([], '\u001b[31munsafe' + 'x'.repeat(100) + '\nsecond line')
    const highNumber = 9_000_000_000_000_001
    writePark(f, highNumber, parked.data)
    rmSync(f.file(parked.number))
    const result = spawnSync(process.execPath, [CLI, 'status'], { encoding: 'utf8', env: suiteLockEnv(f.root) })
    expect(result.status).toBe(0)
    const lines = result.stdout.split('\n').filter((line) => line.startsWith('parked #'))
    expect(lines).toHaveLength(1)
    expect(lines[0]!.length, 'parked status must fit 80 columns').toBeLessThanOrEqual(80)
    expect(lines[0]).toContain(`pid ${process.pid}`)
    const json = spawnSync(process.execPath, [CLI, 'status', '--json'], { encoding: 'utf8', env: suiteLockEnv(f.root) })
    expect(JSON.parse(json.stdout).parked).toMatchObject([{ number: highNumber, ownerPid: process.pid, level: 1, reason: expect.any(String), expiresAt: expect.any(Number) }])
    expect(json.stdout).not.toMatch(/keyHash|nonce|a-private-test-key/)
    expect(result.stdout).not.toContain('\u001b')
  })
const VALIDATION_MESSAGES: Record<string, string> = {
  'missing window': 'are required together',
  'missing owner': 'are required together',
  'yield alone': 'are required together',
  fraction: 'whole seconds from 1 to 7200',
  zero: 'whole seconds from 1 to 7200',
  'too long': 'whole seconds from 1 to 7200',
  'dead owner': 'must be a live pid',
  'short key': 'at least 32 bytes',
  broker: 'not available inside a lane sandbox',
}
  it('advertises the fixed park capability', () => {
    const f = fixture()
    const result = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', env: suiteLockEnv(f.root) })
    expect(result.stdout, 'callers detect park support through help').toContain('--park-dir')
  })

  it.each(['missing window', 'missing owner', 'yield alone', 'fraction', 'zero', 'too long', 'dead owner', 'short key', 'broker'] as const)('refuses invalid park options: %s', (kind) => {
    const f = fixture()
    const flags = [...f.flags]
    if (kind === 'missing window') flags.splice(flags.indexOf('--park-s'), 2)
    if (kind === 'missing owner') flags.splice(flags.indexOf('--park-owner-pid'), 2)
    if (kind === 'yield alone') flags.splice(0, flags.length, '--yield-to-parked')
    const window = ({ fraction: '1.5', zero: '0', 'too long': '7201' } as Record<string, string>)[kind]
    if (window) flags[flags.indexOf('--park-s') + 1] = window
    if (kind === 'dead owner') flags[flags.indexOf('--park-owner-pid') + 1] = '2147483647'
    if (kind === 'short key') writeFileSync(join(f.directory, 'key'), 'short')
    const result = f.run(flags, '', kind === 'broker' ? { WT_SUITE_LOCK_BROKER: join(f.root, 'missing.sock') } : {})
    expect(result.status).toBe(2)
    expect(result.stderr, 'validation must explain the exact park refusal').toContain(VALIDATION_MESSAGES[kind])
    expect(existsSync(join(f.root, 'lock.d'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32').each([0o644, 0o1700])('refuses mode %i and symlink directories', (mode) => {
    const f = fixture()
    chmodSync(f.directory, mode)
    let insecure
    try { insecure = f.run(f.flags) } finally { chmodSync(f.directory, 0o700) }
    expect(insecure.status, 'insecure directory must be refused').toBe(2)
    expect(insecure.stderr).toContain('owned by the caller with mode 0700')
    const link = join(f.root, 'link')
    symlinkSync(f.directory, link, 'dir')
    const linked = f.run(f.flags.map((value) => value === f.directory ? link : value))
    expect(linked.status, 'symlink directory must be refused').toBe(2)
    expect(linked.stderr).toContain('must be a real directory')
  })

  it.skipIf(process.platform === 'win32')('refuses a foreign uid even when the directory mode is private', () => {
    const f = fixture()
    const script = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
      const original=fs.lstatSync;fs.lstatSync=(name,...args)=>{const info=original(name,...args);if(name===${JSON.stringify(f.directory)})info.uid=process.getuid()+1;return info};syncBuiltinESMExports();
      const {runSuiteLockCliEntrypoint}=await import(${JSON.stringify(pathToFileURL(CLI).href)});
      process.exitCode=await runSuiteLockCliEntrypoint(${JSON.stringify(['run', ...f.flags, '--', process.execPath, '-e', ''])})`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: suiteLockEnv(f.root) })
    expect(result.status, 'a foreign uid must be refused before reading the key').toBe(2)
    expect(result.stderr, 'a foreign uid must be refused before reading the key').toContain('owned by the caller with mode 0700')
  })
