#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { isInvokedDirectly } from './lib/host/entry-guard.mjs'
import { coveredCommandSpawnOptions, signalCoveredCommand, stopCoveredCommandTree } from './lib/host/suite-lock-host.mjs'
import {
  DEFAULT_SUITE_LOCK_STALE_S,
  DEFAULT_SUITE_LOCK_WAIT_S,
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
import { replaceQueuedCommand } from './lib/host/suite-lock-replace.mjs'
import { formatSuiteLockStatus, suiteLockStatusJson } from './lib/suite-lock-status.mjs'
import { suiteLockJournalCli } from './lib/suite-lock-journal.mjs'
import { staticLaneStatusLines } from './lib/suite-lock-static.mjs'
import { acquireCliLease, cliInheritedLease, parseReplaceRun, parseSuiteRunOptions } from './lib/suite-lock-cli-options.mjs'
import { watchLightSuiteLease } from './lib/suite-lock-light-hold.mjs'
import { acquireParkCliLease, clearParkRequest, finishParkRun, parkChildEnvironment, publishParkOutcome, shouldYieldParkLease, spawnParkEnvironment } from './lib/suite-lock-park.mjs'
import { claimParkAttempt, parkSignalExit, watchParkChildSignals } from './lib/host/suite-lock-park-files.mjs'
import { suiteLockPrecedenceCli } from './lib/suite-lock-precedence.mjs'
import { guardLightRun, lightScopeCli } from './lib/suite-lock-light-scope.mjs'
import { lightScopeLog, readLightScopeFirings } from './lib/host/suite-lock-light-scope-log.mjs'
import { directLightRun, runDirectCommand } from './lib/suite-lock-direct-run.mjs'
import { suiteSignalExit, watchSuiteWaitSignals } from './lib/host/suite-lock-signals.mjs'

const USAGE = `Usage:
  node wt-suite-lock.mjs run [--light] [--static] [--priority <release|P0|P1|P2>] [--size S|M|L] [--project NAME] [--wait-s ${DEFAULT_SUITE_LOCK_WAIT_S}] [--stale-s ${DEFAULT_SUITE_LOCK_STALE_S}] -- <command> [args...]
  Park/resume: run --park-dir <dir> --park-s <1..7200> --park-owner-pid <pid> [--yield-to-parked] -- <command> [args...]
  Replace queued command: run --replace <ticket-number> -- <command> [args...]
  Replacement keeps rank and uses the original waiter's cwd, environment, streams and exit recipient; refused once the waiter closes replacement acceptance before starting.
  node wt-suite-lock.mjs journal [--json] [--since <ISO>]
  node wt-suite-lock.mjs light-scope [--json]
  node wt-suite-lock.mjs status [--json] [--resources]
  node wt-suite-lock.mjs release [--force] [--stale-s ${DEFAULT_SUITE_LOCK_STALE_S}]
  node wt-suite-lock.mjs precedence set --project NAME --until ISO --source ID | clear --project NAME | list
  --wait-s / WT_SUITE_LOCK_WAIT_S bounds the wait without non-release queue progress; the head waits up to max(--wait-s, --stale-s).
  WT_SUITE_LOCK_PRIORITY declares P0, P1 (non-lane default), or P2 (routine lane default).
  A lane's host launcher sets its level with wt-lane --lock-priority P0|P1|P2 or WT_SUITE_LOCK_PRIORITY
  in the launcher's environment; a sandboxed lane cannot set its own level or run the release subcommand.
  V3 has no level aging: exclusive size S gains one level unless the project's last S exceeded 10 minutes; M/L gain none (default L).
  WT_SUITE_LOCK_SIZE and WT_SUITE_LOCK_PROJECT supply defaults; explicit options win. Equal ranks alternate projects.
  Release overrides project precedence, which overrides all priorities. The legacy order (with aging) applies while an older client's ticket waits.
  Status flags holders above WT_SUITE_LOCK_LONG_HOLD_S (default 3600); it never pre-empts them.
  Light leases above WT_SUITE_LOCK_LIGHT_HOLD_S (default 600) are flagged in status and once in the run's stderr.
  --light runs a plain, existing one-file Node test directly without a ticket; use run -- to keep it queued (overrun warning after 60 seconds).
  A light run over several test files or a whole suite is warned (WT_SUITE_LOCK_LIGHT_SCOPE=warn, the default) or
  refused (=refuse) with the command to run instead (WT_SUITE_LOCK_HEAVY_JOB names a heavy-job wrapper); light-scope lists firings.
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
  const replacement = parseReplaceRun(args)
  if (replacement) return replaceRun(replacement)
  const { command, staticRun, waitS, staleS, light, priority, park, project, size } = parseSuiteRunOptions(args,
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
    if (project !== undefined) process.env.WT_SUITE_LOCK_PROJECT = project
    // A reader that exits mid-run must not kill the run: the lease outlives its diagnostics.
    process.stderr.on('error', () => { /* a diagnostic failure must leave the covered command running */ })
    if (process.env.WT_SUITE_LOCK === '0') {
      process.stderr.write('wt-suite-lock: bypassed because WT_SUITE_LOCK=0\n')
      return await spawnCommand(command, null, null, parkChildEnvironment(park))
    }

    const inherited = await cliInheritedLease(() => hasSuiteLeaseAsync(process.env, { static: staticRun }))
    if (inherited === 75) return 75
    if (inherited) return await spawnCommand(command, null, null, parkChildEnvironment(park))
    if (directLightRun({ light, staticRun, park, command })) return await runDirectCommand(() => spawnCommand(command, null, null, parkChildEnvironment(park)))
    return await queueAndRun(command, { waitS, staleS, light, staticRun, priority, project, size, park, attempt })
  } finally { try { publishParkOutcome(park, attempt.outcome) } finally { releaseAttempt() } }
}

function replaceRun({ ticket, argv }) {
  const root = suiteLeaseDomain()
  if (root.startsWith('broker:')) throw new Error('--replace is not available inside a lane sandbox; use the host CLI')
  const result = replaceQueuedCommand(root, ticket, argv)
  process.stdout.write(`suite ticket ${result.ticket} replaced (revision ${result.revision}); original waiter retains execution and rank\n`)
  return 0
}

// Queues one ticket and runs the command under it. A light request over several test files is warned, or
// refused before it queues; its hold is recorded once the command ends.
async function queueAndRun(command, options) {
  const { waitS, staleS, light, staticRun, priority, project, size, park, attempt } = options
  const scopeGuard = lightScopeGuard(command, { light, staticRun })
  if (scopeGuard.refused) return 2
  const waiting = watchSuiteWaitSignals()
  try {
    const lease = await acquireCliLease(acquireParkCliLease(acquireSuiteLock, park), { waitS, staleS, argv: command, replaceable: !park && !light && !staticRun, light, static: staticRun, priority, project, size, signal: waiting.signal, offload: true, onOffloadLog: (chunk) => process.stdout.write(chunk), onWait: (line) => process.stderr.write(`${line}\n`) })
    if (typeof lease === 'number') return lease
    if (lease.offloaded) { process.stderr.write(`wt-suite-lock: offloaded; archive ${lease.offloaded.archive}\n`); return lease.offloaded.exit }
    const timing = {}
    try { return await runLeasedCommand(lease.replacementArgv ?? command, lease, { light, staticRun, park, attempt, timing, waiting }) } finally { scopeGuard.end(timing.heldMs) }
  } catch (error) {
    if (suiteSignalExit(waiting.signal.reason)) return suiteSignalExit(waiting.signal.reason)
    throw error
  } finally { waiting.close() }
}

// A light request is checked for its scope before it queues; a nested run under an inherited lease takes no
// ticket and is not checked. Inside a lane the warning prints but the host's record is out of reach.
function lightScopeGuard(command, requested) {
  if (!requested.light || requested.staticRun) return { refused: false, end: () => {} }
  let log = null
  try {
    const root = suiteLeaseDomain()
    if (!root.startsWith('broker:')) log = lightScopeLog(root)
  } catch { /* an unknown lock root only loses the record, never the check */ }
  return guardLightRun({ command, route: 'cli', write: (text) => process.stderr.write(text), log })
}

export async function runLeasedCommand(command, lease, requested) {
  const stopWarning = watchGrantedLease(lease, requested, command)
  let exit = 1
  let yielded = false
  const timing = requested.timing ?? {}
  try {
    const interrupted = recordedWaitSignal(requested, timing)
    if (interrupted) { exit = interrupted; return exit }
    yielded = shouldYieldParkLease(lease, requested.park, readSuiteLockParked)
    if (yielded) { exit = 75; return exit }
    exit = await spawnLeasedCommand(command, lease, requested, timing)
    return exit
  } finally {
    stopWarning()
    let completed = false
    try {
      requested.attempt.outcome = finishParkRun(lease, requested.park, yielded)
      completed = requested.attempt.outcome === 'not-parked\n' && !yielded && timing.started === true && !timing.lost
    } finally { releaseSuiteLock(lease, { exit, served: completed, heldMs: timing.heldMs, ...timing.signalOutcome }) }
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

function recordedWaitSignal(requested, timing) {
  const reason = requested.waiting?.signal.reason
  const exit = suiteSignalExit(reason)
  if (exit) timing.signalOutcome = { cause: 'signal', signal: reason.signal }
  return exit
}

function spawnLeasedCommand(command, lease, requested, timing) {
  const exit = recordedWaitSignal(requested, timing)
  if (exit) return exit
  timing.waiting = requested.waiting
  return spawnCommand(command, lease.broker ? lease.lost : null, suiteLeaseMarker(lease), parkChildEnvironment(requested.park), timing)
}

function installCommandForwarding(forward, timing) {
  const stopSignals = watchParkChildSignals(forward)
  timing.waiting?.close()
  return stopSignals
}

function spawnCommand(command, leaseLost = null, marker = null, envOverrides, timing = {}) {
  return new Promise((resolve, reject) => {
    const refusal = windowsShimArgumentRefusal(command)
    if (refusal) { reject(new Error(refusal)); return }
    // A broker lease's command gets its own process group (POSIX), so losing the lease stops its whole tree.
    const group = Boolean(leaseLost)
    const started = performance.now()
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
    child.once('spawn', () => { timing.started = true })
    const forward = (signal) => {
      forwardedSignal = signal
      if (marker) signalCoveredCommand(child, signal, { group })
      else child.kill(signal)
    }
    const stopSignals = installCommandForwarding(forward, timing)
    leaseLost?.then((reason) => {
      lockLost = true
      timing.lost = true
      process.stderr.write(`wt-suite-lock: suite lock lost (${reason || 'broker gone'}); command stopped\n`)
      // The lease is released (the broker socket closed, by the caller's finally) only once this resolves.
      treeStopped = stopCoveredCommandTree(child, { group })
    })
    child.once('error', (error) => { stopSignals(); reject(error) })
    child.once('exit', (code, signal) => {
      timing.heldMs = performance.now() - started
      stopSignals()
      if (lockLost) { treeStopped.then(() => resolve(75)); return }
      if (code !== null) resolve(code)
      else resolve(parkSignalExit(signal ?? forwardedSignal))
    })
  })
}

async function status(args) {
  const json = args.includes('--json')
  const unknown = args.filter((arg) => arg !== '--json' && arg !== '--resources')
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}`)
  const viaBroker = Boolean(process.env.WT_SUITE_LOCK_BROKER)
  const current = viaBroker ? await readBrokerSuiteLock(process.env.WT_SUITE_LOCK_BROKER) : readSuiteLockStatus()
  if (json) process.stdout.write(`${JSON.stringify({ ...suiteLockStatusJson(current), ...(current.staticLane ? { staticLane: current.staticLane } : {}) })}\n`)
  else process.stdout.write(formatSuiteLockStatus(current, formatSuiteLockHolder(current.holder), { resources: args.includes('--resources') }))
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

const SUBCOMMANDS = {
  run,
  status,
  release,
  journal: (args) => suiteLockJournalCli(args, suiteLeaseDomain()),
  'light-scope': (args) => lightScopeCli(args, suiteLeaseDomain(), readLightScopeFirings),
  precedence: (args) => suiteLockPrecedenceCli(args, suiteLeaseDomain()),
}

export async function runSuiteLockCli(argv = process.argv.slice(2)) {
  const [subcommand, ...args] = argv
  if (subcommand === '--help' || subcommand === '-h') { printHelp(); return 0 }
  if (Object.hasOwn(SUBCOMMANDS, subcommand)) return SUBCOMMANDS[subcommand](args)
  throw new Error(subcommand ? `unknown subcommand: ${subcommand}` : 'missing subcommand')
}

export async function runSuiteLockCliEntrypoint(argv = process.argv.slice(2)) {
  try {
    return await runSuiteLockCli(argv)
  } catch (error) {
    if (error?.code === 'WT_SUITE_LOCK_STALE_CLIENT') {
      process.stderr.write(`wt-suite-lock: ${error.message}\n`)
      return 78
    }
    process.stderr.write(`wt-suite-lock: ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`)
    return error.exitCode === 64 ? 64 : 2
  }
}

if (isInvokedDirectly(import.meta.url)) process.exitCode = await runSuiteLockCliEntrypoint()
