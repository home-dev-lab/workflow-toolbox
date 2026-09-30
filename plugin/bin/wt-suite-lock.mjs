#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { isInvokedDirectly } from './lib/host/entry-guard.mjs'
import { signalCoveredCommand, stopChildForLostSuiteLock } from './lib/host/suite-lock-host.mjs'
import {
  DEFAULT_SUITE_LOCK_STALE_S,
  DEFAULT_SUITE_LOCK_WAIT_S,
  acquireSuiteLock,
  hasSuiteLeaseAsync,
  formatSuiteLockHolder,
  operatorReleaseSuiteLock,
  readBrokerSuiteLock,
  readSuiteLock,
  releaseSuiteLock,
  suiteLeaseMarker,
  suiteLockWaitSeconds,
  spawnNeedsShell,
  windowsShimArgumentRefusal,
} from './lib/suite-lock.mjs'

const USAGE = `Usage:
  node wt-suite-lock.mjs run [--wait-s ${DEFAULT_SUITE_LOCK_WAIT_S}] [--stale-s ${DEFAULT_SUITE_LOCK_STALE_S}] -- <command> [args...]
  node wt-suite-lock.mjs status [--json]
  node wt-suite-lock.mjs release [--force] [--stale-s ${DEFAULT_SUITE_LOCK_STALE_S}]`

function parseSeconds(args, name, fallback) {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  const value = Number(args[index + 1])
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number of seconds`)
  args.splice(index, 2)
  return value
}

function printHelp() {
  process.stdout.write(`${USAGE}\n`)
}

async function run(args) {
  const separator = args.indexOf('--')
  if (separator < 0 || separator === args.length - 1) throw new Error('run requires -- followed by a command')
  const flags = args.slice(0, separator)
  const command = args.slice(separator + 1)
  const waitS = parseSeconds(flags, '--wait-s', suiteLockWaitSeconds())
  const staleS = parseSeconds(flags, '--stale-s', DEFAULT_SUITE_LOCK_STALE_S)
  if (flags.length > 0) throw new Error(`unknown argument: ${flags[0]}`)
  if (process.env.WT_SUITE_LOCK === '0') {
    process.stderr.write('wt-suite-lock: bypassed because WT_SUITE_LOCK=0\n')
    return spawnCommand(command)
  }

  try { if (await hasSuiteLeaseAsync()) return spawnCommand(command) } catch (error) {
    if (error?.code !== 'WT_SUITE_LOCK_UNAVAILABLE') throw error
    process.stderr.write(`wt-suite-lock: ${error.message}\n`)
    return 75
  }
  let lease
  try {
    lease = await acquireSuiteLock({ waitS, staleS, argv: command, onWait: (line) => process.stderr.write(`${line}\n`) })
  } catch (error) {
    if (error?.code === 'WT_SUITE_LOCK_TIMEOUT' || error?.code === 'WT_SUITE_LOCK_UNAVAILABLE') {
      process.stderr.write(`wt-suite-lock: ${error.message}\n`)
      return 75
    }
    throw error
  }
  try {
    return await spawnCommand(command, lease.broker ? lease.lost : null, suiteLeaseMarker(lease))
  } finally {
    releaseSuiteLock(lease)
  }
}

function spawnCommand(command, leaseLost = null, marker = null) {
  return new Promise((resolve, reject) => {
    const refusal = windowsShimArgumentRefusal(command)
    if (refusal) { reject(new Error(refusal)); return }
    const child = spawn(command[0], command.slice(1), {
      stdio: 'inherit',
      ...(marker ? { env: { ...process.env, WT_SUITE_LEASE: marker } } : {}),
      // Per EXECUTABLE, never per platform: a blanket shell on win32 re-parses argv through cmd.exe
      // and mangles quoted arguments (see spawnNeedsShell in lib/suite-lock.mjs).
      shell: spawnNeedsShell(command[0]),
    })
    let forwardedSignal = null
    let lockLost = false
    let cancelForcedStop = null
    const forward = (signal) => {
      forwardedSignal = signal
      if (marker) signalCoveredCommand(child, signal)
      else child.kill(signal)
    }
    const forwardInterrupt = () => forward('SIGINT')
    const forwardTerminate = () => forward('SIGTERM')
    process.once('SIGINT', forwardInterrupt)
    process.once('SIGTERM', forwardTerminate)
    leaseLost?.then(() => {
      lockLost = true
      process.stderr.write('wt-suite-lock: suite lock lost (broker gone); command stopped\n')
      cancelForcedStop = stopChildForLostSuiteLock(child)
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      process.removeListener('SIGINT', forwardInterrupt)
      process.removeListener('SIGTERM', forwardTerminate)
      cancelForcedStop?.()
      if (lockLost) { resolve(75); return }
      if (code !== null) resolve(code)
      else resolve((signal ?? forwardedSignal) === 'SIGINT' ? 130 : 143)
    })
  })
}

async function status(args) {
  const json = args.includes('--json')
  const unknown = args.filter((arg) => arg !== '--json')
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}`)
  const current = process.env.WT_SUITE_LOCK_BROKER
    ? await readBrokerSuiteLock(process.env.WT_SUITE_LOCK_BROKER)
    : readSuiteLock()
  if (json) process.stdout.write(`${JSON.stringify({ held: current.held, holder: current.holder, ...(current.legacyStatus ? { status: current.legacyStatus } : {}) })}\n`)
  else {
    const state = current.legacyStatus ?? (current.held ? `suite lock held: ${formatSuiteLockHolder(current.holder)}` : 'suite lock free')
    process.stdout.write(`${state}\n`)
  }
  return 0
}

function release(args) {
  const force = args.includes('--force')
  const staleS = parseSeconds(args, '--stale-s', DEFAULT_SUITE_LOCK_STALE_S)
  const unknown = args.filter((arg) => arg !== '--force')
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}`)
  const result = operatorReleaseSuiteLock({ force, staleS })
  if (result.reason === 'live') {
    process.stderr.write(`wt-suite-lock: refused to release live ${formatSuiteLockHolder(result.holder)}; pass --force to override\n`)
    return 1
  }
  process.stdout.write(result.released ? `suite lock released (${result.reason})\n` : 'suite lock already free\n')
  return 0
}

export async function runSuiteLockCli(argv = process.argv.slice(2)) {
  const [subcommand, ...args] = argv
  if (subcommand === '--help' || subcommand === '-h') { printHelp(); return 0 }
  if (subcommand === 'run') return run(args)
  if (subcommand === 'status') return status(args)
  if (subcommand === 'release') return release(args)
  throw new Error(subcommand ? `unknown subcommand: ${subcommand}` : 'missing subcommand')
}

export async function runSuiteLockCliEntrypoint(argv = process.argv.slice(2)) {
  try {
    return await runSuiteLockCli(argv)
  } catch (error) {
    process.stderr.write(`wt-suite-lock: ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`)
    return 2
  }
}

if (isInvokedDirectly(import.meta.url)) process.exitCode = await runSuiteLockCliEntrypoint()
