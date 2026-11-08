#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { isInvokedDirectly } from './lib/host/entry-guard.mjs'
import { coveredCommandSpawnOptions, signalCoveredCommand, stopCoveredCommandTree } from './lib/host/suite-lock-host.mjs'
import {
  DEFAULT_SUITE_LOCK_STALE_S,
  DEFAULT_SUITE_LOCK_WAIT_S,
  P0_BYPASS_MAX_GRANTS,
  acquireSuiteLock,
  hasSuiteLeaseAsync,
  formatSuiteLockHolder,
  operatorReleaseSuiteLock,
  readBrokerSuiteLock,
  readSuiteLockStatus,
  readSuiteLockParked,
  parkAttemptIsGone,
  releaseSuiteLock,
  suiteLeaseMarker,
  suiteLeaseDomain,
  suiteLockWaitSeconds,
  spawnNeedsShell,
  windowsShimArgumentRefusal,
} from './lib/suite-lock.mjs'
import { parseSuiteLockPriority } from './lib/suite-lock-priority.mjs'
import { formatSuiteLockStatus, suiteLockStatusJson } from './lib/suite-lock-status.mjs'
import { suiteLockJournalCli } from './lib/suite-lock-journal.mjs'
import { staticLaneStatusLines } from './lib/suite-lock-static.mjs'
import { acquireCliLease, cliInheritedLease, parseSuiteRunOptions } from './lib/suite-lock-cli-options.mjs'
import { watchLightSuiteLease } from './lib/suite-lock-light-hold.mjs'
import { acquireParkCliLease, clearParkRequest, finishParkRun, parkChildEnvironment, publishParkOutcome, shouldYieldParkLease, spawnParkEnvironment } from './lib/suite-lock-park.mjs'
import { claimParkAttempt, parkSignalExit, watchParkChildSignals } from './lib/host/suite-lock-park-files.mjs'

const USAGE = `Usage:
  node wt-suite-lock.mjs run [--light] [--static] [--priority <release|P0|P1|P2>] [--wait-s ${DEFAULT_SUITE_LOCK_WAIT_S}] [--stale-s ${DEFAULT_SUITE_LOCK_STALE_S}] -- <command> [args...]
  Park/resume: run --park-dir <dir> --park-s <1..7200> --park-owner-pid <pid> [--yield-to-parked] -- <command> [args...]
  node wt-suite-lock.mjs journal [--json] [--since <ISO>]
  node wt-suite-lock.mjs status [--json]
  node wt-suite-lock.mjs release [--force] [--stale-s ${DEFAULT_SUITE_LOCK_STALE_S}]
  --wait-s / WT_SUITE_LOCK_WAIT_S bounds the wait without non-release queue progress; the head waits up to max(--wait-s, --stale-s).
  WT_SUITE_LOCK_PRIORITY declares P0, P1 (non-lane default), or P2 (routine lane default); levels age one step per 30 minutes.
  A lane's host launcher sets its level with wt-lane --lock-priority P0|P1|P2 or WT_SUITE_LOCK_PRIORITY
  in the launcher's environment; a sandboxed lane cannot set its own level or run the release subcommand.
  A P1/P2 ticket ages no higher than P1 until ${P0_BYPASS_MAX_GRANTS} declared-P0 admissions have passed it, so a declared P0
  goes before aged tickets; this applies once every queued client runs this version (status names the legacy order otherwise).
  Status flags holders above WT_SUITE_LOCK_LONG_HOLD_S (default 3600); it never pre-empts them.
  Light leases above WT_SUITE_LOCK_LIGHT_HOLD_S (default 600) are flagged in status and once in the run's stderr.
  Release priority is reserved for the main session's release and merge-train gates.`

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

function parseRunPriority(flags) {
  const index = flags.indexOf('--priority')
  if (index < 0) return undefined
  const priority = parseSuiteLockPriority(flags[index + 1])
  flags.splice(index, 2)
  return priority
}

function applyRunPriority(priority) {
  if (priority === undefined || priority === 'release') return
  if (process.env.WT_SUITE_LOCK_BROKER?.trim()) {
    process.stderr.write(`wt-suite-lock: the host sets a lane's priority; --priority ${priority} is ignored\n`)
    return
  }
  process.env.WT_SUITE_LOCK_PRIORITY = priority
}

async function run(args) {
  const { command, staticRun, waitS, staleS, light, priority, park } = parseSuiteRunOptions(args,
    { parseSeconds, parsePriority: parseRunPriority, waitSeconds: suiteLockWaitSeconds, defaultStaleS: DEFAULT_SUITE_LOCK_STALE_S })
  const attempt = { outcome: 'not-parked\n' }
  const releaseAttempt = claimParkAttempt(park, parkAttemptIsGone)
  try {
    clearParkRequest(park)
    if (priority === 'release' && process.env.WT_SUITE_LOCK_BROKER?.trim()) {
      process.stderr.write('wt-suite-lock: release priority is not available inside a lane sandbox\n')
      return 2
    }
    applyRunPriority(priority)
    // A reader that exits mid-run must not kill the run: the lease outlives its diagnostics.
    process.stderr.on('error', () => { /* a diagnostic failure must leave the covered command running */ })
    if (process.env.WT_SUITE_LOCK === '0') {
      process.stderr.write('wt-suite-lock: bypassed because WT_SUITE_LOCK=0\n')
      return await spawnCommand(command, null, null, parkChildEnvironment(park))
    }

    const inherited = await cliInheritedLease(() => hasSuiteLeaseAsync(process.env, { static: staticRun }))
    if (inherited === 75) return 75
    if (inherited) return await spawnCommand(command, null, null, parkChildEnvironment(park))
    const lease = await acquireCliLease(acquireParkCliLease(acquireSuiteLock, park), { waitS, staleS, argv: command, light, static: staticRun, priority, offload: true, onOffloadLog: (chunk) => process.stdout.write(chunk), onWait: (line) => process.stderr.write(`${line}\n`) })
    if (typeof lease === 'number') return lease
    if (lease.offloaded) { process.stderr.write(`wt-suite-lock: offloaded; archive ${lease.offloaded.archive}\n`); return lease.offloaded.exit }
    return await runLeasedCommand(command, lease, { light, staticRun, park, attempt })
  } finally { try { publishParkOutcome(park, attempt.outcome) } finally { releaseAttempt() } }
}

async function runLeasedCommand(command, lease, requested) {
  const stopWarning = watchGrantedLease(lease, requested, command)
  let exit = 1
  let yielded = false
  try {
    yielded = shouldYieldParkLease(lease, requested.park, readSuiteLockParked)
    if (yielded) { exit = 75; return exit }
    exit = await spawnCommand(command, lease.broker ? lease.lost : null, suiteLeaseMarker(lease), parkChildEnvironment(requested.park))
    return exit
  } finally {
    stopWarning()
    try { requested.attempt.outcome = finishParkRun(lease, requested.park, yielded) } finally { releaseSuiteLock(lease, { exit }) }
  }
}

// The granted lease, not the request, decides. A static-lane grant never holds the exclusive mutex, so it
// is never a light lease past its class. A fallback behind an older broker is exclusive (holder.light false).
// A static request the main queue took instead (static lane off, or a broker host that did not classify the
// command as static) was asked for as light (acquireJournalLease), so it is watched as light.
// A park lease carries its saved queue record; its class wins over the new invocation's flags.
function watchGrantedLease(lease, requested, command) {
  if (grantedStaticLane(lease)) return () => {}
  return watchLightSuiteLease({ ...lease.holder, light: lease.record ? lease.record.light === true : lease.holder.light ?? (requested.light || requested.staticRun), argv: command })
}

// Direct static grants carry staticDomain; a broker's static grant arrives as `granted static:<id>`.
function grantedStaticLane(lease) {
  return lease.staticDomain === true || String(lease.holder?.leaseId ?? '').startsWith('static:')
}

function spawnCommand(command, leaseLost = null, marker = null, envOverrides) {
  return new Promise((resolve, reject) => {
    const refusal = windowsShimArgumentRefusal(command)
    if (refusal) { reject(new Error(refusal)); return }
    // A broker lease's command gets its own process group (POSIX), so losing the lease stops its whole tree.
    const group = Boolean(leaseLost)
    const child = spawn(command[0], command.slice(1), {
      stdio: 'inherit',
      ...spawnParkEnvironment(marker, envOverrides, process.env),
      // Per EXECUTABLE, never per platform: a blanket shell on win32 re-parses argv through cmd.exe
      // and mangles quoted arguments (see spawnNeedsShell in lib/suite-lock.mjs).
      shell: spawnNeedsShell(command[0]),
      ...coveredCommandSpawnOptions({ broker: group }),
    })
    let forwardedSignal = null
    let lockLost = false
    let treeStopped = null
    const forward = (signal) => {
      forwardedSignal = signal
      if (marker) signalCoveredCommand(child, signal, { group })
      else child.kill(signal)
    }
    const stopSignals = watchParkChildSignals(forward)
    leaseLost?.then((reason) => {
      lockLost = true
      process.stderr.write(`wt-suite-lock: suite lock lost (${reason || 'broker gone'}); command stopped\n`)
      // The lease is released (the broker socket closed, by the caller's finally) only once this resolves.
      treeStopped = stopCoveredCommandTree(child, { group })
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      stopSignals()
      if (lockLost) { treeStopped.then(() => resolve(75)); return }
      if (code !== null) resolve(code)
      else resolve(parkSignalExit(signal ?? forwardedSignal))
    })
  })
}

async function status(args) {
  const json = args.includes('--json')
  const unknown = args.filter((arg) => arg !== '--json')
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}`)
  const viaBroker = Boolean(process.env.WT_SUITE_LOCK_BROKER)
  const current = viaBroker ? await readBrokerSuiteLock(process.env.WT_SUITE_LOCK_BROKER) : readSuiteLockStatus()
  if (json) process.stdout.write(`${JSON.stringify({ ...suiteLockStatusJson(current), ...(current.staticLane ? { staticLane: current.staticLane } : {}) })}\n`)
  else process.stdout.write(formatSuiteLockStatus(current, formatSuiteLockHolder(current.holder)))
  if (!json) process.stdout.write(staticLaneStatusLines(current))
  return 0
}

function release(args) {
  if (process.env.WT_SUITE_LOCK_BROKER?.trim()) {
    process.stderr.write('wt-suite-lock: release is not available inside a lane sandbox; the host operator releases the lock\n')
    return 2
  }
  const force = args.includes('--force')
  const staleS = parseSeconds(args, '--stale-s', DEFAULT_SUITE_LOCK_STALE_S)
  const unknown = args.filter((arg) => arg !== '--force')
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}`)
  const result = operatorReleaseSuiteLock({ force, staleS })
  if (result.reason === 'live') {
    process.stderr.write(`wt-suite-lock: refused to release live ${formatSuiteLockHolder(result.holder)}; pass --force to override\n`)
    return 1
  }
  if (result.reason === 'busy') {
    process.stderr.write(`wt-suite-lock: a reclaim is in progress (reclaim.d held); ${formatSuiteLockHolder(result.holder)} left in place, retry in a moment\n`)
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
  if (subcommand === 'journal') return suiteLockJournalCli(args, suiteLeaseDomain())
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
