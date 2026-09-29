import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
// @ts-expect-error runtime JavaScript under plugin/
import { acquireSuiteLock, hasSuiteLeaseAsync, releaseSuiteLock } from '../../../../plugin/bin/lib/suite-lock.mjs'
// @ts-expect-error runtime JavaScript under toolkit/scripts/
import { runGate, certify } from '../../../scripts/release-certify.mjs'
import { EventEmitter } from 'node:events'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CLI = join(ROOT, 'plugin/bin/wt-suite-lock.mjs')
const roots: string[] = []
const root = () => { const name = mkdtempSync(join(tmpdir(), 'wt-exclusive-')); roots.push(name); return name }
function envFor(directory: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('WT_SUITE_LEASE')) delete env[key]
  return { ...env, WT_SUITE_LOCK_BROKER: '', WT_SUITE_LOCK_DIR: directory }
}
afterEach(() => { for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }) })
async function waitFor(check: () => boolean, timeout = 12_000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error('fixture state timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

it('refuses legacy mode flags rather than silently changing the lease', () => {
  const result = spawnSync(process.execPath, [CLI, 'run', '--shared', '--', process.execPath, '-e', ''], { env: envFor(root()), encoding: 'utf8', timeout: 12_000 })
  expect(result.status, result.stderr).toBe(2)
  expect(result.stderr).toContain('unknown argument: --shared')
}, 4000)

it('forwards the exact held marker to every certification gate', async () => {
  const directory = root()
  const lease = await acquireSuiteLock({ root: directory, env: envFor(directory) })
  const marker = `${directory}|${lease.holder.leaseId}`
  const previous = process.env.WT_SUITE_LEASE
  try {
    process.env.WT_SUITE_LEASE = ''
    for (const name of ['typecheck', 'test']) {
      const fakeSpawn = (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        expect(options.env.WT_SUITE_LEASE).toBe(marker)
        const child = new EventEmitter() as EventEmitter & { exitCode: number, signalCode: null, kill: () => void }
        child.exitCode = 0; child.signalCode = null; child.kill = () => {}
        queueMicrotask(() => child.emit('exit', 0, null))
        return child
      }
      expect(await runGate(name, ROOT, lease, fakeSpawn)).toBe(0)
    }
  } finally {
    if (previous === undefined) delete process.env.WT_SUITE_LEASE
    else process.env.WT_SUITE_LEASE = previous
    releaseSuiteLock(lease)
  }
})

it('settles a certification gate after its direct child fails to spawn', async () => {
  const directory = root()
  const lease = await acquireSuiteLock({ root: directory, env: envFor(directory) })
  try {
    const spawnFailure = () => {
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('error', new Error('missing executable')))
      return child
    }
    expect(await runGate('test', ROOT, lease, spawnFailure)).toBe(2)
  } finally { releaseSuiteLock(lease) }
}, 4000)

it('never creates a reader record when an obsolete library mode is requested', async () => {
  const directory = root()
  await expect(acquireSuiteLock({ root: directory, mode: 'shared' })).rejects.toThrow('unknown suite lease mode argument: mode')
  expect(existsSync(join(directory, ['shared', 'd'].join('.')))).toBe(false)
})

it('covers nested CLI, package wrapper, Vitest setup and library on a simulated Windows path, without waiting', () => {
  const directory = root()
  const inner = `import {acquireSuiteLock,releaseSuiteLock,hasSuiteLeaseAsync} from ${JSON.stringify(new URL('../../../../plugin/bin/lib/suite-lock.mjs', import.meta.url).href)};import setup from ${JSON.stringify(new URL('../../../test-support/suite-lease.global-setup.mjs', import.meta.url).href)};if(!await hasSuiteLeaseAsync(process.env,{platform:'win32'}))throw Error('not covered');const lease=await acquireSuiteLock({waitS:0.1,platform:'win32'});releaseSuiteLock(lease);await setup({watch:false});process.stdout.write('covered')`
  const result = spawnSync(process.execPath, [CLI, 'run', '--', process.execPath, CLI, 'run', '--wait-s', '0.1', '--', process.execPath, 'scripts/with-suite-lease.mjs', '--', process.execPath, '--input-type=module', '-e', inner], { cwd: join(ROOT, 'toolkit'), env: envFor(directory), encoding: 'utf8', timeout: 4500 })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toBe('covered')
  expect(existsSync(join(directory, ['shared', 'd'].join('.')))).toBe(false)
}, 6000)

it('refuses a stale inherited marker immediately with its lease id and status remedy', async () => {
  const directory = root()
  const lease = await acquireSuiteLock({ root: directory, env: envFor(directory) })
  const marker = `${directory}|${lease.holder.leaseId}`
  releaseSuiteLock(lease)
  const started = Date.now()
  const result = spawnSync(process.execPath, [CLI, 'run', '--wait-s', '10', '--', process.execPath, '-e', ''], { env: { ...envFor(directory), WT_SUITE_LEASE: marker }, encoding: 'utf8', timeout: 2500 })
  expect(result.status, result.stderr).toBe(75)
  expect(Date.now() - started).toBeLessThan(2500)
  expect(result.stderr).toContain(`suite lease ${lease.holder.leaseId} from WT_SUITE_LEASE is no longer held`)
  expect(result.stderr).toContain('wt-suite-lock status')
}, 4000)

it('a different domain marker cannot bypass an independent lease', async () => {
  const first = root(); const second = root()
  const lease = await acquireSuiteLock({ root: first, env: envFor(first) })
  try {
    const result = spawnSync(process.execPath, [CLI, 'run', '--wait-s', '0.1', '--', process.execPath, '-e', 'process.stdout.write("independent")'], { env: { ...envFor(second), WT_SUITE_LEASE: `${first}|${lease.holder.leaseId}` }, encoding: 'utf8', timeout: 12_000 })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('independent')
  } finally { releaseSuiteLock(lease) }
})

it('an old holder without a marker makes a nested client wait and name the holder on timeout', async () => {
  const directory = root()
  const lease = await acquireSuiteLock({ root: directory, env: envFor(directory), argv: ['older holder'] })
  try {
    const result = spawnSync(process.execPath, [CLI, 'run', '--wait-s', '0.15', '--', process.execPath, '-e', ''], { env: envFor(directory), encoding: 'utf8', timeout: 3000 })
    expect(result.status, result.stderr).toBe(75)
    expect(result.stderr).toMatch(/older holder.*wt-suite-lock status/)
  } finally { releaseSuiteLock(lease) }
}, 4000)

it('certification writes a receipt while holding its one lease, even with no gates', async () => {
  const directory = root(); const toolkit = join(directory, 'toolkit')
  mkdirSync(toolkit)
  const code = await certify({ root: toolkit, lockRoot: join(directory, 'locks'), gates: [], probe: () => ({ load: null, capacity: 2, source: 'unavailable' }) })
  expect(code).toBe(0)
  const receipts = readdirSync(join(directory, '.lane', 'certifications'))
  expect(receipts).toHaveLength(1)
  expect(JSON.parse(readFileSync(join(directory, '.lane', 'certifications', receipts[0]!), 'utf8')).admission).toBe('admitted: load unavailable')
})

it('a 0.189.x-shaped broker sees only argv/waitS and nested setup never contacts it', async () => {
  const directory = root(); const address = join(directory, 'broker.sock')
  let requests = 0
  const server = net.createServer((socket) => socket.once('data', (data) => {
    const request = JSON.parse(String(data))
    if (Object.keys(request).sort().join(',') !== 'argv,waitS') { socket.end('error unknown fields\n'); return }
    requests += 1
    socket.write(`granted old-lease\n`)
  }))
  await new Promise<void>((resolve) => server.listen(address, resolve))
  try {
    const program = `import setup from ${JSON.stringify(new URL('../../../test-support/suite-lease.global-setup.mjs', import.meta.url).href)};await setup({watch:false});process.stdout.write('nested ok')`
    const result = await new Promise<{ status: number | null, stderr: string, stdout: string }>((resolve) => {
      const proc = spawn(process.execPath, [CLI, 'run', '--', process.execPath, '--input-type=module', '-e', program], { env: { ...envFor(directory), WT_SUITE_LOCK_BROKER: address }, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''; let stderr = ''
      proc.stdout.on('data', (data) => { stdout += String(data) }); proc.stderr.on('data', (data) => { stderr += String(data) })
      proc.once('exit', (status) => resolve({ status, stderr, stdout }))
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('nested ok')
    expect(requests).toBe(1)
  } finally { server.close() }
}, 5000)

it('a broker-domain marker skips the socket entirely in a nested CLI', async () => {
  const directory = root(); const address = join(directory, 'broker.sock')
  let connections = 0
  const server = net.createServer((socket) => { connections += 1; socket.end('error nested request forbidden\n') })
  await new Promise<void>((resolve) => server.listen(address, resolve))
  try {
    const result = spawnSync(process.execPath, [CLI, 'run', '--wait-s', '0.1', '--', process.execPath, '-e', 'process.stdout.write("covered")'], { env: { ...envFor(directory), WT_SUITE_LOCK_BROKER: address, WT_SUITE_LEASE: `broker:${address}|inherited` }, encoding: 'utf8', timeout: 12_000 })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('covered')
    expect(connections).toBe(0)
  } finally { server.close() }
})

it.each(['linux', 'darwin', 'win32'])('checks the same filesystem marker on %s without a platform ancestry branch', async (platform) => {
  const directory = root()
  const lease = await acquireSuiteLock({ root: directory })
  const env = { ...envFor(directory), WT_SUITE_LEASE: `${directory}|${lease.holder.leaseId}` }
  try {
    expect(await hasSuiteLeaseAsync(env, { platform })).toBe(true)
    const covered = await acquireSuiteLock({ root: directory, env, platform, waitS: 0.1 })
    expect(covered.inherited).toBe(true)
    releaseSuiteLock(covered)
    expect(existsSync(join(directory, 'lock.d'))).toBe(true)
  } finally { releaseSuiteLock(lease) }
}, 3000)

it.each(['cli', 'wrapper', 'vitest setup', 'library', 'certification'])('refuses a stale marker through the %s entrypoint without waiting', async (entry) => {
  const directory = root()
  mkdirSync(join(directory, 'toolkit'))
  const lease = await acquireSuiteLock({ root: directory })
  const marker = `${directory}|${lease.holder.leaseId}`
  releaseSuiteLock(lease)
  const env = { ...envFor(directory), WT_SUITE_LEASE: marker }
  const script = `import {acquireSuiteLock} from ${JSON.stringify(new URL('../../../../plugin/bin/lib/suite-lock.mjs', import.meta.url).href)};try{await acquireSuiteLock({waitS:2})}catch(e){process.stderr.write(e.message);process.exitCode=e.code==='WT_SUITE_LOCK_UNAVAILABLE'?75:2}`
  const setupScript = `import setup from ${JSON.stringify(new URL('../../../test-support/suite-lease.global-setup.mjs', import.meta.url).href)};await setup()`
  const certifyScript = `import {certify} from ${JSON.stringify(new URL('../../../scripts/release-certify.mjs', import.meta.url).href)};process.exitCode=await certify({gates:[],root:${JSON.stringify(join(directory, 'toolkit'))},probe:()=>({load:null,capacity:2,source:'unavailable'})})`
  const args = entry === 'cli' ? [CLI, 'run', '--wait-s', '2', '--', process.execPath, '-e', '']
    : entry === 'wrapper' ? ['scripts/with-suite-lease.mjs', '--', process.execPath, '-e', '']
      : entry === 'vitest setup' ? ['--input-type=module', '-e', setupScript]
        : entry === 'library' ? ['--input-type=module', '-e', script] : ['--input-type=module', '-e', certifyScript]
  const result = spawnSync(process.execPath, args, { cwd: join(ROOT, 'toolkit'), env, encoding: 'utf8', timeout: 2000 })
  expect(result.status, result.stderr).toBe(75)
  expect(result.stderr).toContain(`suite lease ${lease.holder.leaseId} from WT_SUITE_LEASE is no longer held`)
}, 3500)

it.each([{ flags: ['watch'] }, { flags: [] }])('does not acquire when resolved Vitest configuration enables watch with argv $flags', async ({ flags }) => {
  const directory = root()
  const script = `import setup from ${JSON.stringify(new URL('../../../test-support/suite-lease.global-setup.mjs', import.meta.url).href)};process.argv=[process.execPath,'/tmp/vitest.mjs',...${JSON.stringify(flags)}];await setup({config:{watch:true}});process.stdout.write('watch uncovered')`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...envFor(directory), WT_SUITE_LEASE: `${directory}|stale` }, encoding: 'utf8', timeout: 12_000 })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toBe('watch uncovered')
  expect(existsSync(join(directory, 'lock.d'))).toBe(false)
})

it.each(['ci', 'non-tty'])('waits for the holder on a real non-run Vitest entry (%s)', async (mode) => {
  const directory = root()
  const holder = await acquireSuiteLock({ root: directory, argv: ['certification'] })
  const env = envFor(directory)
  if (mode === 'ci') env.CI = '1'
  else delete env.CI
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'packages/build/test/suite-lock.test.ts', '-t', 'sanitises untrusted holder fields'], {
    cwd: join(ROOT, 'toolkit'), env: { ...env, WT_VITEST_MAX_WORKERS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout!.on('data', (data) => { output += String(data) })
  child.stderr!.on('data', (data) => { output += String(data) })
  const done = new Promise<number | null>((resolve) => child.once('exit', resolve))
  try {
    await waitFor(() => output.includes('Test Files') || (existsSync(join(directory, 'queue.d')) && readdirSync(join(directory, 'queue.d')).some((entry) => entry.endsWith('.json'))), 8000)
    expect(existsSync(join(directory, 'queue.d')) && readdirSync(join(directory, 'queue.d')).some((entry) => entry.endsWith('.json')), 'non-watch Vitest never queued behind certification').toBe(true)
    expect(child.exitCode, 'Vitest completed before certification released its lease').toBeNull()
    expect(output, 'Vitest executed tests before certification released its lease').not.toContain('Test Files')
  } finally {
    releaseSuiteLock(holder)
  }
  try {
    expect(await done, output).toBe(0)
    expect(output).toContain('1 passed')
  } finally { child.kill('SIGKILL') }
}, 20_000)

it('keeps the lease through the ordinary chain: a package manager waiting on a test runner waiting on its worker', async () => {
  // Stand-ins for `pnpm test` -> vitest -> worker: each parent waits for its child, so the direct
  // child of the holder exits only after the whole chain has. The worker ends only on the test's word.
  const directory = root()
  const ready = join(directory, 'worker-ready')
  const release = join(directory, 'worker-release')
  const worker = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},'1');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t)}},20)`
  const runner = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:'inherit'}).once('exit',(c)=>process.exit(c??1))`
  const manager = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(runner)}],{stdio:'inherit'}).once('exit',(c)=>process.exit(c??1))`
  const holder = spawn(process.execPath, [CLI, 'run', '--', process.execPath, '-e', manager], { env: envFor(directory), stdio: ['ignore', 'pipe', 'pipe'] })
  const holderDone = new Promise<number | null>((resolve) => holder.once('exit', resolve))
  try {
    await waitFor(() => existsSync(ready), 8000)
    const blocked = spawnSync(process.execPath, [CLI, 'run', '--wait-s', '0.8', '--', process.execPath, '-e', 'process.stdout.write("admitted")'], { env: envFor(directory), encoding: 'utf8', timeout: 4000 })
    expect(blocked.status, 'a competitor was admitted while the worker of the covered chain still ran').toBe(75)
    expect(blocked.stdout).toBe('')
    writeFileSync(release, '1')
    expect(await holderDone).toBe(0)
    const admitted = spawnSync(process.execPath, [CLI, 'run', '--wait-s', '4', '--', process.execPath, '-e', 'process.stdout.write("admitted")'], { env: envFor(directory), encoding: 'utf8', timeout: 8000 })
    expect(admitted.status, admitted.stderr).toBe(0)
    expect(admitted.stdout).toBe('admitted')
  } finally {
    writeFileSync(release, '1')
    holder.kill('SIGKILL')
    await holderDone
  }
}, 20_000)

// The real package manager in the chain: `pnpm run` waits on its script (the runner), which waits on its worker.
// Skipped, by name, where pnpm is not on PATH (for example an external lane that must never call it).
const pnpmAvailable = spawnSync('pnpm', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 10_000 }).status === 0
it.skipIf(!pnpmAvailable)('keeps the lease through a real `pnpm run` chain until its worker has exited', async () => {
  const directory = root()
  const project = join(directory, 'project'); mkdirSync(project)
  const ready = join(directory, 'worker-ready')
  const release = join(directory, 'worker-release')
  const worker = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},'1');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t)}},20)`
  writeFileSync(join(project, 'runner.cjs'), `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:'inherit'}).once('exit',(c)=>process.exit(c??1))\n`)
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'chain-fixture', private: true, scripts: { chain: 'node runner.cjs' } }))
  const holder = spawn(process.execPath, [CLI, 'run', '--', 'pnpm', 'run', '--silent', 'chain'], { cwd: project, env: envFor(directory), stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  holder.stderr!.on('data', (data) => { stderr += String(data) })
  const holderDone = new Promise<number | null>((resolve) => holder.once('exit', resolve))
  try {
    await waitFor(() => existsSync(ready), 15_000)
    const blocked = spawnSync(process.execPath, [CLI, 'run', '--wait-s', '0.8', '--', process.execPath, '-e', 'process.stdout.write("admitted")'], { env: envFor(directory), encoding: 'utf8', timeout: 4000 })
    expect(blocked.status, 'a competitor was admitted while the pnpm-run worker still ran').toBe(75)
    writeFileSync(release, '1')
    expect(await holderDone, stderr).toBe(0)
    const admitted = spawnSync(process.execPath, [CLI, 'run', '--wait-s', '4', '--', process.execPath, '-e', 'process.stdout.write("admitted")'], { env: envFor(directory), encoding: 'utf8', timeout: 8000 })
    expect(admitted.status, admitted.stderr).toBe(0)
  } finally {
    writeFileSync(release, '1')
    holder.kill('SIGKILL')
    await holderDone
  }
}, 30_000)

it.each(['direct', 'nested'])('releases the %s CLI lease after its direct child exits even with a background descendant', async (mode) => {
  const directory = root()
  const descendantPid = join(directory, 'descendant-pid')
  const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(descendantPid)},String(c.pid));c.unref()`
  const command = mode === 'nested' ? [process.execPath, CLI, 'run', '--', process.execPath, '-e', script] : [process.execPath, '-e', script]
  const holder = spawn(process.execPath, [CLI, 'run', '--', ...command], { env: envFor(directory), stdio: ['ignore', 'pipe', 'pipe'] })
  const holderDone = new Promise<number | null>((resolve) => holder.once('exit', resolve))
  try {
    await waitFor(() => existsSync(descendantPid), 8000)
    const result = spawnSync(process.execPath, [CLI, 'run', '--wait-s', '0.8', '--', process.execPath, '-e', 'process.stdout.write("admitted")'], { env: envFor(directory), encoding: 'utf8', timeout: 4000 })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('admitted')
  } finally {
    if (existsSync(descendantPid)) process.kill(Number(readFileSync(descendantPid, 'utf8')), 'SIGKILL')
    holder.kill('SIGKILL')
    await holderDone
  }
}, 12_000)

it('returns from a certification gate after its direct child exits despite a background descendant', async () => {
  const directory = root()
  const lease = await acquireSuiteLock({ root: directory })
  const pidFile = join(directory, 'gate-descendant-pid')
  const background = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`
  const program = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(background)}],{stdio:'ignore'});c.unref()`
  const spawnGate = (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv; detached?: boolean }) => spawn(process.execPath, ['-e', program], { env: options.env, stdio: 'ignore', ...(options.detached !== undefined ? { detached: options.detached } : {}) })
  try {
    const gate = runGate('test', ROOT, lease, spawnGate)
    await waitFor(() => existsSync(pidFile), 8000)
    const gateResult = await Promise.race([gate, new Promise((resolve) => setTimeout(() => resolve('blocked'), 800))])
    expect(gateResult, 'gate held the lease for an out-of-contract descendant').toBe(0)
    releaseSuiteLock(lease)
    const result = spawnSync(process.execPath, [CLI, 'run', '--wait-s', '0.8', '--', process.execPath, '-e', ''], { env: envFor(directory), encoding: 'utf8', timeout: 4000 })
    expect(result.status, result.stderr).toBe(0)
  } finally {
    if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
    releaseSuiteLock(lease)
  }
}, 12_000)

it.each(['mode', 'verify', 'status', 'requester'])('broker refuses unsupported %s request fields', async (field) => {
  const directory = root(); const address = join(directory, 'broker.sock')
  const previous = { WT_SUITE_LOCK_DIR: process.env.WT_SUITE_LOCK_DIR, WT_SUITE_LOCK_BROKER: process.env.WT_SUITE_LOCK_BROKER, WT_SUITE_LEASE: process.env.WT_SUITE_LEASE }
  process.env.WT_SUITE_LOCK_DIR = directory; process.env.WT_SUITE_LOCK_BROKER = ''; process.env.WT_SUITE_LEASE = ''
  // @ts-expect-error runtime JavaScript under plugin/
  const { createSuiteLockBroker } = await import('../../../../plugin/bin/lib/host/lane-suite-lock-broker.mjs')
  const server = createSuiteLockBroker()
  try {
    await new Promise<void>((resolve) => server.listen(address, resolve))
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(address)
      let text = ''
      socket.on('connect', () => socket.write(`${JSON.stringify({ argv: ['test'], waitS: 0.1, [field]: true })}\n`))
      socket.on('data', (data) => { text += String(data) })
      socket.on('end', () => resolve(text))
      socket.on('error', reject)
    })
    expect(reply).toContain('only argv and waitS accepted')
    expect(existsSync(join(directory, 'lock.d'))).toBe(false)
  } finally {
    server.close()
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
}, 4000)

it('uses the environment wait override for ordinary top-level commands', async () => {
  const directory = root()
  const lease = await acquireSuiteLock({ root: directory, argv: ['certification'] })
  try {
    const result = spawnSync(process.execPath, [CLI, 'run', '--', process.execPath, '-e', ''], { env: { ...envFor(directory), WT_SUITE_LOCK_WAIT_S: '0.1' }, encoding: 'utf8', timeout: 2000 })
    expect(result.status, result.stderr).toBe(75)
    expect(result.stderr).toMatch(/certification.*wt-suite-lock status/)
  } finally { releaseSuiteLock(lease) }
}, 3500)

it('keeps the single certification lease through the receipt before handing the FIFO to a competitor', async () => {
  const directory = root(); const toolkit = join(directory, 'toolkit'); mkdirSync(toolkit)
  const locks = join(directory, 'locks'); let competitor: ReturnType<typeof spawn> | undefined
  let finish: Promise<number | null> | undefined
  const seen: string[] = []
  try {
    const exit = await certify({ root: toolkit, lockRoot: locks, gates: ['first', 'second'], probe: () => ({ load: null, capacity: 2, source: 'unavailable' }), executeGate: async (name: string, _root: string, lease: { holder: { leaseId: string } }) => {
      seen.push(lease.holder.leaseId)
      if (name === 'second') {
        const receiptDir = join(directory, '.lane', 'certifications')
        const script = `const f=require('fs');const p=${JSON.stringify(receiptDir)};if(f.readdirSync(p).length!==1)process.exit(4);process.stdout.write('after receipt')`
        competitor = spawn(process.execPath, [CLI, 'run', '--', process.execPath, '-e', script], { env: envFor(locks), stdio: ['ignore', 'pipe', 'pipe'] })
        finish = new Promise((resolve) => competitor!.once('exit', resolve))
        await waitFor(() => existsSync(join(locks, 'queue.d')) && readdirSync(join(locks, 'queue.d')).some((file) => file.endsWith('.json')))
        expect(competitor.exitCode).toBeNull()
      }
      return 0
    } })
    expect(exit).toBe(0)
    expect(new Set(seen).size).toBe(1)
    expect(await finish).toBe(0)
  } finally { competitor?.kill('SIGKILL') }
}, 8000)

it('covers a certification gate, package wrapper and Vitest setup on the Windows-simulated marker path', async () => {
  const directory = root(); const toolkit = join(directory, 'toolkit'); mkdirSync(toolkit)
  const locks = join(directory, 'locks')
  const program = `import setup from ${JSON.stringify(new URL('../../../test-support/suite-lease.global-setup.mjs', import.meta.url).href)};import {acquireSuiteLock,hasSuiteLeaseAsync,releaseSuiteLock} from ${JSON.stringify(new URL('../../../../plugin/bin/lib/suite-lock.mjs', import.meta.url).href)};if(!await hasSuiteLeaseAsync(process.env,{platform:'win32'}))throw Error('not covered');await setup();const lease=await acquireSuiteLock({platform:'win32',waitS:0.1});releaseSuiteLock(lease);process.stdout.write('gate covered')`
  let gateOutput = ''
  const exit = await certify({ root: toolkit, lockRoot: locks, gates: ['test'], probe: () => ({ load: null, capacity: 2, source: 'unavailable' }), executeGate: (_name: string, _root: string, lease: { holder: { leaseId: string } }) => {
    const env = { ...envFor(locks), WT_SUITE_LEASE: `${locks}|${lease.holder.leaseId}` }
    return new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ['scripts/with-suite-lease.mjs', '--', process.execPath, '--input-type=module', '-e', program], { cwd: join(ROOT, 'toolkit'), env, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', (chunk) => { gateOutput += String(chunk) })
      child.once('exit', (code) => resolve(code ?? 1))
    })
  } })
  expect(exit).toBe(0)
  expect(gateOutput).toContain('gate covered')
  expect(readdirSync(join(directory, '.lane', 'certifications'))).toHaveLength(1)
}, 5000)
