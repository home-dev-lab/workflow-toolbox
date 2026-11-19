import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
// @ts-expect-error plugin runtime module
import { acquireSuiteLock, operatorReleaseSuiteLock, releaseSuiteLock } from '../../../../plugin/bin/lib/suite-lock.mjs'

const roots: string[] = []
const children: ChildProcess[] = []
const cli = new URL('../../../../plugin/bin/wt-suite-lock.mjs', import.meta.url).pathname
const scratch = () => { const root = mkdtempSync(join(tmpdir(), 'wt-terminal-')); roots.push(root); return root }
const events = (root: string): Record<string, unknown>[] => existsSync(join(root, 'journal.jsonl')) ? readFileSync(join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []
const ends = (root: string, id: string) => events(root).filter((event) => event.leaseId === id && ['abort', 'release', 'timeout'].includes(String(event.event)))
const ticketFile = (root: string, n: number) => join(root, 'queue.d', `${String(n).padStart(16, '0')}.json`)
const runtime = (name: string) => import(new URL(`../../../../plugin/bin/lib/${name}.mjs`, import.meta.url).href)
function requestAt(root: string, index: number) {
  const request = events(root).filter((event) => event.event === 'request').at(index)
  if (!request) throw new Error(`missing request ${index}`)
  return request
}

async function until(predicate: () => boolean) {
  const deadline = performance.now() + 5000
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('terminal fixture did not become ready')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function launch(root: string, flags: string[] = [], extra: Record<string, string> = {}) {
  const child = spawn(process.execPath, [cli, 'run', ...flags, '--', process.execPath, '-e', 'process.exit(0)'], {
    env: { ...process.env, WT_SUITE_LOCK_DIR: root, WT_SUITE_LOCK_BROKER: '', WT_SUITE_LEASE: '', WT_SUITE_LOCK: '1', WT_SUITE_LOCK_STATIC_LANE: '0', ...extra }, stdio: 'pipe',
  })
  children.push(child)
  return { child, exited: new Promise<number | null>((resolve) => child.once('exit', resolve)) }
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGKILL'); await exited
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

for (const park of [false, true]) {
  for (const [signal, exit] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]] as const) {
    it.skipIf(process.platform === 'win32')(`records ${signal} while waiting (${park ? 'park' : 'direct'}; POSIX delivery only)`, async () => {
      const root = scratch()
      const holder = await acquireSuiteLock({ root })
      const directory = scratch()
      writeFileSync(join(directory, 'key'), 'k'.repeat(32))
      const flags = park ? ['--park-dir', directory, '--park-s', '60', '--park-owner-pid', String(process.pid)] : []
      const run = launch(root, flags)
      await until(() => events(root).filter((event) => event.event === 'request').length === 2)
      const request = requestAt(root, 1)
      run.child.kill(signal)
      expect(await run.exited).toBe(exit)
      expect(ends(root, String(request.leaseId))).toEqual([expect.objectContaining({ event: 'abort', cause: 'signal', signal })])
      expect(readdirSync(join(root, 'queue.d')).filter((name) => name.endsWith('.json'))).toEqual([])
      releaseSuiteLock(holder)
    })
  }
}

it('stores the canonical base in the published holder', async () => {
  const root = scratch()
  const lease = await acquireSuiteLock({ root, route: 'broker', argv: ['pnpm', 'lint'] })
  const holder = JSON.parse(readFileSync(join(root, 'lock.d/holder.json'), 'utf8'))
  expect(holder.journal).toEqual(lease.journal.base)
  releaseSuiteLock(lease)
})

it('records an admission failure after request as an error abort', async () => {
  const root = scratch()
  const error = Object.assign(new Error('injected admission failure'), { code: 'EINJECTED' })
  await expect(acquireSuiteLock({ root, beforeAcquire() { throw error } })).rejects.toBe(error)
  expect(ends(root, String(requestAt(root, 0).leaseId))).toEqual([expect.objectContaining({ event: 'abort', cause: 'error', code: 'EINJECTED' })])
})

it('records one force-release and does not duplicate the client release', async () => {
  const root = scratch()
  const lease = await acquireSuiteLock({ root })
  expect(operatorReleaseSuiteLock({ root, force: true }).released).toBe(true)
  operatorReleaseSuiteLock({ root, force: true })
  releaseSuiteLock(lease)
  expect(ends(root, lease.holder.leaseId)).toEqual([expect.objectContaining({ event: 'release', cause: 'force-release', exit: null, served: false })])
})

it('force release preserves a newer holder swapped at the removal boundary', async () => {
  const root = scratch()
  const lease = await acquireSuiteLock({ root })
  operatorReleaseSuiteLock({ root, force: true, beforeReclaimRemoval() {
    writeFileSync(join(root, 'lock.d/holder.json'), JSON.stringify({ ...lease.holder, leaseId: 'newer' }))
  } })
  expect(JSON.parse(readFileSync(join(root, 'lock.d/holder.json'), 'utf8')).leaseId).toBe('newer')
  expect(ends(root, lease.holder.leaseId)).toEqual([])
})

for (const staticRun of [false, true]) {
  it(`reclaims a dead ${staticRun ? 'static' : 'exclusive'} holder into exactly one release`, async () => {
    const root = scratch()
    const options = { root, static: staticRun, env: { WT_SUITE_LOCK_STATIC_LANE: '1' } }
    const lease = await acquireSuiteLock(options)
    writeFileSync(join(lease.lockDir, 'holder.json'), JSON.stringify({ ...lease.holder, pid: 2147483647 }))
    const next = await acquireSuiteLock(options)
    releaseSuiteLock(next)
    releaseSuiteLock(lease)
    expect(ends(root, lease.holder.leaseId)).toEqual([expect.objectContaining({ event: 'release', cause: 'reclaimed', proof: 'pid-gone', exit: null, served: false, kind: staticRun ? 'static' : 'exclusive' })])
  })
}

it('reaps a killed waiter with the stored canonical base', async () => {
  const root = scratch()
  const holder = await acquireSuiteLock({ root })
  const run = launch(root)
  await until(() => events(root).filter((event) => event.event === 'request').length === 2)
  const request = requestAt(root, 1)
  run.child.kill('SIGKILL'); await run.exited
  releaseSuiteLock(holder)
  const next = await acquireSuiteLock({ root })
  releaseSuiteLock(next)
  expect(ends(root, String(request.leaseId))).toEqual([expect.objectContaining({ event: 'abort', cause: 'client-gone', reapedBy: process.pid, argv: request.argv })])
  const { readSuiteLockJournal } = await runtime('suite-lock-journal')
  expect(readSuiteLockJournal(root).censored).toBe(0)
})

it('keeps the first abort cause when the static deadline expires later', async () => {
  const { staticWaitDeadline } = await runtime('suite-lock-static-deadline')
  const controller = new AbortController()
  const reason = Object.assign(new Error('signal'), { code: 'ABORT_ERR', signal: 'SIGTERM' })
  const deadline = staticWaitDeadline({ staticDomain: true, waitS: 0.01, signal: controller.signal })
  controller.abort(reason)
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(deadline.options.signal.reason).toBe(reason)
  expect(deadline.failure(reason)).toBe(reason)
  deadline.close()
})

it('does not abort a published lease from its leftover ticket', async () => {
  const root = scratch()
  const lease = await acquireSuiteLock({ root })
  const dead = { ...lease.holder, pid: 2147483647 }
  writeFileSync(join(root, 'lock.d/holder.json'), JSON.stringify(dead))
  writeFileSync(ticketFile(root, 1), JSON.stringify(dead))
  const next = await acquireSuiteLock({ root })
  releaseSuiteLock(next)
  expect(ends(root, lease.holder.leaseId)).toEqual([expect.objectContaining({ event: 'release', cause: 'reclaimed' })])
})

it('regression: legacy dead tickets without a journal base leave no invented ending', async () => {
  const root = scratch()
  const first = await acquireSuiteLock({ root })
  releaseSuiteLock(first)
  mkdirSync(join(root, 'queue.d'), { recursive: true })
  writeFileSync(ticketFile(root, 1), JSON.stringify({ ...first.holder, journal: undefined, pid: 2147483647, leaseId: 'legacy' }))
  const lease = await acquireSuiteLock({ root, waitS: 1, staleS: 1 })
  releaseSuiteLock(lease)
  expect(ends(root, 'legacy')).toEqual([])
})

it('does not spawn after a recorded post-grant signal', async () => {
  const { runLeasedCommand } = await import(new URL('../../../../plugin/bin/wt-suite-lock.mjs', import.meta.url).href)
  const root = scratch()
  const lease = await acquireSuiteLock({ root })
  const controller = new AbortController()
  controller.abort({ signal: 'SIGTERM' })
  const marker = join(root, 'spawned')
  const exit = await runLeasedCommand([process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'yes')`], lease, {
    attempt: {}, waiting: { signal: controller.signal, close() {} },
  })
  expect(exit).toBe(143)
  expect(existsSync(marker)).toBe(false)
  expect(ends(root, lease.holder.leaseId)).toEqual([expect.objectContaining({ event: 'release', cause: 'signal', signal: 'SIGTERM', exit: 143, served: false })])
})

async function seedDeadTicket(root: string) {
  const lease = await acquireSuiteLock({ root, argv: ['pnpm', 'lint'], route: 'broker' })
  releaseSuiteLock(lease)
  const record = { ...lease.holder, leaseId: 'dead-ticket', pid: 2147483647, journal: { ...lease.journal.base, leaseId: 'dead-ticket' } }
  writeFileSync(ticketFile(root, 1), JSON.stringify(record))
  return record
}

it('revalidates a live replacement between stale judgment and claim', async () => {
  const root = scratch()
  const dead = await seedDeadTicket(root)
  let replaced = false
  await expect(acquireSuiteLock({ root, waitS: 0, beforeTicketClaim() {
    if (replaced) return
    replaced = true
    writeFileSync(ticketFile(root, 1), JSON.stringify({ ...dead, pid: process.pid, startTime: null }))
  } })).rejects.toThrow('timed out')
  expect(replaced).toBe(true)
  expect(existsSync(ticketFile(root, 1))).toBe(true)
  expect(ends(root, 'dead-ticket')).toEqual([])
})

it('only the winning ticket claimant journals the dead waiter', async () => {
  const root = scratch()
  await seedDeadTicket(root)
  const { reapSuiteTicket } = await runtime('host/suite-lock-recovery')
  let competed = false
  const lease = await acquireSuiteLock({ root, beforeTicketClaim(ticket: object) {
    competed = true
    reapSuiteTicket(join(root, 'queue.d'), ticket)
  } })
  releaseSuiteLock(lease)
  expect(competed).toBe(true)
  expect(ends(root, 'dead-ticket')).toEqual([expect.objectContaining({ cause: 'client-gone', route: 'broker', argv: 'pnpm lint' })])
})

it('cleans old recovery claims and asides without appending another ending', async () => {
  const root = scratch()
  await seedDeadTicket(root)
  const claim = join(root, 'queue.d/.reaped-abandoned')
  const aside = join(root, 'lock.d.reclaimed-abandoned')
  writeFileSync(claim, '{}')
  mkdirSync(aside)
  const old = new Date(Date.now() - 601_000)
  utimesSync(claim, old, old); utimesSync(aside, old, old)
  const lease = await acquireSuiteLock({ root })
  // A reclaimer, including an operator, performs aside collection.
  operatorReleaseSuiteLock({ root, force: true })
  releaseSuiteLock(lease)
  expect(existsSync(claim)).toBe(false)
  expect(existsSync(aside)).toBe(false)
})

it('regression: silence alone cannot prove a live waiter dead', async () => {
  const root = scratch()
  const dead = await seedDeadTicket(root)
  writeFileSync(ticketFile(root, 1), JSON.stringify({ ...dead, pid: process.pid, startTime: null }))
  const old = new Date(Date.now() - 121_000)
  utimesSync(ticketFile(root, 1), old, old)
  const lease = await acquireSuiteLock({ root })
  releaseSuiteLock(lease)
  expect(ends(root, 'dead-ticket')).toEqual([])
})

for (const publishedOnly of [false, true]) {
  it.skipIf(process.platform === 'win32')(`records SIGKILL of a holder ${publishedOnly ? 'before grant' : 'after grant'} (POSIX delivery only)`, async () => {
    const root = scratch()
    const url = new URL('../../../../plugin/bin/lib/suite-lock.mjs', import.meta.url).href
    const seam = publishedOnly ? `afterPublish(){process.stdout.write('published');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000)}` : ''
    const source = `import {acquireSuiteLock} from ${JSON.stringify(url)};await acquireSuiteLock({root:${JSON.stringify(root)},${seam}});process.stdout.write('granted');setInterval(()=>{},1000)`
    const child = spawn(process.execPath, ['--input-type=module', '-e', source])
    children.push(child)
    const exited = new Promise((resolve) => child.once('exit', resolve))
    const stage = await new Promise<string>((resolve) => child.stdout.once('data', (chunk) => resolve(String(chunk))))
    expect(stage).toBe(publishedOnly ? 'published' : 'granted')
    const request = requestAt(root, 0)
    child.kill('SIGKILL'); await exited
    const next = await acquireSuiteLock({ root })
    releaseSuiteLock(next)
    expect(ends(root, String(request.leaseId))).toEqual([expect.objectContaining({ event: 'release', cause: 'reclaimed', proof: 'pid-gone' })])
  })
}

it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/setpriv'))('records parent-death TERM delivery through setpriv (Linux only)', async () => {
  const root = scratch()
  const holder = await acquireSuiteLock({ root })
  const args = ['--pdeathsig', 'TERM', process.execPath, cli, 'run', '--', process.execPath, '-e', 'process.exit(0)']
  const source = `import{spawn}from'node:child_process';spawn('/usr/bin/setpriv',${JSON.stringify(args)},{stdio:'ignore'});setInterval(()=>{},1000)`
  const parent = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, WT_SUITE_LOCK_DIR: root, WT_SUITE_LOCK_BROKER: '', WT_SUITE_LEASE: '', WT_SUITE_LOCK: '1', WT_SUITE_LOCK_STATIC_LANE: '0' },
  })
  children.push(parent)
  const exited = new Promise((resolve) => parent.once('exit', resolve))
  await until(() => events(root).filter((event) => event.event === 'request').length === 2)
  const request = requestAt(root, 1)
  try {
    parent.kill('SIGKILL'); await exited
    await until(() => ends(root, String(request.leaseId)).length > 0)
    expect(ends(root, String(request.leaseId))).toEqual([expect.objectContaining({ event: 'abort', cause: 'signal', signal: 'SIGTERM' })])
  } finally {
    try { process.kill(Number(request.pid), 'SIGKILL') } catch { /* already exited */ }
    releaseSuiteLock(holder)
  }
})

it('records age-only Windows reclaim with explicit age proof', async () => {
  const root = scratch()
  const lease = await acquireSuiteLock({ root })
  operatorReleaseSuiteLock({ root, platform: 'win32', staleS: 0 })
  expect(ends(root, lease.holder.leaseId)).toEqual([expect.objectContaining({ event: 'release', cause: 'reclaimed', proof: 'age' })])
})

it.skipIf(process.platform === 'win32')('reaps a killed static waiter into the parent journal (POSIX delivery only)', async () => {
  const root = scratch()
  const options = { root, static: true, env: { WT_SUITE_LOCK_STATIC_LANE: '1' } }
  const holder = await acquireSuiteLock(options)
  const run = launch(root, ['--static'], { WT_SUITE_LOCK_STATIC_LANE: '1' })
  await until(() => events(root).filter((event) => event.event === 'request').length === 2)
  const request = requestAt(root, 1)
  run.child.kill('SIGKILL'); await run.exited
  releaseSuiteLock(holder)
  const next = await acquireSuiteLock(options)
  releaseSuiteLock(next)
  expect(ends(root, String(request.leaseId))).toEqual([expect.objectContaining({ event: 'abort', cause: 'client-gone', kind: 'static', root })])
})

it('records a reclaimed resumed park ticket as an error abort', async () => {
  const root = scratch()
  const directory = scratch()
  writeFileSync(join(directory, 'key'), 'k'.repeat(32))
  const { validateParkDirectory } = await runtime('host/suite-lock-park-files')
  const { finishParkRun } = await runtime('suite-lock-park')
  const park = { ...validateParkDirectory(directory, process.pid), windowMs: 60_000 }
  const first = await acquireSuiteLock({ root, park })
  finishParkRun(first, park, true)
  releaseSuiteLock(first)
  const holder = await acquireSuiteLock({ root })
  try {
    await expect(acquireSuiteLock({ root, park, pollMs: 1, onWait() {
      const requests = events(root).filter((event) => event.event === 'request')
      rmSync(ticketFile(root, Number(requests.at(-1)?.ticket)), { force: true })
    } })).rejects.toMatchObject({ code: 'WT_SUITE_LOCK_UNAVAILABLE' })
    const request = events(root).filter((event) => event.event === 'request').at(-1)
    expect(ends(root, String(request?.leaseId))).toEqual([expect.objectContaining({ event: 'abort', cause: 'error', code: 'WT_SUITE_LOCK_UNAVAILABLE' })])
  } finally { releaseSuiteLock(holder) }
})

it('force release preserves a hand-over completed before it enters the reclaim section', async () => {
  const root = scratch()
  const lease = await acquireSuiteLock({ root })
  let replaced = false
  operatorReleaseSuiteLock({ root, force: true, beforeOperatorReclaim() {
    replaced = true
    writeFileSync(join(root, 'lock.d/holder.json'), JSON.stringify({ ...lease.holder, leaseId: 'handover' }))
  } })
  expect(replaced).toBe(true)
  expect(JSON.parse(readFileSync(join(root, 'lock.d/holder.json'), 'utf8')).leaseId).toBe('handover')
  expect(ends(root, 'handover')).toEqual([])
  expect(ends(root, lease.holder.leaseId)).toEqual([])
})

it('two concurrent force-release CLIs produce only one terminal line', async () => {
  const root = scratch()
  const lease = await acquireSuiteLock({ root })
  await Promise.all([1, 2].map(() => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'release', '--force'], {
      env: { ...process.env, WT_SUITE_LOCK_DIR: root, WT_SUITE_LOCK_BROKER: '' }, stdio: 'pipe',
    })
    children.push(child)
    child.once('exit', resolve)
  })))
  releaseSuiteLock(lease)
  expect(ends(root, lease.holder.leaseId)).toEqual([expect.objectContaining({ event: 'release', cause: 'force-release' })])
})

it('honors cancellation before taking a park ticket', async () => {
  const root = scratch()
  const { takeParkTicket } = await runtime('suite-lock-park')
  const controller = new AbortController()
  controller.abort({ signal: 'SIGTERM' })
  expect(() => takeParkTicket(join(root, 'queue.d'), { pid: process.pid }, { signal: controller.signal }, () => false)).toThrow('aborted')
  expect(existsSync(join(root, 'queue.d'))).toBe(false)
})

it('interrupts a transient acquisition retry with the recorded signal', async () => {
  const root = scratch()
  const controller = new AbortController()
  let attempts = 0
  await expect(acquireSuiteLock({ root, signal: controller.signal, beforeAcquire() {
    attempts++
    controller.abort({ signal: 'SIGTERM' })
    throw Object.assign(new Error('transient admission'), { code: 'EPERM' })
  } })).rejects.toMatchObject({ code: 'ABORT_ERR' })
  expect(attempts).toBe(1)
  expect(ends(root, String(requestAt(root, 0).leaseId))).toEqual([expect.objectContaining({ event: 'abort', cause: 'signal', signal: 'SIGTERM' })])
})
