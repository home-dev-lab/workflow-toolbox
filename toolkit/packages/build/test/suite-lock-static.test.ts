import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
// @ts-expect-error plugin runtime module
import { acquireSuiteLock, readSuiteLockStatus, releaseSuiteLock } from '../../../../plugin/bin/lib/suite-lock.mjs'
// @ts-expect-error plugin runtime module
import { createSuiteLockBroker } from '../../../../plugin/bin/lib/host/lane-suite-lock-broker.mjs'
import net from 'node:net'

const roots: string[] = []
const scratch = () => { const root = mkdtempSync(join(tmpdir(), 'wt-static-')); roots.push(root); return root }
const cli = fileURLToPath(new URL('../../../../plugin/bin/wt-suite-lock.mjs', import.meta.url))
const lockUrl = new URL('../../../../plugin/bin/lib/suite-lock.mjs', import.meta.url).href
const staticUrl = new URL('../../../../plugin/bin/lib/suite-lock-static.mjs', import.meta.url).href
const envFor = (root: string) => ({ ...process.env, WT_SUITE_LEASE: '', WT_SUITE_LOCK: '1', WT_SUITE_LOCK_DIR: root, WT_SUITE_LOCK_BROKER: '', WT_SUITE_LOCK_PRIORITY: 'P1', WT_SUITE_LOCK_STATIC_LANE: '1' })
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('grants static while an exclusive holder runs and switch off restores exclusion', async () => {
  const root = scratch()
  const lease = await acquireSuiteLock({ root, env: envFor(root), argv: ['exclusive'] })
  try {
    const staticLease = await acquireSuiteLock({ root, env: envFor(root), static: true, waitS: 0 })
    expect(staticLease.lockDir).not.toBe(lease.lockDir)
    releaseSuiteLock(staticLease)
    await expect(acquireSuiteLock({ root, env: { ...envFor(root), WT_SUITE_LOCK_STATIC_LANE: '0' }, static: true, waitS: 0 })).rejects.toThrow('timed out')
  } finally { releaseSuiteLock(lease) }
})

it('classifies whole static jobs and routes release plus static to the main queue', async () => {
  const { staticRunCommand, staticLaneEnabled } = await import(staticUrl)
  for (const script of ['typecheck', 'lint', 'quality', 'quality:lint', 'quality:dup', 'quality:dead', 'quality:changed', 'quality:host', 'quality:deps']) expect(staticRunCommand(['pnpm', script])).toBe(true)
  const scripts = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).scripts
  for (const name of Object.keys(scripts).filter((name) => staticRunCommand(['pnpm', name]))) expect(scripts[name]).toMatch(/with-suite-lease\.mjs (?:--[\w-]+ )*--static --/)
  for (const argv of [['pnpm', 'test'], ['pnpm', 'quality:coverage'], ['node', '--test'], ['pnpm', 'lint', 'test']]) expect(staticRunCommand(argv)).toBe(false)
  expect(staticLaneEnabled({ WT_SUITE_LOCK_STATIC_LANE: '0' })).toBe(false)
  const root = scratch()
  const lease = await acquireSuiteLock({ root, env: envFor(root), static: true, priority: 'release' })
  try { expect(lease.root).toBe(root); expect(lease.holder.priority).toBe('release') }
  finally { releaseSuiteLock(lease) }
})

it('static status counts live waiters and excludes silent abandoned tickets', async () => {
  const root = scratch()
  const { takeTicket } = await import(new URL('../../../../plugin/bin/lib/host/suite-lock-queue.mjs', import.meta.url).href)
  takeTicket(join(root, 'static-lane', 'queue.d'), { pid: process.pid, startedAt: new Date().toISOString() })
  expect(readSuiteLockStatus({ root, env: envFor(root) }).staticLane.waiting).toBe(1)
  expect(readSuiteLockStatus({ root, env: envFor(root), now: () => Date.now() + 121_000 }).staticLane.waiting).toBe(0)
})

it('honours a positive static wait budget even at the head of its own queue', async () => {
  const root = scratch()
  const lease = await acquireSuiteLock({ root, static: true, env: envFor(root) })
  // An implementation using the suite's three-hour head budget never rejects; the test timeout below fails it.
  try {
    await expect(acquireSuiteLock({ root, static: true, env: envFor(root), waitS: 0.02, pollMs: 5 })).rejects.toMatchObject({ code: 'WT_SUITE_LOCK_TIMEOUT' })
  } finally { releaseSuiteLock(lease) }
}, 5_000)

it('does not turn a long static wait into a one-millisecond timer overflow', async () => {
  const root = scratch()
  const lease = await acquireSuiteLock({ root, static: true, env: envFor(root) })
  // Record every delay the wait arms; node coerces a delay above 2^31-1 ms to 1 ms.
  const delays: number[] = []
  const realSetTimeout = globalThis.setTimeout
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number, ...args: unknown[]) => {
    delays.push(Number(ms))
    return realSetTimeout(handler, ms, ...args)
  }) as typeof setTimeout)
  let released = false
  const onWait = () => { if (!released) { released = true; releaseSuiteLock(lease) } }
  try {
    const next = await acquireSuiteLock({ root, static: true, env: envFor(root), waitS: 3_000_000, pollMs: 5, onWait })
    expect(next.holder.leaseId).not.toBe(lease.holder.leaseId)
    releaseSuiteLock(next)
  } finally { spy.mockRestore(); releaseSuiteLock(lease) }
  expect(delays.filter((ms) => ms > 2_147_483_647), 'no timer delay above the 32-bit limit').toEqual([])
}, 5_000)

it('six mixed processes exclude their own family over twenty rounds and observe cross-family overlap', async () => {
  const root = scratch()
  const source = `import {acquireSuiteLock,releaseSuiteLock} from ${JSON.stringify(lockUrl)}; import {writeFileSync,rmSync,existsSync,appendFileSync} from 'node:fs'; const root=process.env.WT_SUITE_LOCK_DIR; const kind=process.argv[1]; for(let i=0;i<20;i++){const lease=await acquireSuiteLock({root,static:kind==='static',light:kind==='light',pollMs:5});const family=kind==='static'?'static':'exclusive';const marker=root+'/'+family;writeFileSync(marker,'1',{flag:'wx'});if(existsSync(root+'/'+(family==='static'?'exclusive':'static')))appendFileSync(root+'/overlap','1');await new Promise(r=>setTimeout(r,5+Math.random()*15));rmSync(marker);releaseSuiteLock(lease);}`
  const outcomes = await Promise.all(['exclusive', 'light', 'static', 'exclusive', 'light', 'static'].map((kind) => new Promise<string>((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, kind], { env: envFor(root) })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('exit', (code) => resolve(code === 0 ? '' : stderr))
  })))
  expect(outcomes, 'no EEXIST overlap in exclusive or static critical sections').toEqual(['', '', '', '', '', ''])
  expect(existsSync(join(root, 'overlap')), 'static and exclusive overlapped').toBe(true)
}, 60_000)

it.skipIf(process.platform === 'win32')('broker derives static from argv and refuses a client static claim', async () => {
  const root = scratch()
  const socketPath = join(root, 'broker.sock')
  const broker = createSuiteLockBroker({ env: envFor(root) })
  await new Promise<void>((resolve) => broker.listen(socketPath, resolve))
  const exclusive = await acquireSuiteLock({ root, env: envFor(root) })
  try {
    const reply = await new Promise<string>((resolve) => {
      const socket = net.connect(socketPath, () => socket.write(JSON.stringify({ argv: ['pnpm', 'test'], static: true, waitS: 0 }) + '\n'))
      socket.once('data', (chunk) => { socket.destroy(); resolve(String(chunk)) })
    })
    expect(reply).toContain('error argv must be an array')
    const lease = await acquireSuiteLock({ argv: ['pnpm', 'lint'], waitS: 0, env: { ...envFor(root), WT_SUITE_LOCK_BROKER: socketPath } })
    releaseSuiteLock(lease)
  } finally {
    releaseSuiteLock(exclusive)
    broker.releaseAll()
    await new Promise<void>((resolve) => broker.close(resolve))
  }
})

it('static CLI publishes status and journal without claiming the exclusive directory', async () => {
  const root = scratch()
  const result = await new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, [cli, 'run', '--static', '--', process.execPath, '-e', ''], { env: envFor(root) })
    child.once('exit', resolve)
  })
  expect(result).toBe(0)
  const events = readFileSync(join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  expect(events.map((event) => event.kind)).toEqual(['static', 'static', 'static'])
})

it.skipIf(process.platform === 'win32')('a broker hold-bound release records lost with the host reason', async () => {
  const root = scratch()
  const socketPath = join(root, 'expired.sock')
  const broker = createSuiteLockBroker({ env: envFor(root), maxHoldS: 0.02, stopGraceS: 1 })
  await new Promise<void>((resolve) => broker.listen(socketPath, resolve))
  try {
    const lease = await acquireSuiteLock({ argv: ['pnpm', 'lint'], env: { ...envFor(root), WT_SUITE_LOCK_BROKER: socketPath } })
    expect(await lease.lost).toContain('hold bound')
    releaseSuiteLock(lease, { exit: 75 })
    await new Promise<void>((resolve) => broker.close(resolve))
    const events = readFileSync(join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(events[2].lost).toBe(true)
    expect(events[2].reason).toContain('hold bound: lane lease expired')
    expect(events[2].reason).not.toContain('command')
  } finally { broker.releaseAll(); if (broker.listening) await new Promise<void>((resolve) => broker.close(resolve)) }
})
