import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { spawn } from 'node:child_process'

import { outputPath, provenance, writeEvidence } from './probe-lib.mjs'

const destination = outputPath('spawn-shims')
const scratch = `${destination}.native`
const root = mkdtempSync(join(tmpdir(), 'wt-host-spawn-probe-'))

const errorRecord = (error) => ({
  message: String(error.message),
  code: error.code ?? null,
  errno: error.errno ?? null,
  syscall: error.syscall ?? null,
})

const measureSpawn = (name, command, options) => new Promise((resolve) => {
  const started = process.hrtime.bigint()
  const events = []
  let child
  let stdout = ''
  let stderr = ''
  let synchronousError = null
  let settled = false
  const finish = (timedOut = false) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    resolve({
      name,
      command,
      options: { shell: options.shell ?? false },
      spawnReturned: child !== undefined,
      pid: child?.pid ?? null,
      synchronousError,
      events,
      stdout,
      stderr,
      timedOut,
      durationMilliseconds: Number(process.hrtime.bigint() - started) / 1_000_000,
    })
  }
  const timer = setTimeout(() => {
    try { child?.kill('SIGKILL') } catch { /* The process may already have exited. */ }
    finish(true)
  }, 5_000)
  try {
    child = spawn(command, [], { ...options, windowsHide: true })
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => events.push({ event: 'error', error: errorRecord(error) }))
    child.on('exit', (code, signal) => events.push({ event: 'exit', code, signal }))
    child.on('close', (code, signal) => {
      events.push({ event: 'close', code, signal })
      finish()
    })
  } catch (error) {
    synchronousError = errorRecord(error)
    finish()
  }
})

async function runProbe() {
  const missingName = `wt-probe-command-that-does-not-exist-${String(process.pid)}`
  const nonExecutable = join(root, platform() === 'win32' ? 'not-executable.txt' : 'not-executable')
  writeFileSync(nonExecutable, platform() === 'win32' ? 'This is not an executable.\r\n' : '#!/bin/sh\nexit 0\n', 'utf8')
  if (platform() !== 'win32') chmodSync(nonExecutable, 0o644)

  const measurements = {
    missingCommand: await measureSpawn('missing command, shell false', missingName, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }),
    existingNonExecutable: await measureSpawn('existing non-executable file, shell false', nonExecutable, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }),
  }

  if (platform() === 'win32') {
    const shim = join(root, 'probe-shim.cmd')
    writeFileSync(shim, '@echo probe-shim-ran\r\n', 'utf8')
    const env = { ...process.env, PATH: `${root}${delimiter}${process.env.PATH ?? ''}` }
    measurements.windowsCommandShim = {
      bareShellFalse: await measureSpawn('probe-shim, shell false', 'probe-shim', { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'], cwd: root }),
      extensionShellFalse: await measureSpawn('probe-shim.cmd, shell false', 'probe-shim.cmd', { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'], cwd: root }),
      bareShellTrue: await measureSpawn('probe-shim, shell true', 'probe-shim', { shell: true, env, stdio: ['ignore', 'pipe', 'pipe'], cwd: root }),
    }
  } else {
    measurements.windowsCommandShim = { status: 'not_applicable', reason: 'cmd shims are a Windows host behavior.' }
  }

  rmSync(root, { recursive: true, force: true })
  const command = `node ${basename(import.meta.filename)} ${destination}`
  writeEvidence(destination, {
    provenance: provenance('spawn-shims', command, `${scratch}.provenance`),
    measurements,
  })
}

await runProbe()
