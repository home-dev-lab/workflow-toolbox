import { readFileSync } from 'node:fs'
import { freemem, platform, totalmem } from 'node:os'
import { basename } from 'node:path'
import { spawnSync } from 'node:child_process'

import { outputPath, provenance, writeEvidence } from './probe-lib.mjs'

const destination = outputPath('memory-available')
const scratch = `${destination}.native`

const errorRecord = (error) => error === undefined
  ? null
  : {
      message: String(error.message),
      code: error.code ?? null,
      errno: error.errno ?? null,
      syscall: error.syscall ?? null,
    }

const run = (command, args, options = {}) => {
  const started = process.hrtime.bigint()
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: options.timeout ?? 3_000,
      windowsHide: true,
      env: options.env,
    })
    return {
      status: result.error === undefined && result.status === 0 ? 'measured' : 'measurement_failed',
      command: [command, ...args].join(' '),
      exitCode: result.status,
      signal: result.signal,
      durationMilliseconds: Number(process.hrtime.bigint() - started) / 1_000_000,
      error: errorRecord(result.error),
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
    }
  } catch (error) {
    return {
      status: 'measurement_failed',
      command: [command, ...args].join(' '),
      exitCode: null,
      signal: null,
      durationMilliseconds: Number(process.hrtime.bigint() - started) / 1_000_000,
      error: errorRecord(error),
      stdout: '',
      stderr: '',
    }
  }
}

const osMemory = () => {
  try {
    return { status: 'measured', freeBytes: freemem(), totalBytes: totalmem() }
  } catch (error) {
    return { status: 'measurement_failed', error: errorRecord(error) }
  }
}

const linux = () => {
  if (platform() !== 'linux') return { status: 'not_applicable', reason: 'This host is not Linux.' }
  try {
    const raw = readFileSync('/proc/meminfo', 'utf8')
    const line = raw.split(/\r?\n/).find((entry) => entry.startsWith('MemAvailable:'))
    return line === undefined
      ? { status: 'measurement_failed', source: '/proc/meminfo', error: { message: 'MemAvailable line is missing' }, raw: null }
      : { status: 'measured', source: '/proc/meminfo', raw: line }
  } catch (error) {
    return { status: 'measurement_failed', source: '/proc/meminfo', error: errorRecord(error), raw: null }
  }
}

const macos = () => {
  if (platform() !== 'darwin') return { status: 'not_applicable', reason: 'This host is not macOS.' }
  const vmStat = run('vm_stat', [])
  return {
    status: vmStat.status,
    vmStat,
    pageSizeBytes: /page size of (\d+) bytes/.exec(vmStat.stdout)?.[1] ?? null,
    totalMemory: run('sysctl', ['hw.memsize']),
    memoryPressure: run('memory_pressure', ['-Q']),
    note: 'Raw vm_stat fields are retained so free, inactive, speculative, and purgeable can be recomputed without assuming whether fields overlap.',
  }
}

const windows = () => {
  if (platform() !== 'win32') return { status: 'not_applicable', reason: 'This host is not Windows.' }
  const command = 'powershell.exe'
  const args = ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory']
  return {
    status: 'attempted',
    timeoutMilliseconds: 3_000,
    wtLaneEnvironment: run(command, args, { timeout: 3_000, env: { PATH: process.env.PATH ?? '', LC_ALL: 'C' } }),
    inheritedEnvironment: run(command, args, { timeout: 3_000, env: process.env }),
    windowsBootstrapEnvironment: run(command, args, {
      timeout: 3_000,
      env: {
        PATH: process.env.PATH ?? '',
        LC_ALL: 'C',
        SystemRoot: process.env.SystemRoot ?? '',
        windir: process.env.windir ?? '',
        SystemDrive: process.env.SystemDrive ?? '',
      },
    }),
  }
}

const command = `node ${basename(import.meta.filename)} ${destination}`
writeEvidence(destination, {
  provenance: provenance('memory-available', command, `${scratch}.provenance`),
  osMemory: osMemory(),
  linux: linux(),
  macos: macos(),
  windows: windows(),
})
