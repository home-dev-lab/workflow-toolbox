import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime JavaScript under plugin/
import { LIGHT_BYPASS_MAX_GRANTS, acquireSuiteLock, lightRunCommand, operatorReleaseSuiteLock, readSuiteLock, releaseSuiteLock } from '../../../../plugin/bin/lib/suite-lock.mjs'
// @ts-expect-error runtime JavaScript under plugin/
import { BROKER_REFUSAL, createSuiteLockBroker } from '../../../../plugin/bin/lib/host/lane-suite-lock-broker.mjs'
// @ts-expect-error runtime JavaScript under plugin/
import { ensureLightCounter, putLockBack, readLightCounter, recordLightGrant } from '../../../../plugin/bin/lib/host/suite-lock-queue.mjs'
// @ts-expect-error runtime JavaScript under toolkit/test-support/
import { suiteLeaseArgvForProject, suiteLeaseClassFor, suiteLeaseClassForProject } from '../../../test-support/suite-lease.global-setup.mjs'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CLI = join(ROOT, 'plugin/bin/wt-suite-lock.mjs')
const WITH_LEASE = join(ROOT, 'toolkit/scripts/with-suite-lease.mjs')
const roots: string[] = []
const children: Array<ReturnType<typeof spawn>> = []
const sockets: net.Socket[] = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const tempRoot = () => { const root = mkdtempSync(join(tmpdir(), 'wt-lock-priority-')); roots.push(root); return root }
const records = (root: string) => (existsSync(join(root, 'queue.d')) ? readdirSync(join(root, 'queue.d')).filter((name) => name.endsWith('.json')).sort() : [])
const readRecord = (root: string, name: string) => JSON.parse(readFileSync(join(root, 'queue.d', name), 'utf8')) as { light?: boolean }
const isolatedEnv = (root: string, extra: NodeJS.ProcessEnv = {}) => ({ ...process.env, WT_SUITE_LOCK_DIR: root, WT_SUITE_LOCK_BROKER: '', WT_SUITE_LEASE: '', ...extra })

async function waitFor(predicate: () => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for fixture state')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

// One in-process acquirer on a temp root: records its name when it acquires, then releases.
function waiter(root: string, name: string, order: string[], options: Record<string, unknown> = {}) {
  return acquireSuiteLock({ root, pollMs: 20, waitS: 30, argv: [name], ...options }).then((lease: { holder: unknown }) => {
    order.push(name)
    releaseSuiteLock(lease)
  })
}

describe('suite lock priority for light runs: order only, one holder at a time', () => {
  it('T1 gives a light waiter the lock before exclusive waiters queued earlier', async () => {
    const root = tempRoot()
    const holder = await acquireSuiteLock({ root, argv: ['H'] })
    const order: string[] = []
    const all: Array<Promise<void>> = []
    all.push(waiter(root, 'E1', order)); await waitFor(() => records(root).length === 1)
    all.push(waiter(root, 'E2', order)); await waitFor(() => records(root).length === 2)
    all.push(waiter(root, 'L', order, { light: true })); await waitFor(() => records(root).length === 3)
    releaseSuiteLock(holder)
    await Promise.all(all)
    expect(order).toEqual(['L', 'E1', 'E2'])
  }, 20_000)

  it('T2 serves an exclusive waiter once it has been passed by the bound of light leases, before the next light', async () => {
    const root = tempRoot()
    const holder = await acquireSuiteLock({ root, argv: ['H'] })
    const order: string[] = []
    const all: Array<Promise<void>> = []
    all.push(waiter(root, 'E1', order)); await waitFor(() => records(root).length === 1)
    for (let index = 1; index <= LIGHT_BYPASS_MAX_GRANTS + 1; index += 1) {
      all.push(waiter(root, `L${index}`, order, { light: true })); await waitFor(() => records(root).length === index + 1)
    }
    releaseSuiteLock(holder)
    await Promise.all(all)
    const lights = Array.from({ length: LIGHT_BYPASS_MAX_GRANTS }, (_, index) => `L${index + 1}`)
    expect(order).toEqual([...lights, 'E1', `L${LIGHT_BYPASS_MAX_GRANTS + 1}`])
    const onDisk = readFileSync(join(root, 'light-grants'), 'utf8').trim()
    expect(onDisk.startsWith('{') ? (JSON.parse(onDisk) as { grants: number }).grants : Number(onDisk), 'every light grant is counted').toBe(LIGHT_BYPASS_MAX_GRANTS + 1)
  }, 30_000)

  // Fence, not a lock: it pins the constant's value, it does not exercise the bound (T2 does).
  it('T2b bounds the bypass at eight light leases', () => {
    expect(LIGHT_BYPASS_MAX_GRANTS).toBe(8)
  })

  it('T2c never lets a light run pass an exclusive ticket that carries no grant count (an older client)', async () => {
    const seed = (root: string, record: Record<string, unknown>) => {
      mkdirSync(join(root, 'queue.d'), { recursive: true })
      const base = join(root, 'queue.d', String(1).padStart(16, '0'))
      writeFileSync(`${base}.ticket`, '')
      writeFileSync(`${base}.json`, JSON.stringify({ pid: process.pid, argv: ['old'], cwd: '/', startedAt: new Date().toISOString(), platform: process.platform, pidNamespace: null, startTime: null, ...record }))
    }
    const outcome = (root: string) => acquireSuiteLock({ root, light: true, waitS: 0.3, pollMs: 10 }).then(
      (lease: { holder: unknown }) => { releaseSuiteLock(lease); return 'acquired' },
      (error: { code?: string }) => error.code,
    )
    const old = tempRoot(); seed(old, {})
    expect(await outcome(old), 'no lightGrantsAtQueue: never passed').toBe('WT_SUITE_LOCK_TIMEOUT')
    const current = tempRoot(); mkdirSync(current, { recursive: true }); seed(current, { lightGrantsAtQueue: 0, lightGrantsGeneration: ensureLightCounter(current).generation })
    expect(await outcome(current), 'control: a ticket that carries the count is passed').toBe('acquired')
  }, 10_000)

  it('T3 never runs a mixed crowd of light and exclusive acquirers at once, and all of them acquire', async () => {
    const root = tempRoot()
    let inside = 0
    let peak = 0
    const finished: string[] = []
    const run = async (name: string, light: boolean) => {
      const lease = await acquireSuiteLock({ root, pollMs: 20, waitS: 60, argv: [name], ...(light ? { light: true } : {}) })
      inside += 1; peak = Math.max(peak, inside)
      expect(readSuiteLock({ root }).holder.leaseId, `${name} must be the recorded holder while inside`).toBe(lease.holder.leaseId)
      for (let turn = 0; turn < 5; turn += 1) await yieldTurn()
      inside -= 1
      finished.push(name)
      releaseSuiteLock(lease)
    }
    const names = ['L1', 'E1', 'L2', 'E2', 'L3', 'E3']
    await Promise.all(names.map((name) => run(name, name.startsWith('L'))))
    expect(peak).toBe(1)
    expect([...finished].sort()).toEqual([...names].sort())
  }, 60_000)

  it('T4 records light in the queue ticket of `run --light`, and not of a plain run', async () => {
    const root = tempRoot()
    const holder = await acquireSuiteLock({ root, argv: ['H'] })
    const start = (args: string[]) => {
      const child = spawn(process.execPath, [CLI, 'run', ...args, '--', process.execPath, '-e', ''], { env: isolatedEnv(root), stdio: 'ignore' }); children.push(child)
      return new Promise<number | null>((resolve) => child.once('exit', resolve))
    }
    const plain = start([]); await waitFor(() => records(root).length === 1)
    const light = start(['--light']); await waitFor(() => records(root).length === 2)
    const [plainName, lightName] = records(root) as [string, string]
    expect(readRecord(root, plainName).light).toBeUndefined()
    expect(readRecord(root, lightName).light).toBe(true)
    releaseSuiteLock(holder)
    expect(await Promise.all([plain, light])).toEqual([0, 0])
  }, 20_000)

  // A lane `vitest run <file>` is exclusive on purpose: Vitest filters by substring (a.test.ts selects pkg1/a.test.ts ... pkgN/a.test.ts)
  // and the resolved config can enable coverage, so argv cannot bound the selection.
  it('T5a classifies the small explicit table of light commands for lane runners', () => {
    for (const argv of [['pnpm', 'typecheck'], ['pnpm', 'run', 'typecheck'], ['pnpm', 'lint'], ['npm', 'run', 'quality'], ['pnpm', 'quality'], ['pnpm', '-r', 'typecheck'], ['npm', 'typecheck']]) {
      expect(lightRunCommand(argv), argv.join(' ')).toBe(true)
    }
    for (const argv of [['pnpm', 'test'], ['pnpm', 'run', 'test'], ['pnpm', 'typecheck', '--force'], ['node', 'x.mjs'], ['pnpm', '-r', 'test'], [], ['pnpm', 'quality:coverage'], ['pnpm', 'vitest', 'run', 'a.test.ts'], ['pnpm', 'exec', 'vitest', 'run', 'a.test.ts', 'b/c.spec.mts'], ['npx', 'vitest', 'run', 'packages/build/test/x.test.ts'], ['pnpm', 'vitest', 'run'], ['pnpm', 'vitest', 'run', 'packages/build/test'], ['pnpm', 'vitest', 'run', '--coverage', 'a.test.ts'], ['pnpm', 'vitest', 'run', 'a.test.ts', '--coverage'], ['pnpm', 'vitest', 'run', '*.test.ts'], ['pnpm', 'vitest', 'run', ...Array.from({ length: 9 }, (_, i) => `${i}.test.ts`)], ['pnpm', 'vitest', 'a.test.ts'], ['pnpm', 'vitest', 'run', 'a.test.ts', '-t', 'x']]) {
      expect(lightRunCommand(argv), argv.join(' ')).toBe(false)
    }
  })

  it('T5b forwards --light through with-suite-lease as `run --light --`', async () => {
    const root = tempRoot()
    const holder = await acquireSuiteLock({ root, argv: ['H'] })
    const start = (args: string[]) => {
      const child = spawn(process.execPath, [WITH_LEASE, ...args, '--', process.execPath, '-e', ''], { env: isolatedEnv(root), stdio: 'ignore' }); children.push(child)
      return new Promise<number | null>((resolve) => child.once('exit', resolve))
    }
    const plain = start([]); await waitFor(() => records(root).length === 1)
    const light = start(['--light']); await waitFor(() => records(root).length === 2)
    const [plainName, lightName] = records(root) as [string, string]
    expect(readRecord(root, plainName).light).toBeUndefined()
    expect(readRecord(root, lightName).light).toBe(true)
    releaseSuiteLock(holder)
    expect(await Promise.all([plain, light])).toEqual([0, 0])
  }, 20_000)

  it('T6 classifies a Vitest run as light only for one to eight selected files without coverage', () => {
    expect(suiteLeaseClassFor({ paths: ['a.test.ts'], coverageEnabled: false })).toBe('light')
    expect(suiteLeaseClassFor({ paths: Array.from({ length: 8 }, (_, i) => `${i}.test.ts`), coverageEnabled: false })).toBe('light')
    expect(suiteLeaseClassFor({ paths: [], coverageEnabled: false })).toBe('exclusive')
    expect(suiteLeaseClassFor({ paths: Array.from({ length: 9 }, (_, i) => `${i}.test.ts`), coverageEnabled: false })).toBe('exclusive')
    expect(suiteLeaseClassFor({ paths: ['a.test.ts'], coverageEnabled: true })).toBe('exclusive')
    expect(suiteLeaseClassFor({ paths: undefined, coverageEnabled: false })).toBe('exclusive')
    expect(suiteLeaseClassFor({ paths: ['a.test.ts'], coverageEnabled: undefined }), 'unknown coverage state fails closed').toBe('exclusive')
  })

  it('T6b classifies a project object fail-closed: missing getPaths, unknown coverage, a throwing reader', () => {
    const project = (state: unknown, coverage: unknown) => ({ vitest: { state, config: { coverage } } })
    expect(suiteLeaseClassForProject(project({ getPaths: () => ['a.test.ts'] }, { enabled: false }))).toBe('light')
    expect(suiteLeaseClassForProject(project({}, { enabled: false })), 'missing getPaths').toBe('exclusive')
    expect(suiteLeaseClassForProject(project({ getPaths: () => ['a.test.ts'] }, undefined)), 'unknown coverage').toBe('exclusive')
    expect(suiteLeaseClassForProject(project({ getPaths: () => { throw new Error('boom') } }, { enabled: false })), 'a throwing reader').toBe('exclusive')
    expect(suiteLeaseClassForProject(undefined)).toBe('exclusive')
  })

  it('T6c labels the holder with the resolved files, or their count past eight, never a bare vitest run', () => {
    const project = (paths: unknown, root = '/r') => ({ vitest: { state: { getPaths: () => paths }, config: { root } } })
    expect(suiteLeaseArgvForProject(project(['/r/a.test.ts', '/r/pkg/b.test.ts']))).toEqual(['vitest', 'run', 'a.test.ts', 'pkg/b.test.ts'])
    expect(suiteLeaseArgvForProject(project(Array.from({ length: 9 }, (_, i) => `/r/${i}.test.ts`)))).toEqual(['vitest', 'run', '(9 files)'])
    expect(suiteLeaseArgvForProject(project(['/elsewhere/x.test.ts'])), 'a path outside the root stays absolute').toEqual(['vitest', 'run', '/elsewhere/x.test.ts'])
    expect(suiteLeaseArgvForProject(project([])), 'nothing resolved').toEqual(['vitest', 'run'])
    expect(suiteLeaseArgvForProject({ vitest: { state: { getPaths: () => { throw new Error('boom') } } } }), 'a throwing reader').toEqual(['vitest', 'run'])
    expect(suiteLeaseArgvForProject(undefined)).toEqual(['vitest', 'run'])
  })

  describe.skipIf(process.platform === 'win32')('broker [unix-domain sockets; broker is Linux-sandbox-only]', () => {
    it('T7a accepts a light request and the broker ticket carries light', async () => {
      const root = tempRoot()
      const address = join(root, 'broker.sock')
      const saved = { dir: process.env.WT_SUITE_LOCK_DIR, broker: process.env.WT_SUITE_LOCK_BROKER, lease: process.env.WT_SUITE_LEASE }
      process.env.WT_SUITE_LOCK_DIR = join(root, 'locks'); process.env.WT_SUITE_LOCK_BROKER = ''; delete process.env.WT_SUITE_LEASE
      const server = createSuiteLockBroker() as net.Server
      const holder = await acquireSuiteLock({ root: join(root, 'locks'), argv: ['H'] })
      try {
        await new Promise<void>((resolve) => server.listen(address, resolve))
        const socket = net.connect(address); sockets.push(socket)
        let text = ''
        socket.on('data', (chunk) => { text += String(chunk) })
        socket.write(`${JSON.stringify({ argv: ['pnpm', 'typecheck'], waitS: 30, light: true })}\n`)
        await waitFor(() => records(join(root, 'locks')).length === 1)
        expect(readRecord(join(root, 'locks'), records(join(root, 'locks'))[0]!).light).toBe(true)
        releaseSuiteLock(holder)
        await waitFor(() => /granted /.test(text))
        socket.destroy()
      } finally {
        server.close()
        for (const [key, value] of [['WT_SUITE_LOCK_DIR', saved.dir], ['WT_SUITE_LOCK_BROKER', saved.broker], ['WT_SUITE_LEASE', saved.lease]] as const) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value
        }
      }
    }, 20_000)

    it('T7b retries once without the field when an older broker refuses it, and says so', async () => {
      const root = tempRoot()
      const address = join(root, 'old-broker.sock')
      const requests: Array<Record<string, unknown>> = []
      const server = net.createServer((socket) => {
        socket.on('data', (chunk) => {
          const request = JSON.parse(String(chunk).split('\n')[0]!)
          requests.push(request)
          if ('light' in request) // Byte-exact from develop 353112a5 plugin/bin/lib/host/lane-suite-lock-broker.mjs lines 27 + 93: requestFrom's message,
          // then the catch's `; requested command ${JSON.stringify(request?.argv ?? 'unavailable')}` (argv was never parsed).
          socket.end('error argv must be an array of strings (only argv and waitS accepted); requested command "unavailable"\n')
          else socket.write('granted old-lease\n')
        })
      })
      await new Promise<void>((resolve) => server.listen(address, resolve))
      const notes: string[] = []
      const stderr = process.stderr.write.bind(process.stderr)
      process.stderr.write = ((chunk: string | Uint8Array) => { notes.push(String(chunk)); return true }) as typeof process.stderr.write
      try {
        const lease = await acquireSuiteLock({ light: true, argv: ['pnpm', 'typecheck'], waitS: 5, env: { WT_SUITE_LOCK_BROKER: address } })
        expect(lease.holder.leaseId).toBe('old-lease')
        releaseSuiteLock(lease)
      } finally {
        process.stderr.write = stderr
        server.close()
      }
      expect(requests.map((request) => 'light' in request)).toEqual([true, false])
      expect(notes.join('')).toMatch(/broker is older.*without priority/)
    }, 20_000)

    it('T7c does not retry, and does not claim an older broker, when the current broker refuses a light request for another reason', async () => {
      const root = tempRoot()
      const address = join(root, 'new-broker.sock')
      const requests: Array<Record<string, unknown>> = []
      const server = net.createServer((socket) => {
        socket.on('data', (chunk) => {
          requests.push(JSON.parse(String(chunk).split('\n')[0]!))
          socket.end(`error ${BROKER_REFUSAL}\n`)
        })
      })
      await new Promise<void>((resolve) => server.listen(address, resolve))
      const notes: string[] = []
      const stderr = process.stderr.write.bind(process.stderr)
      process.stderr.write = ((chunk: string | Uint8Array) => { notes.push(String(chunk)); return true }) as typeof process.stderr.write
      try {
        await expect(acquireSuiteLock({ light: true, argv: ['pnpm', 'typecheck'], waitS: 5, env: { WT_SUITE_LOCK_BROKER: address } })).rejects.toThrow(/plus light as a boolean/)
      } finally {
        process.stderr.write = stderr
        server.close()
      }
      expect(requests.length, 'no retry').toBe(1)
      expect(notes.join('')).not.toMatch(/broker is older/)
    }, 20_000)
  })
})

describe('wt-suite-lock status judges the holder like release does', () => {
  const status = (root: string, ...flags: string[]) => spawnSync(process.execPath, [CLI, 'status', ...flags], { env: isolatedEnv(root), encoding: 'utf8' })
  function deadHolder(root: string) {
        mkdirSync(join(root, 'lock.d'), { recursive: true })
    writeFileSync(join(root, 'lock.d', 'holder.json'), JSON.stringify({ pid: 2147483647, argv: ['pnpm', 'test'], cwd: '/', startedAt: new Date().toISOString(), platform: process.platform, pidNamespace: null, startTime: null, leaseId: 'dead-lease' }))
  }

  it('T8a reads a holder that is gone or expired as stale, in text and in JSON', () => {
    const root = tempRoot(); deadHolder(root)
    const text = status(root)
    expect(text.status, text.stderr).toBe(0)
    expect(text.stdout).toMatch(/^suite lock held by a stale holder \(gone or expired\): holder pid \d+ \(pnpm test\) since \d\d:\d\d; `wt-suite-lock release` clears it\n$/)
    const json = JSON.parse(status(root, '--json').stdout)
    expect(json.held).toBe(true)
    expect(json.stale).toBe(true)
  })

  it('T8b reads a live holder exactly as before, with stale false in JSON', async () => {
    const root = tempRoot()
    const lease = await acquireSuiteLock({ root, argv: ['pnpm', 'test'] })
    try {
      expect(status(root).stdout).toMatch(/^suite lock held: holder pid \d+ \(pnpm test\) since \d\d:\d\d\n$/)
      expect(JSON.parse(status(root, '--json').stdout).stale).toBe(false)
    } finally { releaseSuiteLock(lease) }
  })

  it('T8d release while another reclaim is in flight says so and fails, never "already free"', () => {
    const root = tempRoot(); deadHolder(root)
    mkdirSync(join(root, 'reclaim.d'))
    const release = spawnSync(process.execPath, [CLI, 'release'], { env: isolatedEnv(root), encoding: 'utf8' })
    expect(release.stdout, 'a busy release must not read as a free lock').not.toMatch(/already free/)
    expect(release.status, release.stderr).not.toBe(0)
    expect(release.stderr).toMatch(/reclaim .*in progress/)
    expect(existsSync(join(root, 'lock.d', 'holder.json')), 'the stale holder is left for the reclaimer').toBe(true)
  })

  it('T8c leaves a free lock as before', () => {
    const root = tempRoot()
    expect(status(root).stdout).toBe('suite lock free\n')
    expect(JSON.parse(status(root, '--json').stdout).stale).toBeUndefined()
  })
})

describe('regressions found in review: mixed clients, reclaim, stale counter, counter loss', () => {
  const OLD_CLIENT_RECORD = { pid: process.pid, argv: ['old'], cwd: '/', platform: process.platform, pidNamespace: null, startTime: null }
  // Seeds a ticket in the format of a client from before priority (no light, no grant count), under the next free number.
  function seedOldClientTicket(root: string) {
    mkdirSync(join(root, 'queue.d'), { recursive: true })
    const taken = readdirSync(join(root, 'queue.d')).map((name) => Number.parseInt(name, 10)).filter(Number.isFinite)
    const base = join(root, 'queue.d', String(Math.max(0, ...taken) + 1).padStart(16, '0'))
    writeFileSync(`${base}.ticket`, '')
    writeFileSync(`${base}.json`, JSON.stringify({ ...OLD_CLIENT_RECORD, startedAt: new Date().toISOString() }))
    return `${base}.json`
  }
  const outcome = (root: string, options: Record<string, unknown>) => acquireSuiteLock({ root, waitS: 1.5, pollMs: 10, insideSandbox: false, ...options }).then(
    (lease: { holder: unknown }) => { releaseSuiteLock(lease); return 'acquired' },
    (error: { code?: string }) => error.code,
  )

  it('F1a lets a new exclusive waiter go before an older-client ticket queued after it (numeric order, both views agree)', async () => {
    const root = tempRoot()
    const holder = await acquireSuiteLock({ root, argv: ['H'] })
    const e1 = outcome(root, { argv: ['E1'] })
    await waitFor(() => records(root).length === 1)
    seedOldClientTicket(root)
    releaseSuiteLock(holder)
    expect(await e1, 'a waiter that waits for a ticket that waits for it never acquires').toBe('acquired')
  }, 20_000)

  it('F1b breaks the three-ticket cycle: new exclusive, older client, new light', async () => {
    const root = tempRoot()
    const holder = await acquireSuiteLock({ root, argv: ['H'] })
    const e1 = outcome(root, { argv: ['E1'] })
    await waitFor(() => records(root).length === 1)
    seedOldClientTicket(root)
    const light = outcome(root, { argv: ['L'], light: true, waitS: 0.6 })
    await waitFor(() => records(root).length === 3)
    releaseSuiteLock(holder)
    expect(await e1).toBe('acquired')
    expect(await light, 'while an older-client ticket is queued the light run keeps its number order behind it').toBe('WT_SUITE_LOCK_TIMEOUT')
  }, 20_000)

  // Fence, not a lock: passes with or without the restore; F1a/F1b carry the invariant.
  it('F1c restores priority once the older-client ticket is gone', async () => {
    const root = tempRoot()
    const holder = await acquireSuiteLock({ root, argv: ['H'] })
    const order: string[] = []
    const all = [waiter(root, 'E1', order)]
    await waitFor(() => records(root).length === 1)
    const oldTicket = seedOldClientTicket(root)
    all.push(waiter(root, 'L', order, { light: true })); await waitFor(() => records(root).length === 3)
    rmSync(oldTicket)
    releaseSuiteLock(holder)
    await Promise.all(all)
    expect(order).toEqual(['L', 'E1'])
  }, 20_000)

  // A creates lock.d and stalls; B (head) judges it stale; A publishes; B renames the now-live lock.d aside;
  // light C (which outranks B) tries to acquire before B puts it back. C must not be granted, and A must keep its lock.
  it('F2 grants nothing while a reclaim is in flight, and keeps the holder the reclaimer judged live', async () => {
    const root = tempRoot()
    const lockDir = join(root, 'lock.d')
    mkdirSync(lockDir, { recursive: true })
    const longAgo = new Date(Date.now() - 300_000)
    utimesSync(lockDir, longAgo, longAgo)
    let reclaimed = false
    const publishA = () => { if (reclaimed) return; writeFileSync(join(lockDir, 'holder.json'), JSON.stringify({ ...OLD_CLIENT_RECORD, argv: ['A'], startedAt: new Date().toISOString(), leaseId: 'A-lease' })) }
    const libUrl = new URL('../../../../plugin/bin/lib/suite-lock.mjs', import.meta.url).href
    const script = `import { acquireSuiteLock } from ${JSON.stringify(libUrl)};try{await acquireSuiteLock({root:${JSON.stringify(root)},light:true,waitS:0.6,pollMs:10,insideSandbox:false});process.stdout.write('granted')}catch(e){process.stdout.write(String(e.code))}`
    let lightResult = ''
    const runLight = () => { if (reclaimed) return; reclaimed = true; lightResult = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: isolatedEnv(root), encoding: 'utf8', timeout: 20_000 }).stdout }
    const reclaimer = await outcome(root, { argv: ['B'], waitS: 2, beforeReclaimRemoval: publishA, afterLockAside: runLight })
    expect(lightResult, 'a light acquirer completed while the reclaimer held the lock directory aside').toBe('WT_SUITE_LOCK_TIMEOUT')
    expect(reclaimer).toBe('WT_SUITE_LOCK_TIMEOUT')
    expect(JSON.parse(readFileSync(join(lockDir, 'holder.json'), 'utf8')).leaseId, 'A keeps its lock').toBe('A-lease')
    expect(readdirSync(root).filter((name) => name.includes('reclaimed')), 'no aside copy left behind').toEqual([])
  }, 60_000)

  it('F2b enforces reclaim.d while it is fresh and stops honouring it after its one-minute bound', async () => {
    const root = tempRoot()
    mkdirSync(join(root, 'reclaim.d'), { recursive: true })
    expect(await outcome(root, { argv: ['X'], waitS: 0.6 }), 'a fresh reclaim.d blocks acquisition').toBe('WT_SUITE_LOCK_TIMEOUT')
    const longAgo = new Date(Date.now() - 120_000)
    utimesSync(join(root, 'reclaim.d'), longAgo, longAgo)
    expect(await outcome(root, { argv: ['X'], waitS: 5 }), 'an abandoned one does not').toBe('acquired')
  }, 20_000)

  // R2-5: every loop iteration honours the deadline, a retry included. A light ticket appears before each
  // attempt (so the post-win revalidation hands the lock back) and is gone again after the hand-back: the queue order flips forever.
  it('F5 times out while the post-win revalidation keeps handing the lock back', async () => {
    const root = tempRoot()
    let flips = 0
    let ticket = ''
    const beforeAcquire = () => { if (flips < 400) { flips += 1; ticket = seedLightTicket(root) } }
    const afterHandBack = () => {
      if (ticket) { rmSync(ticket, { force: true }); rmSync(ticket.replace(/\.json$/, '.ticket'), { force: true }) }
      ticket = ''
      for (let spin = 0; spin < 3_000_000; spin += 1) Math.sqrt(spin) // CPU work, not a wait: slows each flip so the bounded seam outlasts waitS
    }
    const started = Date.now()
    expect(await outcome(root, { argv: ['E'], waitS: 0.2, beforeAcquire, afterHandBack })).toBe('WT_SUITE_LOCK_TIMEOUT')
    expect(flips, 'the seam flipped the order at least twice').toBeGreaterThan(1)
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 20_000)

  function seedLightTicket(root: string) {
    mkdirSync(join(root, 'queue.d'), { recursive: true })
    const taken = readdirSync(join(root, 'queue.d')).map((name) => Number.parseInt(name, 10)).filter(Number.isFinite)
    const base = join(root, 'queue.d', String(Math.max(0, ...taken) + 1).padStart(16, '0'))
    writeFileSync(`${base}.ticket`, '')
    writeFileSync(`${base}.json`, JSON.stringify({ ...OLD_CLIENT_RECORD, light: true, startedAt: new Date().toISOString() }))
    return `${base}.json`
  }

  // R2-2a: `wt-suite-lock release` (non-force) renames lock.d aside through the same guarded critical section as a waiter's reclaim.
  const deadHolderIn = (root: string) => {
    mkdirSync(join(root, 'lock.d'), { recursive: true })
    writeFileSync(join(root, 'lock.d', 'holder.json'), JSON.stringify({ ...OLD_CLIENT_RECORD, pid: 2147483647, argv: ['dead'], startedAt: new Date().toISOString(), leaseId: 'dead-lease' }))
  }

  it('F6 an operator release of a stale holder grants nothing to a concurrent acquirer while lock.d is aside', () => {
    const root = tempRoot()
    deadHolderIn(root)
    const libUrl = new URL('../../../../plugin/bin/lib/suite-lock.mjs', import.meta.url).href
    const script = `import { acquireSuiteLock } from ${JSON.stringify(libUrl)};try{await acquireSuiteLock({root:${JSON.stringify(root)},light:true,waitS:0.6,pollMs:10,insideSandbox:false});process.stdout.write('granted')}catch(e){process.stdout.write(String(e.code))}`
    let during = ''
    const result = operatorReleaseSuiteLock({ root, afterLockAside: () => { during = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: isolatedEnv(root), encoding: 'utf8', timeout: 20_000 }).stdout } })
    expect(result.released).toBe(true)
    expect(during, 'an acquirer was granted the lock while the release held lock.d aside').toBe('WT_SUITE_LOCK_TIMEOUT')
  }, 30_000)

  it('F6b an operator release reports busy, and removes nothing, while another reclaim holds reclaim.d', () => {
    const root = tempRoot()
    deadHolderIn(root)
    mkdirSync(join(root, 'reclaim.d'))
    const result = operatorReleaseSuiteLock({ root })
    expect(result).toMatchObject({ released: false, reason: 'busy' })
    expect(existsSync(join(root, 'lock.d', 'holder.json'))).toBe(true)
  })

  // R2-4: where rename onto an existing EMPTY directory fails (not Linux), an acquirer that keeps re-creating an empty lock.d
  // must never cost the judged-live holder its saved directory.
  describe('putLockBack', () => {
    const fixture = () => {
      const root = tempRoot()
      const aside = join(root, 'lock.d.reclaimed-x')
      const lockDir = join(root, 'lock.d')
      mkdirSync(aside); writeFileSync(join(aside, 'holder.json'), '{"leaseId":"A"}')
      return { aside, lockDir }
    }
    const strictRename = (onCall: () => void) => (from: string, to: string) => {
      onCall()
      if (existsSync(to)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      return renameSync(from, to)
    }
    it('F7 keeps the aside copy while the obstacle is only an empty lock.d, however often it is re-created', () => {
      const { aside, lockDir } = fixture()
      let calls = 0
      const rename = strictRename(() => { calls += 1; if (calls <= 6) mkdirSync(lockDir, { recursive: true }) })
      expect(putLockBack(aside, lockDir, { rename })).toBe(true)
      expect(readFileSync(join(lockDir, 'holder.json'), 'utf8')).toContain('"A"')
    })
    it('F7b discards the aside copy only when lock.d holds a published holder', () => {
      const { aside, lockDir } = fixture()
      mkdirSync(lockDir); writeFileSync(join(lockDir, 'holder.json'), '{"leaseId":"NEW"}')
      expect(putLockBack(aside, lockDir, { rename: strictRename(() => {}) })).toBe(false)
      expect(existsSync(aside), 'the live newer holder wins; the judged copy is dropped').toBe(false)
      expect(readFileSync(join(lockDir, 'holder.json'), 'utf8')).toContain('NEW')
    })
    it('F7c leaves the aside copy in place, and says so, when an empty obstacle outlasts the bound', () => {
      const { aside, lockDir } = fixture()
      const notes: string[] = []
      const stderr = process.stderr.write.bind(process.stderr)
      process.stderr.write = ((chunk: string | Uint8Array) => { notes.push(String(chunk)); return true }) as typeof process.stderr.write
      try {
        expect(putLockBack(aside, lockDir, { rename: strictRename(() => mkdirSync(lockDir, { recursive: true })), maxMs: 100 })).toBe(false)
      } finally { process.stderr.write = stderr }
      expect(existsSync(join(aside, 'holder.json')), 'a live holder is never deleted on an empty-obstacle timeout').toBe(true)
      expect(notes.join('')).toMatch(/left in place/)
    })
  })

  it('F3 admits the exclusive waiter before the ninth light grant even when the counter moved after placement', async () => {
    const root = tempRoot()
    const holder = await acquireSuiteLock({ root, argv: ['H'] })
    const order: string[] = []
    const all = [waiter(root, 'E', order)]
    await waitFor(() => records(root).length === 1)
    for (let grant = 0; grant < LIGHT_BYPASS_MAX_GRANTS - 1; grant += 1) recordLightGrant(root)
    let bumped = false
    const bumpWhenFree = () => { if (!bumped && !existsSync(join(root, 'lock.d'))) { bumped = true; recordLightGrant(root) } }
    all.push(waiter(root, 'L9', order, { light: true, beforeAcquire: bumpWhenFree })); await waitFor(() => records(root).length === 2)
    releaseSuiteLock(holder)
    await Promise.all(all)
    expect(bumped, 'the seam ran between placement and acquisition').toBe(true)
    expect(order).toEqual(['E', 'L9'])
  }, 20_000)

  it.each(['deleted', 'corrupt', 'replaced by an older plain-integer file'])('F4 keeps an exclusive ticket promoted after the counter is %s', async (loss) => {
    const root = tempRoot()
    const holder = await acquireSuiteLock({ root, argv: ['H'] })
    const order: string[] = []
    const all = [waiter(root, 'E', order)]
    await waitFor(() => records(root).length === 1)
    for (let grant = 0; grant < LIGHT_BYPASS_MAX_GRANTS; grant += 1) recordLightGrant(root)
    if (loss === 'deleted') rmSync(join(root, 'light-grants'))
    else if (loss === 'corrupt') writeFileSync(join(root, 'light-grants'), '{not json')
    else writeFileSync(join(root, 'light-grants'), '0\n')
    all.push(waiter(root, 'L', order, { light: true })); await waitFor(() => records(root).length === 2)
    releaseSuiteLock(holder)
    await Promise.all(all)
    expect(order, 'E was already passed by the bound before the counter was lost').toEqual(['E', 'L'])
  }, 20_000)

  it('F4b starts a new generation when the counter is missing, corrupt or a plain integer, and keeps counting within one', () => {
    const root = tempRoot()
    expect(readLightCounter(root)).toEqual({ generation: null, grants: 0 })
    const first = ensureLightCounter(root)
    expect(typeof first.generation).toBe('string')
    recordLightGrant(root)
    expect(readLightCounter(root)).toEqual({ generation: first.generation, grants: 1 })
    expect(ensureLightCounter(root).generation).toBe(first.generation)
    writeFileSync(join(root, 'light-grants'), '5\n')
    expect(readLightCounter(root).generation).toBeNull()
    const replaced = ensureLightCounter(root)
    expect(replaced.generation).not.toBe(first.generation)
    expect(replaced.grants).toBe(0)
  })
})

describe('package scripts: which ones are light', () => {
  const scripts = (JSON.parse(readFileSync(join(ROOT, 'toolkit/package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
  const light = (command: string) => /with-suite-lease\.mjs --light --/.test(command)
  const LIGHT_SET = ['typecheck', 'lint', 'quality', 'quality:lint', 'quality:dup', 'quality:dead', 'quality:deps', 'test:spawning-files', 'test:ambient-state', 'test:fixed-waits', 'test:cross-repo']

  it('C-L3 marks exactly the intended scripts light', () => {
    for (const name of LIGHT_SET) expect(light(scripts[name] ?? ''), name).toBe(true)
    expect(Object.keys(scripts).filter((name) => light(scripts[name]!)).sort()).toEqual([...LIGHT_SET].sort())
  })

  it('C-L3 never marks a script that runs Vitest without an explicit file list, or coverage, or the whole suite, light', () => {
    for (const [name, command] of Object.entries(scripts)) {
      const runsSuite = /\bvitest\b/.test(command) || /script-gates\.mjs (test|quality:coverage)/.test(command) || /suite-under-load|certify/.test(command) || command === 'pnpm test'
      const explicitFiles = /\bvitest run\b[^&|]*\.(test|spec)\./.test(command)
      if (runsSuite && !explicitFiles) expect(light(command), `${name}: ${command}`).toBe(false)
    }
  })
})
