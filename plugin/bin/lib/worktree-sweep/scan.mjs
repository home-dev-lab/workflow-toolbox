// REPORT ONLY: no store, quarantine, deletion, context-mode purge or project-local state.
import { existsSync, lstatSync, readdirSync, readFileSync, sweepPlatform } from '../host/worktree-sweep-io.mjs'
import path from 'node:path'
import { createProcfs } from '../host/procfs.mjs'
import { scanIdleWorktree } from '../host/lane-worktree-scan.mjs'
import { pathContains } from '../host/sweep-evidence.mjs'
import { hostNamespaceEvidence, recordedProcessPresence, scanSweepProcesses } from '../host/sweep-processes.mjs'
import { archiveLimit, baseProven, gitIndexLock, gitVerdict, reachableObjects } from './git.mjs'
import { entryBoundary, inventoryTree, isIndexLock, outsideSweep, sourceBoundary } from './paths.mjs'

const UNKNOWN_PROCESS = 'unknown-process'
const ENTRY_INVENTORY_BUDGET_MS = 120_000
const SCAN_BUDGET_MS = 30 * 60_000

function recordedLane(file, options) {
  const record = path.join(file, '.lane', 'pid')
  if (!existsSync(record)) return null
  try {
    const pid = readFileSync(record, 'utf8').trim()
    if (!/^\d+$/.test(pid) || Number(pid) < 1) return UNKNOWN_PROCESS
    const presence = recordedProcessPresence(pid, options)
    if (presence === 'absent') return null
    return presence === 'present' ? 'live' : UNKNOWN_PROCESS
  } catch (error) { return ['ENOENT', 'ESRCH'].includes(error.code) ? null : UNKNOWN_PROCESS }
}

function quietReason(file, inventory, options) {
  // Reuse the complete, bigint idle scan as a second bounded filesystem observation.
  // Supplement mtime with ctime, except for regular files shared through hard links.
  let latestNs = inventory.latestNs
  const readStat = (name, args) => {
    const stat = lstatSync(name, args)
    if (stat.mtimeNs > latestNs) latestNs = stat.mtimeNs
    if (stat.ctimeNs > latestNs && !(stat.isFile() && stat.nlink > 1n)) latestNs = stat.ctimeNs
    return stat
  }
  const idle = scanIdleWorktree(file, { maxEntries: 200000, readStat, readTargetStat: readStat,
    readDirectory: (dir, args) => readdirSync(dir, args).filter(entry => !isIndexLock(path.join(dir, entry.name), entry, options.indexLock)) })
  if (idle.status !== 'known' || inventory.reason) return UNKNOWN_PROCESS
  if (BigInt(options.now) * 1_000_000n - latestNs < 72n * 3600_000_000_000n) return 'recent'
  return null
}

function liveness(file, inventory, options) {
  const quiet = quietReason(file, inventory, options)
  if (quiet) return quiet
  const lane = recordedLane(file, options)
  if (lane) return lane
  if (options.platform === 'win32') return 'holders unknown on Windows'
  if (options.namespace.status !== 'known') return 'liveness unknown: not in the host PID namespace'
  if (options.holders.status !== 'known') return options.holders.reason ?? UNKNOWN_PROCESS
  if (options.holders.references.some(reference => pathContains(file, reference, options.platform))) return 'live'
  return null
}

function candidate(file, inventory, options) {
  const git = existsSync(path.join(file, '.git'))
  if (!git && !file.endsWith('.base')) return { reason: 'no-git' }
  if (!git && !baseProven(file, inventory, options.objects, options)) return { reason: 'base-unproven' }
  const status = git ? gitVerdict(file, options) : {}
  if (status.reason) return status
  if (options.registryUnknown) return { ...status, reason: 'worktree-registry-unavailable' }
  if (inventory.reason || archiveLimit(file, inventory, options)) return { ...status, reason: 'cannot-archive' }
  return { ...status, reason: liveness(file, inventory, options) }
}

function entryMeasurements(inventory, options) {
  return { bytes: inventory.reason ? null : inventory.bytes,
    ageHours: inventory.reason ? null : Math.max(0, Number(BigInt(options.now) * 1_000_000n - inventory.latestNs) / 3600_000_000_000) }
}

function registrationAbsence(file, registration) {
  if (!registration) return null
  if (!existsSync(file)) return registration.prunable ? 'registered-prunable' : 'registered-missing'
  return registration.prunable ? 'registered-prunable' : null
}

function scanEntry(name, boundary, options) {
  const file = path.join(boundary.source, name)
  const entry = { name, path: file, verdict: 'KEEP', bytes: null, ageHours: null }
  const registration = boundary.registry.records.get(name)
  if (options.scanExpired) return { ...entry, ...(registration ? { registration } : {}), reason: 'scan-deadline' }
  const absence = registrationAbsence(file, registration)
  if (absence) return { ...entry, registration, reason: absence }
  if (!entryBoundary(file, boundary).allowed) return { ...entry, reason: 'not-an-entry' }
  const context = { ...options, indexLock: gitIndexLock(file, options), registryUnknown: boundary.registry.unknown }
  const inventory = inventoryTree(file, { ...boundary, indexLock: context.indexLock, deadline: options.deadline, clock: options.clock })
  const verdict = registration?.locked ? { reason: 'locked' } : candidate(file, inventory, context)
  return { ...entry, ...entryMeasurements(inventory, options), ...(registration ? { registration } : {}),
    ...verdict, verdict: verdict.reason ? 'KEEP' : 'ELIGIBLE (report only)', reason: verdict.reason ?? 'eligible' }
}

function scanOptions(options, boundary) {
  const procfs = options.procfs
  const namespace = options.hostNamespace ?? hostNamespaceEvidence({ procfs })
  const holders = scanSweepProcesses({ ...options, procfs, sourceDevice: boundary.device })
  const repositories = boundary.names.map(name => path.join(boundary.source, name))
    .filter(file => entryBoundary(file, boundary).allowed && existsSync(path.join(file, '.git')))
  const objects = boundary.names.some(name => name.endsWith('.base')) ? reachableObjects(repositories, options) : new Set()
  return { ...options, procfs, namespace, holders, objects, budget: { bytes: 0 } }
}

function scanEntries(boundary, options) {
  let scanExpired = false
  return boundary.names.map(name => {
    const started = options.clock()
    // Latch the global stop: even a wall-clock rollback cannot resume the sweep.
    scanExpired ||= started > options.scanDeadline
    return scanEntry(name, boundary, { ...options, scanExpired, deadline: started + options.entryBudgetMs })
  })
}

export function scanProject(options) {
  const clock = options.clock ?? Date.now
  // The same injected view must be used for mount boundaries and holder reads.
  // Changing that view never supplies a positive host attestation.
  const config = { platform: sweepPlatform(), now: clock(), entryBudgetMs: ENTRY_INVENTORY_BUDGET_MS,
    scanBudgetMs: SCAN_BUDGET_MS, ...options, clock,
    procfs: options.procfs ?? createProcfs({ root: options.env?.WT_SWEEP_PROC_ROOT }) }
  config.scanDeadline = clock() + config.scanBudgetMs
  if (!Number.isSafeInteger(config.now)) throw new Error('worktree sweep: invalid observation clock')
  const project = path.resolve(options.project)
  const boundary = sourceBoundary(project, config)
  const report = { schemaVersion: 1, mode: 'report', project, source: boundary.source, entries: [], reason: boundary.reason ?? null,
    outsideSweep: outsideSweep(project, boundary.source, { ...config, registry: boundary.registry }) }
  if (boundary.reason) return report
  const context = scanOptions(config, boundary)
  const entries = scanEntries(boundary, context)
  const counts = Object.fromEntries([...new Set(entries.map(entry => entry.reason))].map(reason => [reason, entries.filter(entry => entry.reason === reason).length]))
  return { ...report, entries, summary: { entries: entries.length, counts, moved: 0, purged: 0,
    nonDumpable: context.holders.nonDumpable, foreignUnreadable: context.holders.foreignUnreadable,
    mismatchExcluded: context.holders.mismatchExcluded, namespace: context.namespace, hashedBytes: context.budget.bytes } }
}
