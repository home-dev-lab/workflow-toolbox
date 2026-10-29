import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
// @ts-expect-error plugin runtime module
import { acquireSuiteLock, hasSuiteLeaseAsync, releaseSuiteLock, suiteLeaseMarker, lightRunCommand } from '../../../../plugin/bin/lib/suite-lock.mjs'
// @ts-expect-error plugin runtime module
import { createSuiteLockBroker } from '../../../../plugin/bin/lib/host/lane-suite-lock-broker.mjs'
// @ts-expect-error plugin runtime module
import { parseSuiteRunOptions } from '../../../../plugin/bin/lib/suite-lock-cli-options.mjs'
// @ts-expect-error plugin runtime module
import { staticLaneStatusLines } from '../../../../plugin/bin/lib/suite-lock-static.mjs'
// @ts-expect-error plugin runtime module
import { readSuiteLockJournal, journalCommand } from '../../../../plugin/bin/lib/suite-lock-journal.mjs'
// @ts-expect-error plugin runtime module
import { claimJournalRotation } from '../../../../plugin/bin/lib/host/suite-lock-journal-rotation.mjs'
// @ts-expect-error plugin runtime module
import { readStaticSemaphore } from '../../../../plugin/bin/lib/host/suite-lock-static-semaphore.mjs'

const roots: string[] = []
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'wt-static-nesting-'))
  roots.push(root)
  return root
}
const envFor = (root: string) => ({ ...process.env, WT_SUITE_LOCK_DIR: root, WT_SUITE_LOCK_BROKER: '', WT_SUITE_LEASE: '', WT_SUITE_LOCK_STATIC_LANE: '1', WT_SUITE_LOCK_PRIORITY: 'P1' })
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('API static wait budget defaults to process.env without options.env or waitS', async () => {
  const root = scratch(), env = envFor(root)
  const holder = await acquireSuiteLock({ root, env, static: true })
  for (const [key, value] of Object.entries({ ...env, WT_SUITE_LOCK_WAIT_S: '0.02' })) vi.stubEnv(key, value)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const controller = new AbortController()
  try {
    const waiting = acquireSuiteLock({ root, static: true, pollMs: 5, signal: controller.signal }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    expect(await waiting).toMatchObject({ code: 'WT_SUITE_LOCK_TIMEOUT' })
  } finally { vi.useRealTimers(); releaseSuiteLock(holder) }
})

it.each([
  ['explicit environment overrides process.env', '0.04', undefined, 'WT_SUITE_LOCK_TIMEOUT'],
  ['waitS overrides both environments', '0.01', 0.04, 'WT_SUITE_LOCK_TIMEOUT'],
  ['an environment without a wait keeps the default', undefined, undefined, 'ABORT_ERR'],
  ['zero waitS overrides both environments immediately', '0.04', 0, 'WT_SUITE_LOCK_TIMEOUT'],
] as const)('API static wait precedence: %s', async (name, envWait, waitS, code) => {
  const root = scratch(), env = { ...envFor(root), WT_SUITE_LOCK_WAIT_S: envWait }
  const holder = await acquireSuiteLock({ root, env, static: true })
  vi.stubEnv('WT_SUITE_LOCK_WAIT_S', '0.005')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const controller = new AbortController()
  let outcome: unknown
  try {
    const waiting = acquireSuiteLock({ root, env, static: true, waitS, pollMs: 5, signal: controller.signal }).catch((error: unknown) => { outcome = error; return error })
    if (waitS === 0) await vi.advanceTimersByTimeAsync(0)
    else {
      await vi.advanceTimersByTimeAsync(39)
      expect(outcome, `${name}: lower-precedence budgets cannot expire this request`).toBeUndefined()
      await vi.advanceTimersByTimeAsync(2)
    }
    if (code === 'ABORT_ERR') controller.abort()
    expect(await waiting).toMatchObject({ code })
  } finally { controller.abort(); vi.useRealTimers(); releaseSuiteLock(holder) }
})

it.each(['0', '1'])('quality:host switch %s completes beside an exclusive holder with its original fallback', async (enabled) => {
  const root = scratch(), env = { ...envFor(root), WT_SUITE_LOCK_STATIC_LANE: enabled, WT_SUITE_LOCK_WAIT_S: '0' }
  const holder = await acquireSuiteLock({ root, env })
  const toolkit = new URL('../../../', import.meta.url)
  const manifest = JSON.parse(readFileSync(new URL('package.json', toolkit), 'utf8'))
  const [node, ...args] = manifest.scripts['quality:host'].split(' ')
  expect(node).toBe('node')
  try {
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: toolkit, env })
      let output = ''
      child.stdout.on('data', (chunk) => { output += String(chunk) })
      child.stderr.on('data', (chunk) => { output += String(chunk) })
      child.once('error', reject)
      child.once('exit', (code) => resolve({ code, output }))
    })
    expect(result.code, result.output).toBe(0)
    expect(result.output).not.toContain('waiting for suite lock')
    const tickets = readSuiteLockJournal(root).tickets
    expect(tickets.map((ticket: { kind: string }) => ticket.kind)).toEqual(enabled === '0' ? ['exclusive'] : ['exclusive', 'static'])
  } finally { releaseSuiteLock(holder) }
})

it('F1 direct: nested exclusive waits despite a static ancestor', async () => {
  const root = scratch(), env = envFor(root)
  const exclusive = await acquireSuiteLock({ root, env })
  const analysis = await acquireSuiteLock({ root, env, static: true })
  const nested = { ...env, WT_SUITE_LEASE: suiteLeaseMarker(analysis) }
  try {
    await expect(acquireSuiteLock({ root, env: nested, waitS: 0 })).rejects.toMatchObject({ code: 'WT_SUITE_LOCK_TIMEOUT' })
    expect(await hasSuiteLeaseAsync(nested, { root }), 'static lease does not cover exclusive work').toBe(false)
    expect(await hasSuiteLeaseAsync(nested, { root, static: true })).toBe(true)
    expect(await hasSuiteLeaseAsync({ ...nested, WT_SUITE_LOCK_STATIC_LANE: '0' }, { root, static: true })).toBe(false)
    const inherited = await acquireSuiteLock({ root, env: nested, static: true, waitS: 0 })
    expect(await hasSuiteLeaseAsync({ ...env, WT_SUITE_LEASE: suiteLeaseMarker(inherited) }, { root })).toBe(false)
    releaseSuiteLock(exclusive)
    const child = await acquireSuiteLock({ root, env: nested, waitS: 0 })
    expect(child.inherited).not.toBe(true)
    releaseSuiteLock(child)
  } finally { releaseSuiteLock(analysis); releaseSuiteLock(exclusive) }
})

it('F1 direct: an exclusive ancestor covers static children without deadlock', async () => {
  const root = scratch(), env = envFor(root)
  const exclusive = await acquireSuiteLock({ root, env })
  try {
    const child = await acquireSuiteLock({ root, env: { ...env, WT_SUITE_LEASE: suiteLeaseMarker(exclusive) }, static: true, waitS: 0 })
    expect(child.inherited).toBe(true)
  } finally { releaseSuiteLock(exclusive) }
})

it.skipIf(process.platform === 'win32')('F1 broker: static grants carry a class and nested exclusive work waits', async () => {
  const root = scratch(), env = envFor(root), address = join(root, 'broker.sock')
  const broker = createSuiteLockBroker({ env })
  await new Promise<void>((resolve) => broker.listen(address, resolve))
  const exclusive = await acquireSuiteLock({ root, env })
  const lane = { ...env, WT_SUITE_LOCK_BROKER: address }
  const analysis = await acquireSuiteLock({ env: lane, argv: ['pnpm', 'lint'], waitS: 0 })
  try {
    const nested = { ...lane, WT_SUITE_LEASE: suiteLeaseMarker(analysis) }
    await expect(acquireSuiteLock({ env: nested, waitS: 0, argv: ['pnpm', 'test'] })).rejects.toMatchObject({ code: 'WT_SUITE_LOCK_TIMEOUT' })
    expect(await hasSuiteLeaseAsync(nested), 'broker static lease does not cover exclusive work').toBe(false)
    expect(await hasSuiteLeaseAsync(nested, { static: true })).toBe(true)
    releaseSuiteLock(exclusive)
    const child = await acquireSuiteLock({ env: nested, waitS: 0, argv: ['pnpm', 'test'] })
    expect(child.inherited).not.toBe(true)
    releaseSuiteLock(child)
  } finally {
    releaseSuiteLock(analysis); releaseSuiteLock(exclusive); broker.releaseAll()
    await new Promise<void>((resolve) => broker.close(resolve))
  }
})

it.skipIf(process.platform === 'win32')('F3 broker: real lint wrapper argv requests the static semaphore', async () => {
  const root = scratch(), env = envFor(root), address = join(root, 'broker.sock')
  const broker = createSuiteLockBroker({ env })
  await new Promise<void>((resolve) => broker.listen(address, resolve))
  const exclusive = await acquireSuiteLock({ root, env })
  try {
    const lease = await acquireSuiteLock({ env: { ...env, WT_SUITE_LOCK_BROKER: address }, static: true, argv: ['node', 'scripts/lint-gate.mjs'], waitS: 0 })
    try { expect(suiteLeaseMarker(lease), 'real lint argv uses static lane').toContain('|static:') }
    finally { releaseSuiteLock(lease) }
  } finally {
    releaseSuiteLock(exclusive); broker.releaseAll()
    await new Promise<void>((resolve) => broker.close(resolve))
  }
})

function parseRun(args: string[], enabled: string) {
  return parseSuiteRunOptions(args, {
    env: { WT_SUITE_LOCK_STATIC_LANE: enabled }, defaultStaleS: 1, waitSeconds: () => 1,
    parseSeconds: (_flags: string[], _name: string, fallback: number) => fallback,
    parsePriority: (flags: string[]) => {
      const index = flags.indexOf('--priority')
      if (index < 0) return undefined
      return flags.splice(index, 2)[1]
    },
  })
}

it.each(['0', '1'])('F4 switch %s accepts release on static commands in the main queue', (enabled) => {
  expect(parseRun(['--priority', 'release', '--', 'pnpm', 'lint'], enabled)).toMatchObject({ priority: 'release', staticRun: false, light: false })
})

it('F4 disabled CLI classification matches the pre-static parser for bare gates', () => {
  for (const name of ['typecheck', 'lint', 'quality', 'quality:lint', 'quality:coverage']) {
    expect(parseRun(['--', 'pnpm', name], '0'), name).toMatchObject({ staticRun: false, light: false })
  }
})

it('F4 legacy broker light classification excludes quality subcommands', () => {
  for (const name of ['quality:lint', 'quality:coverage', 'quality:host']) expect(lightRunCommand(['pnpm', name]), name).toBe(false)
  for (const name of ['lint', 'quality', 'typecheck']) expect(lightRunCommand(['pnpm', name]), name).toBe(true)
})

it.skipIf(process.platform === 'win32').each([
  ['lint', 'light'], ['quality:lint', 'exclusive'], ['quality:coverage', 'exclusive'],
])('F4 disabled broker admits %s with legacy kind %s', async (name, kind) => {
  const root = scratch(), env = { ...envFor(root), WT_SUITE_LOCK_STATIC_LANE: '0' }
  const address = join(root, 'broker.sock'), broker = createSuiteLockBroker({ env })
  await new Promise<void>((resolve) => broker.listen(address, resolve))
  try {
    const lease = await acquireSuiteLock({ env: { ...env, WT_SUITE_LOCK_BROKER: address }, argv: ['pnpm', name], waitS: 0 })
    try { expect(readSuiteLockJournal(root).tickets[0].kind).toBe(kind) }
    finally { releaseSuiteLock(lease) }
  } finally {
    broker.releaseAll()
    await new Promise<void>((resolve) => broker.close(resolve))
  }
})

it('F2 documents the accepted client argv trust boundary', () => {
  const changelog = readFileSync(new URL('../../../../plugin/CHANGELOG.md', import.meta.url), 'utf8')
  expect(changelog).toContain('a non-cooperating client can obtain a static grant for arbitrary work')
  expect(changelog).toContain('cooperative scheduler')
  expect(changelog).toContain('A client-side switch does not disable a running broker')
  expect(changelog).toContain('switching off does not drain running static leases')
  const source = readFileSync(new URL('../../../../plugin/bin/lib/host/suite-lock-broker-journal.mjs', import.meta.url), 'utf8')
  expect(source).toContain('client-supplied')
})

it('F8 malformed static holder status sanitizes pid and names unknown age', () => {
  const root = scratch(), lock = join(root, 'static-lane', 'lock.d')
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, 'holder.json'), JSON.stringify({ pid: 'oops\nforged', startedAt: 'bad', argv: [] }))
  const status = readStaticSemaphore(root, Date.now())
  expect(status.holder.pid, 'raw JSON status sanitizes the holder pid').toBe('unknown')
  expect(JSON.stringify(status)).not.toContain('forged')
  const text = staticLaneStatusLines({ staticLane: status })
  expect(text).not.toContain('forged')
  expect(text).toContain('held unknown')
  expect(staticLaneStatusLines({ staticLane: { holder: { pid: 'oops\nforged', ageMs: null, argv: '' }, waiting: 0 } })).not.toContain('forged')
  writeFileSync(join(lock, 'holder.json'), JSON.stringify({ pid: 1, startedAt: { toString: null }, argv: [] }))
  expect(staticLaneStatusLines({ staticLane: readStaticSemaphore(root, Date.now()) })).toContain('held unknown')
})

it('F9 stale journal reclaim guard cannot stop fresh rotation forever', () => {
  const root = scratch(), guard = join(root, 'journal-reclaim.d')
  mkdirSync(guard)
  utimesSync(guard, new Date(0), new Date(0))
  const release = claimJournalRotation(root)
  expect(release, 'rotation recovers stale reclaim guard').toBeTypeOf('function')
  release?.()
})

it('F9 stale rotation claim plus stale reclaim guard recovers on the next attempt', () => {
  const root = scratch(), claim = join(root, 'journal-rotate.d'), guard = join(root, 'journal-reclaim.d')
  for (const directory of [claim, guard]) {
    mkdirSync(directory)
    utimesSync(directory, new Date(0), new Date(0))
  }
  expect(claimJournalRotation(root), 'first attempt only reclaims the stale guard').toBeNull()
  expect(existsSync(guard), 'stale guard is removed even when the rotation claim already exists').toBe(false)
  const release = claimJournalRotation(root)
  try { expect(release, 'next attempt recovers the stale rotation claim').toBeTypeOf('function') }
  finally { release?.() }
  expect(existsSync(claim)).toBe(false)
})

it('F10 aborted waits are terminal rather than censored', async () => {
  const root = scratch(), env = envFor(root)
  const lease = await acquireSuiteLock({ root, env })
  const controller = new AbortController()
  try {
    const waiting = acquireSuiteLock({ root, env, signal: controller.signal, onWait: () => controller.abort() })
    await expect(waiting).rejects.toMatchObject({ code: 'ABORT_ERR' })
    const journal = readSuiteLockJournal(root)
    const aborted = journal.tickets.find((ticket: { leaseId: string }) => ticket.leaseId !== lease.holder.leaseId)
    expect(aborted?.censored, 'aborted wait is terminal').toBe(false)
    expect(aborted?.abort).toBeTruthy()
  } finally { releaseSuiteLock(lease) }
})

it('F10 real package wrapper argv keeps its command label', () => {
  expect(journalCommand(['node', 'scripts/lint-gate.mjs'])).toBe('lint')
  expect(journalCommand(['node', 'scripts/script-gates.mjs', 'quality'])).toBe('quality')
})
