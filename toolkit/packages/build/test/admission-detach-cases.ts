// Registered by the existing process-spawning descriptor suite, not as a new parallel file.
import childProcess, { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const PLUGIN = process.env.WT_ADMISSION_DETACH_TEST_PLUGIN ?? join(ROOT, 'plugin')
const { boundedAdmission } = await import(pathToFileURL(join(PLUGIN, 'bin/lib/host/admission.mjs')).href)
const { admissionCleanupIdentity, admissionCleanupLimitation, cleanupAdmissionDescendants } = await import(pathToFileURL(join(PLUGIN, 'bin/lib/host/admission-process.mjs')).href)
const variable = 'WT_DETACH_ADMISSION'
const timeoutVariable = `${variable}_TIMEOUT_MS`
const hasPidfds = process.platform === 'linux' && spawnSync('/usr/bin/python3', ['-I', '-c',
  'import os, signal; fd = os.pidfd_open(os.getpid()); signal.pidfd_send_signal(fd, 0); os.close(fd)',
], { stdio: 'ignore' }).status === 0
type Mode = 'admit' | 'refuse' | 'throw' | 'timeout' | 'abort' | 'sync-timeout' | 'supervisor-death'
type Host = { platform: string; fork: typeof childProcess.fork }

export function running(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return !['Z', 'X', 'x'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]!)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function until(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 3000
  while (!predicate() && performance.now() < deadline) await sleep(10)
  expect(predicate(), message).toBe(true)
}

function fixture(mode: Mode, inherit: boolean, nested = false, orphaned = false) {
  const root = mkdtempSync(join(tmpdir(), 'admission-detach-'))
  const policy = join(root, 'policy.mjs'), marker = join(root, 'pids.json'), ready = join(root, 'ready')
  const sleeper = 'setInterval(() => {}, 60000)'
  const code = nested ? `const child = spawn(process.execPath, ['-e', ${JSON.stringify(sleeper)}], { detached: true, stdio: 'ignore' });
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid, child.pid])); child.unref(); ${orphaned ? '' : sleeper}` : sleeper
  const script = nested ? `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); ${code}` : code
  writeFileSync(policy, `import { spawn } from 'node:child_process'; import { existsSync, writeFileSync } from 'node:fs';
    export default async () => {
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(script)}], { detached: true, stdio: ${JSON.stringify(inherit ? ['ignore', 'inherit', 'inherit'] : 'ignore')} });
      ${nested ? `while (!existsSync(${JSON.stringify(marker)})) await new Promise(resolve => setTimeout(resolve, 5));` : `writeFileSync(${JSON.stringify(marker)}, JSON.stringify([child.pid]));`}
      ${orphaned ? `await new Promise(resolve => child.once("exit", resolve)); writeFileSync(${JSON.stringify(ready)}, 'orphaned');` : ''}
      child.unref(); ${policyFinish(mode)};
    }`)
  return { root, policy, marker, ready }
}

function policyFinish(mode: Mode) {
  if (mode === 'admit') return 'return null'
  if (mode === 'refuse') return 'return "policy refuses"'
  if (mode === 'throw') return 'throw new Error("policy failed")'
  if (mode === 'sync-timeout') return 'while (true) {}'
  if (mode === 'supervisor-death') return 'process.kill(process.pid, "SIGKILL"); return new Promise(() => {})'
  return 'return new Promise(() => {})'
}

function expected(mode: Mode, timeout: number) {
  if (mode === 'admit') return null
  if (mode === 'refuse') return `${variable}: policy refuses`
  if (mode === 'throw') return `${variable}: admission module failed: policy failed`
  if (mode === 'abort') return `${variable}: interrupted during admission`
  if (mode === 'supervisor-death') return `${variable}: admission worker exited without a verdict`
  return `${variable}: timed out after ${timeout} ms`
}

export async function exercise(mode: Mode, inherit: boolean, nested = false, orphaned = false, host?: Host) {
  const f = fixture(mode, inherit, nested, orphaned), controller = new AbortController()
  const timeout = mode.includes('timeout') ? 1200 : 5000
  const sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })
  const siblingExit = once(sibling, 'exit')
  try {
    const result = boundedAdmission({ repo: f.root, request: {}, signal: controller.signal }, {
      SystemRoot: process.env.SystemRoot, [variable]: f.policy, [timeoutVariable]: String(timeout),
    }, { moduleVariable: variable, timeoutVariable, silent: true, host })
    if (mode === 'abort') {
      await until(() => existsSync(orphaned ? f.ready : f.marker), 'policy must spawn and orphan its daemon before abort')
      controller.abort()
    }
    const refusal = await result
    if (mode === 'supervisor-death') expect(refusal).toContain('admission worker exited')
    else expect(refusal).toBe(expected(mode, timeout))
    expect(existsSync(f.marker), 'policy must actually start its detached helper').toBe(true)
    const pids = JSON.parse(readFileSync(f.marker, 'utf8')) as number[]
    for (const pid of pids) expect(running(pid), 'detached policy process must be stopped AT admission return').toBe(false)
    expect(running(sibling.pid!), 'unrelated sibling must remain running').toBe(true)
  } finally {
    if (existsSync(f.marker)) for (const pid of JSON.parse(readFileSync(f.marker, 'utf8')) as number[]) {
      try { process.kill(pid, 'SIGKILL') } catch { /* defensive cleanup on a red run */ }
    }
    sibling.kill('SIGKILL'); await siblingExit
    rmSync(f.root, { recursive: true, force: true })
  }
}

function registerLinuxCases() {
  describe.skipIf(!hasPidfds)('Linux detached cleanup (requires python3/pidfd; macOS and Windows have explicit limitations)', () => {
    describe.each([false, true])('inherited descriptors=%s', inherit => {
      it.each<Mode>(['admit', 'refuse', 'throw', 'timeout', 'abort', 'sync-timeout'])('stops detached helpers on %s', async mode => {
        await exercise(mode, inherit)
      })
    })
    it.each<Mode>(['refuse', 'timeout'])('stops nested helpers in separate sessions on %s', async mode => {
      await exercise(mode, true, true)
    })
  })
}

function registerDiagnosticCases() {
  it.skipIf(process.platform !== 'linux')('emits the platform cleanup limitation even for a silent admitting call', async () => {
    const f = fixture('admit', false)
    writeFileSync(f.policy, 'export default () => null')
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      expect(await boundedAdmission({ repo: f.root, request: {} }, {
        SystemRoot: process.env.SystemRoot, [variable]: f.policy, [timeoutVariable]: '5000',
      }, { moduleVariable: variable, timeoutVariable, silent: true })).toBeNull()
      expect(stderr.mock.calls.map(call => String(call[0])).join('')).toContain(`cleanup limitation (${process.platform})`)
    } finally { stderr.mockRestore(); rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each(['linux', 'darwin', 'win32'])('states the %s containment limitation explicitly', platform => {
    expect(admissionCleanupLimitation(platform)).toContain(`cleanup limitation (${platform})`)
    expect(admissionCleanupLimitation(platform)).toMatch(/can escape|can survive/)
  })
}

function registerFailureCases() {
  it.skipIf(process.platform !== 'linux')('preserves refusal without starting a Linux pidfd cleanup helper', async () => {
    const f = fixture('refuse', false)
    writeFileSync(f.policy, 'export default () => "policy refuses"')
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const start = vi.spyOn(childProcess, 'spawn').mockImplementation(() => { throw new Error('injected helper spawn denied') })
    syncBuiltinESMExports()
    try {
      expect(await boundedAdmission({ repo: f.root, request: {} }, {
        SystemRoot: process.env.SystemRoot, [variable]: f.policy, [timeoutVariable]: '5000',
      }, { moduleVariable: variable, timeoutVariable, silent: true })).toBe(`${variable}: policy refuses`)
      expect(start).not.toHaveBeenCalled()
    } finally { start.mockRestore(); syncBuiltinESMExports(); stderr.mockRestore(); rmSync(f.root, { recursive: true, force: true }) }
  })

  it.skipIf(!hasPidfds)('does not signal a process whose birth identity has changed', async () => {
    const sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })
    const exited = once(sibling, 'exit')
    try {
      const identity = admissionCleanupIdentity(sibling)
      expect(identity).not.toBeNull()
      expect(await cleanupAdmissionDescendants(sibling, { ...identity, start: `${identity.start}0` })).toContain('birth identity changed')
      expect(running(sibling.pid!)).toBe(true)
      const stat = readFileSync(`/proc/${sibling.pid}/stat`, 'utf8')
      expect(['T', 't'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]!)).toBe(false)
    } finally { sibling.kill('SIGKILL'); await exited }
  })
}

export function registerAdmissionDetachCases() {
  registerLinuxCases()
  registerDiagnosticCases()
  registerFailureCases()
}
