import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error Plain ESM test-support script has no TypeScript declarations.
import { spawnHeld, stopHeld } from '../../../test-support/held-processes.mjs'

const FIXTURE = pathToFileURL(join(import.meta.dirname, '../../../test-support/held-processes.mjs')).href
const POSIX = process.platform !== 'win32'
const dirs: string[] = []
afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wt-held-processes-'))
  dirs.push(dir)
  return dir
}

// A wrapper that starts a keepalive grandchild and writes the grandchild's pid: the shape of
// `wt-suite-lock run -- node -e …`, whose child outlives a wrapper killed with SIGKILL.
function wrapperSource(pidFile: string): string {
  return `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

// The cap only bounds a hang; every wait below exits on the predicate. Process death of a
// re-parented grandchild has no event this process can await, so it is polled.
async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

async function grandchildOf(pidFile: string): Promise<number> {
  expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '')).toBe(true)
  return Number(readFileSync(pidFile, 'utf8'))
}

describe.skipIf(!POSIX)('held test processes (skips: process groups are POSIX-only)', () => {
  it('stopHeld kills the grandchild a wrapper started, not only the wrapper', async () => {
    const pidFile = join(scratch(), 'grandchild.pid')
    const wrapper = spawnHeld(process.execPath, ['-e', wrapperSource(pidFile)], { stdio: 'ignore' })
    const grandchild = await grandchildOf(pidFile)
    const exited = new Promise((resolve) => wrapper.once('exit', resolve))
    stopHeld(wrapper)
    await exited
    expect(await waitFor(() => !alive(grandchild)), `grandchild ${grandchild} survived stopHeld`).toBe(true)
  })

  let leftBehind = 0
  it('leaves a held wrapper running at the end of a test (setup for the next case)', async () => {
    const pidFile = join(scratch(), 'left.pid')
    spawnHeld(process.execPath, ['-e', wrapperSource(pidFile)], { stdio: 'ignore' })
    leftBehind = await grandchildOf(pidFile)
    expect(alive(leftBehind)).toBe(true)
  })

  it('reaps what the previous test left running, in the afterEach of the shared setup', async () => {
    expect(leftBehind).toBeGreaterThan(0)
    expect(await waitFor(() => !alive(leftBehind)), `grandchild ${leftBehind} survived the previous test's teardown`).toBe(true)
  })

  it('reaps held processes when the process that spawned them exits', async () => {
    const pidFile = join(scratch(), 'exit.pid')
    const script = `import {spawnHeld} from ${JSON.stringify(FIXTURE)};import {existsSync,readFileSync} from 'node:fs';spawnHeld(process.execPath,['-e',${JSON.stringify(wrapperSource(pidFile))}],{stdio:'ignore'});const t=setInterval(()=>{if(existsSync(${JSON.stringify(pidFile)})&&readFileSync(${JSON.stringify(pidFile)},'utf8')!==''){clearInterval(t);process.exit(0)}},20)`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 })
    expect(result.status, result.stderr).toBe(0)
    const grandchild = Number(readFileSync(pidFile, 'utf8'))
    expect(await waitFor(() => !alive(grandchild)), `grandchild ${grandchild} survived its spawner's exit`).toBe(true)
  }, 45_000)

  it('stopHeld is a no-op for a group that is already gone', async () => {
    const child = spawnHeld(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await new Promise((resolve) => child.once('exit', resolve))
    expect(() => stopHeld(child)).not.toThrow()
  })

  it('passes spawn options through, so a caller can still pipe output', async () => {
    const child = spawnHeld(process.execPath, ['-e', 'process.stdout.write("held ok")'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout!.on('data', (chunk: Buffer) => { out += String(chunk) })
    await new Promise((resolve) => child.once('close', resolve))
    expect(out).toBe('held ok')
  })
})
