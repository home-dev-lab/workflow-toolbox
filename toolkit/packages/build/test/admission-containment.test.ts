import childProcess, { fork, spawn, spawnSync, type ForkOptions } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { exercise, running } from './admission-detach-cases.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const PLUGIN = process.env.WT_ADMISSION_DETACH_TEST_PLUGIN ?? join(ROOT, 'plugin')
const { boundedAdmission } = await import(pathToFileURL(join(PLUGIN, 'bin/lib/host/admission.mjs')).href)
const { admissionCleanupIdentity, cleanupAdmissionDescendants } = await import(pathToFileURL(join(PLUGIN, 'bin/lib/host/admission-process.mjs')).href)
const variable = 'WT_CONTAINER_ADMISSION', timeoutVariable = `${variable}_TIMEOUT_MS`

function pythonHost(prefix: string) {
  return { platform: 'linux', fork: ((modulePath: string, args: string[], options: ForkOptions) => {
    const execArgv = [...options.execArgv!]
    execArgv[2] = `${prefix}\n${execArgv[2]}`
    return fork(modulePath, args, { ...options, execArgv })
  }) as typeof fork }
}

async function withPythonHost(prefix: string, work: (host: ReturnType<typeof pythonHost>) => Promise<void>) {
  // Also inject the old post-hoc helper, so the same capability counterexample
  // runs against the pre-containment implementation during the revert proof.
  const realSpawn = childProcess.spawn
  const start = vi.spyOn(childProcess, 'spawn').mockImplementation(((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    if (command !== '/usr/bin/python3') return realSpawn(command, args, options)
    const patched = [...args]; patched[2] = `${prefix}\n${patched[2]}`
    return realSpawn(command, patched, options)
  }) as typeof spawn)
  syncBuiltinESMExports()
  try { await work(pythonHost(prefix)) }
  finally { start.mockRestore(); syncBuiltinESMExports() }
}

async function refusedBeforePolicy(host: { platform: string; fork: typeof fork }) {
  const root = mkdtempSync(join(tmpdir(), 'admission-container-'))
  const policy = join(root, 'policy.mjs'), marker = join(root, 'started')
  writeFileSync(policy, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {detached:true, stdio:'ignore'});
    child.unref(); writeFileSync(${JSON.stringify(marker)}, String(child.pid)); export default () => null`)
  try {
    const result = await boundedAdmission({ repo: root, request: {} }, {
      [variable]: policy, [timeoutVariable]: '5000',
    }, { moduleVariable: variable, timeoutVariable, silent: true, host })
    expect(result).toContain('containment unknown')
    expect(existsSync(marker), 'uncontained policy must never execute').toBe(false)
  } finally {
    if (existsSync(marker)) { try { process.kill(Number(readFileSync(marker, 'utf8')), 'SIGKILL') } catch { /* red cleanup */ } }
    rmSync(root, { recursive: true, force: true })
  }
}

const linuxIt = it.skipIf(process.platform !== 'linux')
linuxIt.each(['admit', 'refuse', 'timeout', 'abort'] as const)('reaps a double-fork daemon before %s returns', async mode => {
  await exercise(mode, false, true, true)
})

linuxIt('reaps descendants when the Node supervisor is killed before verdict', async () => {
  const baseHost = pythonHost('import os, time\nreal_kill = os.kill\ndef delayed_kill(pid, signum):\n    time.sleep(0.05)\n    return real_kill(pid, signum)\nos.kill = delayed_kill')
  const host = { platform: 'linux', fork: ((modulePath: string, args: string[], options: ForkOptions) => {
    const child = baseHost.fork(modulePath, args, options)
    child.once('disconnect', () => child.emit('error', new Error('admission worker exited: injected IPC failure')))
    return child
  }) as typeof fork }
  await exercise('supervisor-death', false, false, false, host)
})

linuxIt('contains a real detached child without Python pidfd APIs', async () => {
  await withPythonHost('import os, signal\nif hasattr(os, "pidfd_open"): del os.pidfd_open\nif hasattr(signal, "pidfd_send_signal"): del signal.pidfd_send_signal',
    host => exercise('refuse', false, false, false, host))
})

linuxIt('ignores unreadable unrelated procfs records', async () => {
  await withPythonHost(`import builtins, os
real_open = builtins.open
def restricted_open(path, *args, **kwargs):
    if path == '/proc/1/stat':
        raise PermissionError('unrelated process record is unreadable')
    return real_open(path, *args, **kwargs)
builtins.open = restricted_open
os.listdir = lambda path: (_ for _ in ()).throw(PermissionError('global procfs census forbidden'))`,
    host => exercise('refuse', false, false, false, host))
})

linuxIt('refuses before executing policy when Python cannot start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'admission-missing-python-'))
  const host = { platform: 'linux', fork: ((modulePath: string, args: string[], options: ForkOptions) => fork(modulePath, args, {
    ...options, execPath: join(root, 'python3'),
  })) as typeof fork }
  try { await refusedBeforePolicy(host) }
  finally { rmSync(root, { recursive: true, force: true }) }
})

linuxIt('refuses before executing policy when subreaper installation is denied', async () => {
  await refusedBeforePolicy(pythonHost('import ctypes\nctypes.CDLL = lambda *a, **k: type("Denied", (), {"prctl": lambda *a: -1})()'))
})

linuxIt('reports unknown if the containment owner dies', async () => {
  await refusedBeforePolicy(pythonHost('import os, signal\nos.kill(os.getpid(), signal.SIGKILL)'))
})

linuxIt('legacy census continues past an unreadable unrelated process record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'admission-procfs-')), marker = join(root, 'pid')
  const child = spawn(process.execPath, ['-e', `const {spawn} = require('node:child_process');
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {detached:true, stdio:'ignore'});
    require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(sleeper.pid)); sleeper.unref(); setInterval(() => {}, 60000)`], { stdio: 'ignore' })
  const exited = once(child, 'exit'), realSpawn = childProcess.spawn
  const prefix = `import builtins, os
real_open = builtins.open
def restricted_open(path, *args, **kwargs):
    if path == '/proc/1/stat': raise PermissionError('injected unrelated EACCES')
    return real_open(path, *args, **kwargs)
builtins.open = restricted_open
os.listdir = lambda path: ['1', '${child.pid}', real_open(${JSON.stringify(marker)}).read()]\n`
  const start = vi.spyOn(childProcess, 'spawn').mockImplementation(((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    const patched = [...args]; patched[2] = prefix + patched[2]
    return realSpawn(command, patched, options)
  }) as typeof spawn)
  syncBuiltinESMExports()
  try {
    const deadline = performance.now() + 3000
    while (!existsSync(marker) && performance.now() < deadline) await sleep(5)
    expect(existsSync(marker)).toBe(true)
    const identity = admissionCleanupIdentity(child)
    const limitation = await cleanupAdmissionDescendants(child, identity)
    expect(running(Number(readFileSync(marker, 'utf8'))), 'unrelated EACCES must not hide owned descendants').toBe(false)
    expect(limitation).toBeNull()
  } finally {
    start.mockRestore(); syncBuiltinESMExports()
    if (existsSync(marker)) { try { process.kill(Number(readFileSync(marker, 'utf8')), 'SIGKILL') } catch { /* red cleanup */ } }
    child.kill('SIGKILL'); await exited
    rmSync(root, { recursive: true, force: true })
  }
})

it.each(['darwin', 'win32'])('refuses on %s without launching any uncontained process (injected host)', async platform => {
  const start = vi.fn(() => { throw new Error('must not launch') })
  await refusedBeforePolicy({ platform, fork: start as typeof fork })
  expect(start).not.toHaveBeenCalled()
})

function ownerFailureFixture() {
  const root = mkdtempSync(join(tmpdir(), 'admission-owner-failure-'))
  const marker = join(root, 'supervisor.pid'), ownerMarker = join(root, 'owner.pid')
  const policy = join(root, 'policy.mjs'), runner = join(root, 'runner.mjs')
  writeFileSync(policy, `import { readFileSync, writeFileSync } from 'node:fs'; export default () => {
    const owner = Number(readFileSync(${JSON.stringify(ownerMarker)}, 'utf8'));
    if (owner <= 1 || process.ppid !== owner) throw new Error('test containment owner identity changed');
    writeFileSync(${JSON.stringify(marker)}, String(process.pid));
    process.kill(owner, 'SIGKILL'); return new Promise(() => {});
  }`)
  const admission = pathToFileURL(join(PLUGIN, 'bin/lib/host/admission.mjs')).href
  const env = { [variable]: policy, [timeoutVariable]: '5000' }
  writeFileSync(runner, `import { boundedAdmission } from ${JSON.stringify(admission)};
    import { fork } from 'node:child_process'; import { writeFileSync } from 'node:fs';
    const host = { platform: 'linux', fork: (...args) => {
      const child = fork(...args); writeFileSync(${JSON.stringify(ownerMarker)}, String(child.pid)); return child;
    } };
    const refusal = await boundedAdmission({ repo: ${JSON.stringify(root)}, request: {} }, ${JSON.stringify(env)}, {
      moduleVariable: ${JSON.stringify(variable)}, timeoutVariable: ${JSON.stringify(timeoutVariable)}, silent: true, host,
    });
    console.log(refusal); process.exitCode = 3;`)
  return { root, marker, runner }
}

linuxIt('closes remaining IPC after owner death so the caller can exit with unknown', () => {
  const f = ownerFailureFixture()
  try {
    const result = spawnSync(process.execPath, [f.runner], { encoding: 'utf8', timeout: 2500, killSignal: 'SIGKILL' })
    expect(existsSync(f.marker), 'policy must start before killing its containment owner').toBe(true)
    expect(result.status, result.stdout + result.stderr).toBe(3)
    expect(result.stdout).toContain('containment unknown')
  } finally {
    if (existsSync(f.marker)) { try { process.kill(Number(readFileSync(f.marker, 'utf8')), 'SIGKILL') } catch { /* exact owned supervisor */ } }
    rmSync(f.root, { recursive: true, force: true })
  }
})
