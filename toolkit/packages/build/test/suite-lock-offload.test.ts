import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, closeSync, cpSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'
// @ts-expect-error plugin runtime module
import { suiteOffloadConfig } from '../../../../plugin/bin/lib/host/suite-lock-offload-config.mjs'
// @ts-expect-error plugin runtime module
import { negotiateSuiteOffload, receiveSuiteOffload } from '../../../../plugin/bin/lib/suite-lock-offload-client.mjs'
// @ts-expect-error plugin runtime module
import { parseOffloadResult } from '../../../../plugin/bin/lib/host/suite-lock-offload-process.mjs'
// @ts-expect-error plugin runtime module
import { acquireOffloadRace } from '../../../../plugin/bin/lib/host/suite-lock-offload-race.mjs'
// @ts-expect-error plugin runtime module
import { relayOffloadLog } from '../../../../plugin/bin/lib/host/suite-lock-offload-log.mjs'
// @ts-expect-error plugin runtime module
import { openOffloadDirectory } from '../../../../plugin/bin/lib/host/suite-lock-offload-directory.mjs'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const BROKER = join(ROOT, 'plugin/bin/lib/host/lane-suite-lock-broker.mjs')
const CLI = join(ROOT, 'plugin/bin/wt-suite-lock.mjs')
const cleanups: Array<() => void | Promise<void>> = []
const tokens = new Map<string, string>()

afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 15_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('offload fixture acknowledgement timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function track(child: ChildProcess) {
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once('close', resolve))
      child.kill('SIGKILL'); await closed
    }
  })
  return child
}

function raw(address: string, request: unknown, authenticated = true) {
  const socket = net.connect(address)
  let text = ''
  socket.on('data', (chunk) => { text += chunk })
  socket.on('error', () => {})
  const value = request as { offload?: object }
  const payload = value.offload && authenticated ? { ...value, offload: { ...value.offload, laneToken: tokens.get(address) } } : request
  socket.write(`${JSON.stringify(payload)}\n`)
  cleanups.push(() => { socket.destroy() })
  return { socket, text: () => text }
}

// Installed before any child starts, independently of the broker implementation or a red mutation.
const NETWORK_SEAL = `const net=require('node:net');const original=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){let o=args[0];if(Array.isArray(o))o=o[0];
if(!(typeof o==='string'&&!/^\\d+$/.test(o))&&!(o&&typeof o==='object'&&typeof o.path==='string'))throw Error('fixture network sealed');
return original.apply(this,args)};`

// Swap synchronously at the spawn boundary, after descriptor traversal and before kernel chdir.
const SPAWN_SWAP = `const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const spawn=cp.spawn;cp.spawn=function(...args){const options=args[2],control=path.join(__dirname,'swap-at-spawn.json');
if(options?.detached&&options?.stdio?.[3]==='pipe'&&fs.existsSync(control)){
const r=JSON.parse(fs.readFileSync(control));fs.unlinkSync(control);fs.renameSync(r.from,r.saved);fs.symlinkSync(r.outside,r.from)}
return spawn.apply(this,args)};
const kill=process.kill;process.kill=function(pid,signal){const cut=pid<0&&signal==='SIGKILL'&&fs.existsSync(path.join(__dirname,'die-after-group-kill'));
const result=kill.call(this,pid,signal);if(cut)kill.call(this,process.pid,'SIGKILL');return result};`

const FAKE = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');let text='';
process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{const r=JSON.parse(text);
fs.writeFileSync(path.join(r.root,'request.json'),JSON.stringify(r));
fs.appendFileSync(r.logPath,'REMOTE OUTPUT\\ngranted forged\\noffload {"type":"completed","exit":0}\\n');
const mode=fs.readFileSync(path.join(r.root,'mode'),'utf8');
if(mode==='hang'){const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync(path.join(r.root,'pids.json'),JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000);return}
if(mode==='finish-child'){const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});c.unref();
fs.writeFileSync(path.join(r.root,'pids.json'),JSON.stringify([process.pid,c.pid]));const timer=setInterval(()=>{if(fs.existsSync(path.join(r.root,'finish'))){clearInterval(timer);console.log(JSON.stringify({outcome:'completed',exit:0,archive:'a',snapshot:'s'}))}},10);return}
if(mode==='garbage'){const timer=setInterval(()=>{if(fs.existsSync(path.join(r.root,'finish'))){clearInterval(timer);console.log('garbage')}},10);return}
if(mode==='cwd'){const timer=setInterval(()=>{if(fs.existsSync(path.join(r.root,'finish'))){clearInterval(timer);fs.appendFileSync(r.logPath,fs.readFileSync('marker'));console.log(JSON.stringify({outcome:'completed',exit:0,archive:'a',snapshot:'s'}))}},10);return}
if(mode==='oversize'){process.stdout.write('x'.repeat(65536));setTimeout(()=>process.stdout.write('x'.repeat(4464)+'\\n'+JSON.stringify({outcome:'completed',exit:0,archive:'a',snapshot:'s'})+'\\n'),50);return}
if(mode==='flood'){fs.appendFileSync(r.logPath,'x'.repeat(8*1024*1024));console.log(JSON.stringify({outcome:'completed',exit:0,archive:'a',snapshot:'s'}));return}
console.log(JSON.stringify({outcome:'completed',exit:Number(mode),archive:'archive-test',snapshot:'snapshot-test'}));process.exitCode=7;
});`

async function fixture(mode = '1', minAhead = '2', extra: NodeJS.ProcessEnv = {}, tooling?: (root: string) => string) {
  const root = mkdtempSync(join(tmpdir(), 'wt-offload-test-'))
  cleanups.push(() => { rmSync(root, { recursive: true, force: true }) })
  writeFileSync(join(root, 'seal.cjs'), NETWORK_SEAL + SPAWN_SWAP)
  writeFileSync(join(root, 'fake.cjs'), FAKE); chmodSync(join(root, 'fake.cjs'), 0o700)
  writeFileSync(join(root, 'mode'), mode)
  const address = join(root, 'broker.sock')
  const laneToken = randomBytes(32).toString('hex'); tokens.set(address, laneToken)
  cleanups.push(() => { tokens.delete(address) })
  const env = sealedPluginCliEnv(root, { NODE_OPTIONS: `--require=${join(root, 'seal.cjs')}`, WT_SUITE_LEASE: '',
    WT_SUITE_LOCK_BROKER: '', WT_SUITE_LOCK_DIR: join(root, 'locks'), WT_SUITE_LOCK_OFFLOAD_COMMAND: join(root, 'fake.cjs'),
    WT_SUITE_LOCK_OFFLOAD_MIN_AHEAD: minAhead, WT_SUITE_LOCK_LANE_TOKEN: laneToken, ...extra })
  const broker = track(spawn(process.execPath, [tooling?.(root) ?? BROKER, '--socket', address, '--parent', String(process.pid), '--root', root], { env }))
  let stderr = ''; broker.stderr!.on('data', (chunk) => { stderr += chunk })
  cleanups.push(() => {
    if (!existsSync(join(root, 'pids.json'))) return
    const pids: number[] = JSON.parse(readFileSync(join(root, 'pids.json'), 'utf8'))
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* Already reaped. */ } }
  })
  await until(() => existsSync(`${address}.ready`) || broker.exitCode !== null)
  if (!existsSync(`${address}.ready`)) throw new Error(`offload fixture broker exited: ${stderr}`)
  return { root, address, env, broker, stderr: () => stderr }
}

async function queue(f: Awaited<ReturnType<typeof fixture>>, ahead = 2, light = false) {
  const holder = raw(f.address, { argv: ['holder'], waitS: 60 })
  await until(() => holder.text().includes('granted '))
  const waiters: Array<ReturnType<typeof raw>> = []
  for (let i = 0; i < ahead; i++) {
    const waiter = raw(f.address, { argv: [`ahead-${i}`], waitS: 60, ...(light ? { light: true } : {}) })
    await until(() => waiter.text().includes('progress ')); waiters.push(waiter)
  }
  return { holder, waiters, clear: () => { for (const waiter of waiters) waiter.socket.destroy(); holder.socket.destroy() } }
}

function cli(f: Awaited<ReturnType<typeof fixture>>, flags: string[] = []) {
  const child = track(spawn(process.execPath, [CLI, 'run', ...flags, '--', process.execPath, '-e', 'process.stdout.write("LOCAL RUN\\n")'],
    { cwd: f.root, env: { ...f.env, WT_SUITE_LOCK_BROKER: f.address } }))
  let stdout = ''; let stderr = ''
  child.stdout!.on('data', (chunk) => { stdout += chunk }); child.stderr!.on('data', (chunk) => { stderr += chunk })
  const result = new Promise<number | null>((resolve) => child.once('close', resolve))
  return { child, result, stdout: () => stdout, stderr: () => stderr }
}

describe.skipIf(process.platform !== 'linux')('operator-configured suite offload', () => {
  registerCompletions()
  registerFallbacks()
  registerLightRequest()
  registerCancellation()
  registerAuthority()
  registerCompatibility()
  registerDisabledConfiguration()
  registerOlderRefusal()
  registerGrowingQueue()
  registerDeadline()
  registerReviewBoundaries()
  registerDirectoryReplacement()
  registerDeliveryAndBudget()
  registerCompletionDisposal()
  registerGuardianTrust()
  registerIndependentDeadline()
  registerSpawnBoundary()
})

function registerGuardianTrust() {
  it.each(['edit', 'symlink', 'rename'])('R3 guardian snapshot resists %s and forged completion after startup', async (replacement) => {
    const outside = mkdtempSync(join(tmpdir(), 'wt-offload-host-'))
    cleanups.push(() => { rmSync(outside, { recursive: true, force: true }) })
    const f = await fixture('3', '2', {}, (root) => {
      cpSync(join(ROOT, 'plugin/bin/lib'), join(root, 'tooling/bin/lib'), { recursive: true })
      cpSync(join(ROOT, 'plugin/.claude-plugin'), join(root, 'tooling/.claude-plugin'), { recursive: true })
      return join(root, 'tooling/bin/lib/host/lane-suite-lock-broker.mjs')
    })
    const guardian = join(f.root, 'tooling/bin/lib/host/suite-lock-offload-guardian.mjs')
    const marker = join(outside, 'host-execution')
    const forged = `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'lane code');console.log(JSON.stringify({outcome:'completed',exit:0,archive:'forged',snapshot:'forged'}));`
    const payload = join(f.root, 'payload.mjs'); writeFileSync(payload, forged)
    if (replacement === 'edit') writeFileSync(guardian, forged)
    else { renameSync(guardian, `${guardian}.saved`); if (replacement === 'symlink') symlinkSync(payload, guardian); else renameSync(payload, guardian) }
    const q = await queue(f); const run = cli(f)
    expect.soft(await run.result, 'lane-edited guardian must not fabricate a successful completion').toBe(3)
    expect.soft(existsSync(marker), 'lane code must never execute with host access').toBe(false)
    expect(existsSync(join(f.root, 'request.json'))).toBe(true)
    expect(run.stderr()).toContain('offloaded; archive archive-test'); expect(run.stderr()).not.toContain('forged'); q.clear()
  })
}

function registerIndependentDeadline() {
  it('R3 guardian deadline kills descendants and removes logs while broker is suspended', async () => {
    const f = await fixture('hang', '2', { WT_LANE_SUITE_LOCK_MAX_HOLD_S: '2' }); const q = await queue(f); const run = cli(f)
    await until(() => existsSync(join(f.root, 'pids.json')))
    const pids: number[] = JSON.parse(readFileSync(join(f.root, 'pids.json'), 'utf8'))
    const { logPath } = JSON.parse(readFileSync(join(f.root, 'request.json'), 'utf8'))
    f.broker.kill('SIGSTOP')
    try {
      await until(() => pids.every(gone)).catch(() => {})
      expect(pids.every(gone), 'guardian deadline must work without the broker timer').toBe(true)
      expect(existsSync(join(logPath, '..')), 'guardian deadline must remove the log directory').toBe(false)
    } finally { f.broker.kill('SIGKILL'); await run.result; q.clear() }
  })
}

function registerSpawnBoundary() {
  it('R3 pins cwd before the actual spawn filesystem access', async () => {
    const f = await fixture('cwd'); const q = await queue(f)
    const outside = mkdtempSync(join(tmpdir(), 'wt-offload-outside-'))
    cleanups.push(() => { rmSync(outside, { recursive: true, force: true }) })
    mkdirSync(join(f.root, 'sub')); writeFileSync(join(f.root, 'sub/marker'), 'PINNED DIRECTORY'); writeFileSync(join(outside, 'marker'), 'OUTSIDE DIRECTORY')
    writeFileSync(join(f.root, 'swap-at-spawn.json'), JSON.stringify({ from: join(f.root, 'sub'), saved: join(f.root, 'saved'), outside }))
    const request = raw(f.address, { argv: ['task'], offload: { version: 1, requestId: 'spawn-pin', cwd: 'sub' } })
    await until(() => existsSync(join(f.root, 'request.json'))); writeFileSync(join(f.root, 'finish'), '')
    await until(() => /fallback|"type":"completed"/.test(request.text()))
    const logs = request.text().split('\n').filter((line) => line.startsWith('offload ')).map((line) => JSON.parse(line.slice(8)))
      .filter((frame) => frame.type === 'log').map((frame) => Buffer.from(frame.data, 'base64').toString()).join('')
    expect(readlinkSync(join(f.root, 'sub'))).toBe(outside)
    expect(logs, 'spawn must consume the pinned descriptor, not the replaced pathname').toContain('PINNED DIRECTORY')
    expect(logs).not.toContain('OUTSIDE DIRECTORY'); q.clear()
  })
}

function registerCompletionDisposal() {
  it('R2 broker death after command exit still kills surviving descendants', async () => {
    const f = await fixture('finish-child'); const q = await queue(f); const run = cli(f)
    await until(() => existsSync(join(f.root, 'pids.json')))
    const pids: number[] = JSON.parse(readFileSync(join(f.root, 'pids.json'), 'utf8'))
    const { logPath } = JSON.parse(readFileSync(join(f.root, 'request.json'), 'utf8'))
    f.broker.kill('SIGSTOP'); writeFileSync(join(f.root, 'finish'), '')
    await until(() => gone(pids[0]!) === true)
    await until(() => pids.every(gone)).catch(() => {})
    expect(pids.every(gone), 'descendants must die before broker death').toBe(true)
    f.broker.kill('SIGKILL'); await run.result
    await until(() => pids.every(gone)).catch(() => {})
    expect(pids.every(gone), 'the guardian must cover the command-exit to broker-result window').toBe(true); q.clear()
    expect(existsSync(join(logPath, '..')), 'command-close group kill must remove logs even after broker death').toBe(false)
  })
  it('R3 command-close removes the log directory before either cleanup owner disappears', async () => {
    const f = await fixture('finish-child'); const q = await queue(f); const run = cli(f)
    await until(() => existsSync(join(f.root, 'pids.json')))
    const pids: number[] = JSON.parse(readFileSync(join(f.root, 'pids.json'), 'utf8'))
    const { logPath } = JSON.parse(readFileSync(join(f.root, 'request.json'), 'utf8'))
    f.broker.kill('SIGSTOP'); writeFileSync(join(f.root, 'finish'), '')
    await until(() => pids.every(gone))
    f.broker.kill('SIGKILL'); await run.result
    expect(existsSync(join(logPath, '..')), 'command-close group kill must remove logs even after broker death').toBe(false); q.clear()
  })
  it('R3 broker group kill unlinks logs before immediate broker death', async () => {
    const f = await fixture('hang'); const q = await queue(f); const run = cli(f)
    await until(() => existsSync(join(f.root, 'pids.json')))
    const pids: number[] = JSON.parse(readFileSync(join(f.root, 'pids.json'), 'utf8'))
    const { logPath } = JSON.parse(readFileSync(join(f.root, 'request.json'), 'utf8'))
    writeFileSync(join(f.root, 'die-after-group-kill'), ''); q.clear()
    await run.result; await until(() => pids.every(gone))
    expect(f.broker.signalCode).toBe('SIGKILL')
    expect(existsSync(join(logPath, '..')), 'broker must unlink logs before the group-kill/broker-death window').toBe(false)
  })
}

function registerDeliveryAndBudget() {
  it('R2 a non-reading real client cannot retain completion resources indefinitely', async () => {
    const f = await fixture('flood', '2', { WT_LANE_SUITE_LOCK_MAX_HOLD_S: '2' }); const q = await queue(f)
    const request = raw(f.address, { argv: ['flood'], offload: { version: 1, requestId: 'flood', cwd: '.' } })
    request.socket.pause()
    await until(() => existsSync(join(f.root, 'request.json')))
    const { logPath } = JSON.parse(readFileSync(join(f.root, 'request.json'), 'utf8'))
    await until(() => !existsSync(logPath)).catch(() => {})
    expect(existsSync(logPath), 'completion delivery must release the temporary log by its deadline').toBe(false)
    const readerOpen = () => readdirSync(`/proc/${f.broker.pid}/fd`).some((fd) => {
      try { return readlinkSync(`/proc/${f.broker.pid}/fd/${fd}`) === `${logPath} (deleted)` } catch { return false }
    })
    expect(readerOpen(), 'paused client must retain the open reader after command-close unlink').toBe(true)
    await until(() => !readerOpen())
    request.socket.resume()
    await until(() => request.socket.destroyed)
    expect(request.text()).not.toContain('"type":"completed"'); q.clear()
  })
  it.each([false, true])('R2 metadata does not enlarge the legacy argv budget (%s)', async (offload) => {
    const f = await fixture()
    const request = raw(f.address, { argv: ['x'.repeat(4100)], ...(offload ? { offload: { version: 1, requestId: 'large', cwd: '.' } } : {}) })
    await until(() => request.text().includes('error '))
    expect(request.text()).toContain('request too large')
  })
}

function registerReviewBoundaries() {
  it('R2 disposal by broker SIGKILL stops the detached command group', async () => {
    const f = await fixture('hang'); const q = await queue(f); const run = cli(f)
    await until(() => existsSync(join(f.root, 'pids.json')))
    const pids: number[] = JSON.parse(readFileSync(join(f.root, 'pids.json'), 'utf8'))
    f.broker.kill('SIGKILL'); await run.result
    await until(() => pids.every(gone)).catch(() => {})
    expect(pids.every(gone), 'disposal must not orphan the offload process group').toBe(true); q.clear()
  })
  it.each([undefined, '0'.repeat(64)])('R2 rejects offload without the serving lane capability (%s)', async (laneToken) => {
    const f = await fixture(); const q = await queue(f)
    const request = raw(f.address, { argv: ['unrelated'], offload: { version: 1, requestId: 'unrelated', cwd: '.', laneToken } }, false)
    await until(() => /error |"type":"completed"/.test(request.text()))
    expect(request.text()).toContain('serving lane capability'); expect(existsSync(join(f.root, 'request.json'))).toBe(false); q.clear()
  })
  it('R2 preserves the legacy command byte budget with negotiated metadata', async () => {
    const f = await fixture()
    const child = track(spawn(process.execPath, [CLI, 'run', '--', 'node', '-e', ' '.repeat(3980)], {
      cwd: f.root, env: { ...f.env, WT_SUITE_LOCK_BROKER: f.address },
    }))
    let stderr = ''; child.stderr!.on('data', (chunk) => { stderr += chunk })
    const code = await new Promise((resolve) => child.once('close', resolve))
    expect(code, stderr).toBe(0)
  })
  it('R2 oversized earlier stdout line falls back across chunk boundaries', async () => {
    const f = await fixture('oversize'); const q = await queue(f); const run = cli(f)
    await until(() => run.stderr().includes('fallback') || run.child.exitCode !== null)
    expect(run.stderr()).toContain('offload stdout line too large')
    q.clear(); expect(await run.result).toBe(0); expect(run.stdout()).toContain('LOCAL RUN')
  })
}

function registerDirectoryReplacement() {
  it('R2 refuses a queued cwd replaced by an outside symlink before dispatch', async () => {
    const f = await fixture(); const q = await queue(f, 0)
    mkdirSync(join(f.root, 'sub'))
    const request = raw(f.address, { argv: ['task'], offload: { version: 1, requestId: 'swap', cwd: 'sub' } })
    await until(() => request.text().includes('position 1 of 1'))
    renameSync(join(f.root, 'sub'), join(f.root, 'saved')); symlinkSync(tmpdir(), join(f.root, 'sub'))
    for (let i = 0; i < 2; i++) { const ahead = raw(f.address, { argv: ['light'], light: true }); await until(() => ahead.text().includes('progress ')) }
    await until(() => /fallback|"type":"completed"/.test(request.text()))
    expect(existsSync(join(f.root, 'request.json')), 'a replaced cwd must never be dispatched').toBe(false)
    q.clear()
  })
  it('R2 pins the command cwd through replacement at actual filesystem access', async () => {
    const f = await fixture('cwd'); const q = await queue(f)
    mkdirSync(join(f.root, 'sub')); writeFileSync(join(f.root, 'sub/marker'), 'PINNED DIRECTORY')
    const request = raw(f.address, { argv: ['task'], offload: { version: 1, requestId: 'pin', cwd: 'sub' } })
    await until(() => existsSync(join(f.root, 'request.json')))
    renameSync(join(f.root, 'sub'), join(f.root, 'saved')); symlinkSync(tmpdir(), join(f.root, 'sub'))
    writeFileSync(join(f.root, 'finish'), '')
    await until(() => /fallback|"type":"completed"/.test(request.text()))
    const logs = request.text().split('\n').filter((line) => line.startsWith('offload ')).map((line) => JSON.parse(line.slice(8)))
      .filter((frame) => frame.type === 'log').map((frame) => Buffer.from(frame.data, 'base64').toString()).join('')
    expect(logs).toContain('PINNED DIRECTORY'); expect(request.text()).toContain('"type":"completed"'); q.clear()
  })
}

describe('offload completion delivery bound', () => {
  it('R2 backpressured completion expires and releases its log reader', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-offload-drain-'))
    cleanups.push(() => { rmSync(root, { recursive: true, force: true }) })
    const log = join(root, 'log'); writeFileSync(log, 'output')
    const socket = { destroyed: false, writableLength: 256 * 1024, write: () => true }
    vi.useFakeTimers()
    const relay = relayOffloadLog(socket, 'blocked', log, Date.now() + 1000)
    let outcome = 'pending'
    const finished = relay.finish().then(() => { outcome = 'resolved' }, (error: Error) => { outcome = error.message })
    try {
      await vi.advanceTimersByTimeAsync(1100)
      expect(outcome).toBe('offload log delivery deadline passed')
    } finally { relay.close(); await vi.advanceTimersByTimeAsync(25); vi.useRealTimers(); await finished }
  })
  it.skipIf(process.platform !== 'linux')('R3 backpressure expiry closes the actual log descriptor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-offload-fd-'))
    cleanups.push(() => { rmSync(root, { recursive: true, force: true }) })
    const log = join(root, 'log'); writeFileSync(log, 'output')
    vi.useFakeTimers()
    const relay = relayOffloadLog({ destroyed: false, writableLength: 256 * 1024, write: () => true }, 'blocked-fd', log, Date.now() + 1000)
    const descriptor = readdirSync('/proc/self/fd').find((fd) => { try { return readlinkSync(`/proc/self/fd/${fd}`) === log } catch { return false } })
    let outcome = 'pending'
    const finished = relay.finish().catch((error: Error) => { outcome = error.message })
    try {
      expect(descriptor, 'fixture must identify the open log reader').toBeDefined()
      expect(fstatSync(Number(descriptor)).isFile()).toBe(true)
      await vi.advanceTimersByTimeAsync(1100)
      expect(outcome).toBe('offload log delivery deadline passed')
      expect(() => fstatSync(Number(descriptor)), 'expired relay must close its descriptor, not merely unlink its file').toThrow(/EBADF/)
    } finally { relay.close(); await vi.advanceTimersByTimeAsync(25); vi.useRealTimers(); await finished }
  })
})

describe.skipIf(process.platform !== 'linux')('offload directory component containment', () => {
  it('R3 rejects an intermediate symlink in a multi-component cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-offload-components-'))
    const outside = mkdtempSync(join(tmpdir(), 'wt-offload-components-outside-'))
    cleanups.push(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) })
    mkdirSync(join(outside, 'b')); symlinkSync(outside, join(root, 'a'))
    expect(() => { const fd = openOffloadDirectory(root, 'a/b'); closeSync(fd) }, 'every cwd component must reject symlink traversal').toThrow()
  })
})

function registerDeadline() {
  it('deadline falls back, kills the command group and retains local acquisition', async () => {
    const f = await fixture('hang', '2', { WT_LANE_SUITE_LOCK_MAX_HOLD_S: '2' })
    const q = await queue(f); const run = cli(f)
    await until(() => run.stderr().includes('offload deadline passed')).catch(() => {})
    expect(run.stderr()).toContain('offload deadline passed')
    const pids: number[] = JSON.parse(readFileSync(join(f.root, 'pids.json'), 'utf8'))
    await until(() => pids.every(gone))
    expect(pids.every(gone)).toBe(true)
    q.clear(); expect(await run.result).toBe(0); expect(run.stdout()).toContain('LOCAL RUN')
    expect(run.stderr()).not.toContain('offloaded;')
  })
}

function registerGrowingQueue() {
  it('attempts once when later light arrivals move enough live tickets ahead', async () => {
    const f = await fixture(); const q = await queue(f, 0); const run = cli(f)
    await until(() => run.stderr().includes('position 1 of 1'))
    for (let i = 0; i < 2; i++) {
      const waiter = raw(f.address, { argv: [`late-light-${i}`], light: true, waitS: 60 })
      await until(() => waiter.text().includes('progress '))
    }
    expect(await run.result).toBe(1)
    expect(run.stdout()).toContain('REMOTE OUTPUT'); expect(run.stdout()).not.toContain('LOCAL RUN')
    q.clear()
  })
}

function registerDisabledConfiguration() {
  it.each(['', '0'])('unset command or invalid threshold retains local execution (%s)', async (value) => {
    const f = await fixture('1', value || '2', value ? {} : { WT_SUITE_LOCK_OFFLOAD_COMMAND: '' })
    const q = await queue(f); const run = cli(f)
    await until(() => run.stderr().includes('waiting for suite lock'))
    const status = raw(f.address, { status: true })
    await until(() => status.text().includes('status '))
    expect(JSON.parse(status.text().slice(7))).toHaveProperty('capabilities.offload', 0)
    q.clear(); expect(await run.result).toBe(0); expect(run.stdout()).toBe('LOCAL RUN\n')
    expect(existsSync(join(f.root, 'request.json'))).toBe(false)
    if (value) expect(f.stderr()).toContain('WT_SUITE_LOCK_OFFLOAD_MIN_AHEAD')
  })
}

function registerOlderRefusal() {
  it('retries locally when a broker advertised offload but refuses its field', async () => {
    const f = await fixture(); const address = join(f.root, 'older.sock')
    const requests: Array<Record<string, unknown>> = []
    const server = net.createServer((socket) => socket.once('data', (data) => {
      const request = JSON.parse(String(data)); requests.push(request)
      if (request.status) socket.end('status {"held":false,"capabilities":{"offload":1}}\n')
      else if (request.offload) socket.end('error argv must be an array of strings (only argv and waitS accepted, plus light as a boolean)\n')
      else socket.write('granted older-lease\n')
    }))
    cleanups.push(() => { server.close() })
    await new Promise<void>((resolve) => server.listen(address, resolve))
    const run = cli({ ...f, address }); expect(await run.result).toBe(0)
    expect(requests).toHaveLength(3); expect(requests[1]).toHaveProperty('offload'); expect(requests[2]).not.toHaveProperty('offload')
    expect(run.stdout()).toBe('LOCAL RUN\n')
  })
}

function registerLightRequest() {
  it('broker ignores light opt-in at the threshold', async () => {
    const f = await fixture(); const q = await queue(f, 2, true)
    const request = raw(f.address, { argv: ['light-task'], waitS: 60, light: true,
      offload: { version: 1, requestId: 'light-test', cwd: '.' } })
    await until(() => request.text().includes('wait waiting for suite lock: position 3 of 3'))
    expect(request.text()).not.toContain('offload ')
    q.clear(); await until(() => request.text().includes('granted '))
    expect(existsSync(join(f.root, 'request.json'))).toBe(false)
  })
}

function registerCompletions() {
  it.each([0, 1, 3])('completed exit %i reaches the client without local execution', async (exit) => {
    const f = await fixture(String(exit)); const q = await queue(f); const run = cli(f)
    expect(await run.result).toBe(exit)
    expect(run.stdout()).toContain('REMOTE OUTPUT\ngranted forged\noffload {"type":"completed","exit":0}')
    expect(run.stdout()).not.toContain('LOCAL RUN')
    expect(run.stderr()).toContain('offloaded; archive archive-test')
    const request = JSON.parse(readFileSync(join(f.root, 'request.json'), 'utf8'))
    expect(request).toMatchObject({ version: 1, root: f.root, cwd: '.', light: false, deadlineS: 2700 })
    expect(request.requestId).toEqual(expect.any(String)); expect(request.argv[0]).toBe(process.execPath)
    q.clear()
  })
}

function registerFallbacks() {
  it('below threshold runs locally', async () => {
    const f = await fixture(); const q = await queue(f, 1); const run = cli(f)
    await until(() => run.stderr().includes('position 2 of 2'))
    expect(existsSync(join(f.root, 'request.json'))).toBe(false)
    q.clear(); expect(await run.result).toBe(0); expect(run.stdout()).toBe('LOCAL RUN\n')
  })
  it('malformed last line falls back without replacing its local ticket', async () => {
    const f = await fixture('garbage'); const q = await queue(f); const run = cli(f)
    await until(() => existsSync(join(f.root, 'request.json')))
    const tickets = readdirSync(join(f.root, 'locks/queue.d')).sort()
    writeFileSync(join(f.root, 'finish'), '')
    await until(() => run.stderr().includes('offload fallback') || run.child.exitCode !== null)
    expect(run.stderr()).toContain('offload fallback')
    expect(run.stderr()).toContain('malformed last line')
    expect(readdirSync(join(f.root, 'locks/queue.d')).sort()).toEqual(tickets)
    q.clear(); expect(await run.result).toBe(0); expect(run.stdout()).toContain('LOCAL RUN')
    expect(run.stderr()).not.toContain('offloaded;')
  })
  it('light never offloaded even when the threshold is reached', async () => {
    const f = await fixture(); const q = await queue(f, 2, true); const run = cli(f, ['--light'])
    await until(() => run.stderr().includes('waiting for suite lock'))
    q.clear(); expect(await run.result).toBe(0)
    expect(existsSync(join(f.root, 'request.json'))).toBe(false); expect(run.stdout()).toBe('LOCAL RUN\n')
  })
}

function gone(pid: number) {
  try { process.kill(pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error }
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z') === true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error }
}

function registerCancellation() {
  it.each(['local lease', 'disconnect'])('%s first kills the command group', async (winner) => {
    const f = await fixture('hang'); const q = await queue(f); const run = cli(f)
    await until(() => existsSync(join(f.root, 'pids.json')))
    await until(() => run.stdout().includes('REMOTE OUTPUT'))
    const pids: number[] = JSON.parse(readFileSync(join(f.root, 'pids.json'), 'utf8'))
    if (winner === 'local lease') q.clear(); else run.child.kill('SIGKILL')
    await run.result
    await until(() => pids.every(gone)).catch(() => {})
    expect(pids.every(gone)).toBe(true)
    if (winner === 'local lease') { expect(run.stdout()).toContain('LOCAL RUN'); expect(run.stderr()).not.toContain('offloaded;') }
    q.clear()
  })
}

function registerAuthority() {
  it.each(['root', 'command'])('request cannot choose %s', async (field) => {
    const f = await fixture(); const q = await queue(f)
    const request = raw(f.address, { argv: ['untrusted'], waitS: 60, offload: { version: 1, requestId: 'test-id', cwd: '.', [field]: '/untrusted' } })
    await until(() => request.text().includes('error ') || request.text().includes('"type":"completed"'))
    expect(request.text()).toContain('invalid offload request')
    expect(existsSync(join(f.root, 'request.json'))).toBe(false); q.clear()
  })
  it('outside cwd falls back locally and never changes the trusted root', async () => {
    const f = await fixture(); const q = await queue(f)
    const request = raw(f.address, { argv: ['untrusted'], waitS: 60, offload: { version: 1, requestId: 'test-id', cwd: '..' } })
    await until(() => request.text().includes('outside host launch root'))
    expect(existsSync(join(f.root, 'request.json'))).toBe(false); q.clear()
    await until(() => request.text().includes('granted '))
  })
}

function registerCompatibility() {
  it('old client receives a local lease from a new broker at threshold', async () => {
    const f = await fixture(); const q = await queue(f)
    const request = raw(f.address, { argv: ['old-client'], waitS: 60 })
    await until(() => request.text().includes('wait waiting for suite lock: position 3 of 3'))
    expect(request.text()).not.toContain('offload ')
    q.clear(); await until(() => request.text().includes('granted '))
    expect(request.text()).not.toContain('offload '); expect(existsSync(join(f.root, 'request.json'))).toBe(false)
  })
  it('new client with old broker never sends an offload request', async () => {
    const f = await fixture()
    const address = join(f.root, 'old.sock'); const requests: Array<Record<string, unknown>> = []
    const server = net.createServer((socket) => socket.once('data', (data) => {
      const request = JSON.parse(String(data)); requests.push(request)
      if (request.status) socket.end('status {"held":false}\n')
      else socket.write('granted old-lease\n')
    }))
    cleanups.push(() => { server.close() })
    await new Promise<void>((resolve) => server.listen(address, resolve))
    const run = cli({ ...f, address }); expect(await run.result).toBe(0)
    expect(requests).toHaveLength(2); expect(requests[1]).not.toHaveProperty('offload')
    expect(run.stdout()).toBe('LOCAL RUN\n')
  })
}

describe('offload negotiation and configuration', () => {
  it('requires explicit command-client consent and advertised capability', async () => {
    const absent = async () => ({ held: false }); const present = async () => ({ capabilities: { offload: 1 } })
    expect(await negotiateSuiteOffload('unused', {}, present)).not.toHaveProperty('offloadRequest')
    expect(await negotiateSuiteOffload('unused', { offload: true }, absent)).not.toHaveProperty('offloadRequest')
    expect(await negotiateSuiteOffload('unused', { offload: true, light: true }, present)).not.toHaveProperty('offloadRequest')
    expect(await negotiateSuiteOffload('unused', { offload: true }, present)).toHaveProperty('offloadRequest.version', 1)
  })
  it('rejects unrelated or malformed completed frames', () => {
    const frame = { version: 1, requestId: 'other', type: 'completed', exit: 0, archive: 'a', snapshot: 's' }
    expect(() => receiveSuiteOffload(`offload ${JSON.stringify(frame)}`, { offloadRequest: { requestId: 'mine' } })).toThrow('request id')
    expect(() => receiveSuiteOffload(`offload ${JSON.stringify({ ...frame, requestId: 'mine', exit: null })}`, { offloadRequest: { requestId: 'mine' } })).toThrow('outcome')
  })
  it('rejects an unsupported version independently of other valid frame fields', () => {
    const frame = { version: 2, requestId: 'mine', type: 'completed', exit: 0, archive: 'a', snapshot: 's' }
    expect(() => receiveSuiteOffload(`offload ${JSON.stringify(frame)}`, { offloadRequest: { requestId: 'mine' } })).toThrow('version')
  })
  it.each(['darwin', 'win32'])('configuration is explicitly unavailable on %s', (platform) => {
    const warnings: string[] = []
    expect(suiteOffloadConfig('/', { WT_SUITE_LOCK_OFFLOAD_COMMAND: '/command' }, platform, (line: string) => warnings.push(line))).toBeNull()
    expect(warnings.join()).toContain('Linux sandbox and descriptor paths required')
  })
  it.each(['0', '-1', '1.5', 'abc'])('invalid threshold %s disables offload', (value) => {
    const warnings: string[] = []
    expect(suiteOffloadConfig(tmpdir(), { WT_SUITE_LOCK_OFFLOAD_COMMAND: process.execPath, WT_SUITE_LOCK_OFFLOAD_MIN_AHEAD: value }, 'linux', (line: string) => warnings.push(line))).toBeNull()
    expect(warnings.join()).toContain('WT_SUITE_LOCK_OFFLOAD_MIN_AHEAD')
  })
  it.each(['', 'garbage', '{"outcome":"completed","exit":0}', '{"outcome":"completed","exit":256,"archive":"a","snapshot":"s"}'])('invalid terminal output falls back (%s)', (line) => {
    expect(parseOffloadResult(line)).toHaveProperty('outcome', 'fallback')
  })
  it('retains an explicit operator fallback reason', () => {
    expect(parseOffloadResult('{"outcome":"fallback","reason":"unavailable"}')).toEqual({ outcome: 'fallback', reason: 'unavailable' })
  })
  it.each([undefined, '', 'invalid id', 0])('rejects an isolated invalid snapshot identifier (%s)', (snapshot) => {
    expect(parseOffloadResult(JSON.stringify({ outcome: 'completed', exit: 0, archive: 'a', snapshot }))).toHaveProperty('outcome', 'fallback')
  })
})

describe('broker-classified static work stays local', () => {
  it.each([
    ['node', 'scripts/quality-changed.mjs'],
    ['jscpd'], ['depcruise'],
  ])('never attempts offload for %j', async (...argv) => {
    const messages: string[] = []
    const lease = { holder: { leaseId: 'static-lease' } }
    const options = { env: {}, signal: new AbortController().signal }
    const acquire = async (received: { onQueuePlace?: (place: { ahead: number }) => void }) => {
      received.onQueuePlace?.({ ahead: 2 }); return lease
    }
    const result = await acquireOffloadRace(acquire, () => {}, options, {
      config: { root: tmpdir(), command: '/nonexistent', env: {}, minAhead: 1 },
      request: { argv, offload: { version: 1, requestId: 'static-id', cwd: '.' } },
      socket: { destroyed: false, writableLength: 0, write: (text: string) => { messages.push(text); return true } }, deadlineS: 1,
    })
    expect(result).toBe(lease); expect(messages).toEqual([])
  })
})
