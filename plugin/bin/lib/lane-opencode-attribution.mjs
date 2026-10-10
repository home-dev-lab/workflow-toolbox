// Ownership of opencode processes that carry no lane supervision record, read from the live process table
// alone (rows { pid, ppid, command, startTime?, startIdentity? } as every host adapter returns them).
//
// Two owners are recognised, both checked against the CURRENT table, so an owner that has exited owns
// nothing:
// - a batch launcher: a `node` process running one of BATCH_LAUNCHER_SCRIPTS. It fans opencode calls out
//   itself and writes no record, so every process below it belongs to its run.
// - a lane-sandbox creator: the lane sandbox names its runtime directory `wt-lane-sandbox-<creator pid>-<id>`
//   and passes it in the outer bwrap's arguments. An outer bwrap whose live parent IS that pid belongs to
//   the parent's run, with everything below it (inner bwrap, bootstrap shell, opencode).
//
// Parent links are trusted only through isTrueParent (lane-live-scan.mjs): a parent younger than its child
// is a reused id, not the parent.
//
// Everything else stays unattributed. Notices for it are keyed per TREE: the nearest ancestor that is not
// sandbox plumbing (bwrap, or the bootstrap shell carrying `wt-lane-net`). A reaper is never a tree root:
// pid 1, an init/systemd/launchd process, or an ancestor of the watcher itself (a session that adopts orphans).
// An orphan reparented to one keeps a key of its own, so one hung orphan cannot hide the next.
// Without a launcher the key is the chain's top process WITH its start identity: a reused wrapper pid starts
// a new key. A subreaper not named above (tini, a container entrypoint) still roots one shared tree.
import { isTrueParent, laneDescendantPids, posixCommandArgs } from './lane-live-scan.mjs'

const BATCH_LAUNCHER_SCRIPTS = new Set(['wt-opencode-envelope.mjs'])
const MAX_ANCESTRY = 64

const baseName = (value) => String(value ?? '').split(/[\\/]/).at(-1)
const validPid = (pid) => Number.isSafeInteger(pid) && pid > 1
const executable = (row) => baseName(posixCommandArgs(row?.command ?? '')[0])

export const isOpencodeCommand = (command) => /(?:^|[\\/\s])opencode(?:\.exe|\.cmd)?(?:\s|$)/i.test(String(command ?? ''))

export function isBatchLauncherRow(row) {
  const args = posixCommandArgs(row?.command ?? '')
  if (!/^node(?:\.exe)?$/i.test(baseName(args[0]))) return false
  const script = args.slice(1).find((arg) => !arg.startsWith('-'))
  return BATCH_LAUNCHER_SCRIPTS.has(baseName(script))
}

export function isOwnedSandboxRoot(row, byPid) {
  if (!/^bwrap$/i.test(executable(row)) || !isTrueParent(byPid.get(row.ppid), row)) return false
  return String(row.command).includes(`wt-lane-sandbox-${row.ppid}-`)
}

const REAPER_EXECUTABLES = /^(?:init|systemd|launchd)$/i
const isReaper = (row, reapers) => !validPid(row.pid) || reapers.has(row.pid) || REAPER_EXECUTABLES.test(executable(row))

const isSandboxPlumbing = (row) => /^bwrap$/i.test(executable(row)) || (/^sh$/.test(executable(row)) && /\swt-lane-net\s/.test(String(row.command)))

const indexByPid = (processes) => new Map(processes.filter((row) => validPid(row?.pid)).map((row) => [row.pid, row]))

/** Pids of `pid` and its ancestors in the table: processes that must never be read as a launcher tree. */
export function ancestorPids(pid, processes) {
  const byPid = indexByPid(processes)
  const out = new Set()
  for (let row = byPid.get(pid); row && !out.has(row.pid) && out.size < MAX_ANCESTRY; row = byPid.get(row.ppid)) out.add(row.pid)
  return out
}

/** Pids owned by a live batch launcher or a live lane-sandbox creator, roots included. */
export function ownedOpencodePids(processes) {
  const byPid = indexByPid(processes)
  const roots = processes.filter((row) => validPid(row?.pid) && (isBatchLauncherRow(row) || isOwnedSandboxRoot(row, byPid))).map((row) => row.pid)
  return laneDescendantPids(roots, processes)
}

const startIdentity = (row) => row.startIdentity ?? row.startTime ?? 'unknown'

// The next ancestor in an opencode invocation chain, or null when the walk must stop at `row`.
function chainParent(row, byPid, seen, reapers) {
  const parent = byPid.get(row.ppid)
  if (!isTrueParent(parent, row) || seen.has(parent.pid) || isReaper(parent, reapers)) return null
  return parent
}

/** Notice key shared by every process of one launcher tree; per invocation chain when the launcher is gone. */
export function unattributedTreeKey(pid, processes, { reapers = new Set() } = {}) {
  const byPid = indexByPid(processes)
  let top = byPid.get(pid)
  if (!top) return `pid:${pid}`
  const seen = new Set([top.pid])
  for (let parent = chainParent(top, byPid, seen, reapers); parent && seen.size < MAX_ANCESTRY; parent = chainParent(top, byPid, seen, reapers)) {
    if (!isSandboxPlumbing(parent)) return `tree:${parent.pid}:${startIdentity(parent)}`
    seen.add(parent.pid)
    top = parent
  }
  return `pid:${top.pid}:${startIdentity(top)}`
}

// A pid number is reused: the key carries the start identity so a new process never inherits a notice.
const unattributedPidKey = (row) => `unknown:${row.pid}:${startIdentity(row)}`

/**
 * Journals every unattributed opencode pid once; notifies once per launcher TREE while that tree keeps an
 * unattributed process, so one unknown run of many calls (or one call seen through its wrappers) is a single
 * wake. Attribution is re-read every sweep, a warned pid included: a key whose tree has no unattributed process
 * left this sweep is dropped, so a later unattributed process there is a new episode.
 * `candidateOf(row)` returns the inspected process when the row is an unowned opencode call to report, else null.
 */
export function reportUnattributed({ processes, reapers, isAttributed, candidateOf, notified, notice, journal }) {
  const live = new Set()
  for (const row of processes) {
    if (isAttributed(row.pid)) continue
    const pidKey = unattributedPidKey(row)
    const seen = notified.has(pidKey)
    const unknown = seen ? null : candidateOf(row)
    if (!seen && !unknown) continue
    const treeKey = `unknown-tree:${unattributedTreeKey(row.pid, processes, { reapers })}`
    live.add(pidKey).add(treeKey)
    if (!seen) reportOne({ row, unknown, pidKey, treeKey, notified, notice, journal })
  }
  for (const key of notified) if (/^unknown(?:-tree)?:/.test(key) && !live.has(key)) notified.delete(key)
}

function reportOne({ row, unknown, pidKey, treeKey, notified, notice, journal }) {
  journal({ event: 'unattributed', pid: row.pid, argv: row.command.slice(0, 300), worktree: unknown.cwd, owner: null, reason: 'unknown-owner', tree: treeKey.slice('unknown-tree:'.length) })
  notified.add(pidKey)
  if (!notified.has(treeKey)) notice(treeKey, `WARNING: unattributed opencode pid=${row.pid} argv=${JSON.stringify(row.command.slice(0, 300))}; it was not killed`)
}
