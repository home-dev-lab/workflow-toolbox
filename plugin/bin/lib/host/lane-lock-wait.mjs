import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSuiteLock } from '../suite-lock.mjs'
import { readQueueSnapshot } from './suite-lock-queue.mjs'

const LOCK_CLI = fileURLToPath(new URL('../../wt-suite-lock.mjs', import.meta.url))
const unknown = (reason) => ({ state: 'unknown', reason })

// Keep pgrep's status/error contract intact on POSIX; ENOENT on other hosts is a named unknown.
export const pgrepLaneName = (name) => spawnSync('pgrep', ['-x', name], { encoding: 'utf8' })

function hasSocketDescriptors(base) {
  return readdirSync(join(base, 'fd')).some((fd) => readlinkSync(join(base, 'fd', fd)).startsWith('socket:['))
}

function readLaneWaitProcess(pid) {
  const base = `/proc/${pid}`
  const stat = readFileSync(join(base, 'stat'), 'utf8')
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
  const ppid = Number(fields[1])
  const startTime = Number(fields[19])
  if (!stat.startsWith(`${pid} (`) || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(startTime)) throw new Error('malformed process identity')
  const children = readFileSync(join(base, 'task', String(pid), 'children'), 'utf8').trim()
  if (children && !/^\d+(?:\s+\d+)*$/.test(children)) throw new Error('malformed children')
  const threads = readdirSync(join(base, 'task')).length
  return { pid, ppid, startTime, state: fields[0],
    namespace: readlinkSync(join(base, 'ns/pid')),
    threads, hasSockets: threads === 1 ? hasSocketDescriptors(base) : true,
    children: children ? children.split(/\s+/).map(Number) : [],
    wchan: readFileSync(join(base, 'wchan'), 'utf8').trim() }
}

function readLaneWaitLock(pid) {
  const base = `/proc/${pid}`
  const argv = readFileSync(join(base, 'cmdline'), 'utf8').split('\0')
  if (argv[2] !== 'run') return null
  const script = realpathSync(resolve(readlinkSync(join(base, 'cwd')), argv[1]))
  if (script !== realpathSync(LOCK_CLI)) return null
  const env = Object.fromEntries(readFileSync(join(base, 'environ'), 'utf8').split('\0')
    .filter((entry) => entry.includes('=')).map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]))
  // A broker's queue lives in another namespace. Never interpret its local filesystem as the queue.
  if (env.WT_SUITE_LOCK_BROKER) return null
  const lock = readSuiteLock({ env })
  return { ...lock, tickets: readQueueSnapshot(join(lock.root, 'queue.d')) }
}

function sameIdentity(record, row) {
  return record?.pid === row.pid && record.startTime === row.startTime && record.pidNamespace === row.namespace
}

function queuedWaiter(row, lock, readProcess) {
  if (!lock?.held || row.state !== 'S' || row.children.length !== 0) return null
  const holder = lock.holder
  if (!holder || holder.pid === row.pid || !sameIdentity(holder, readProcess(holder.pid))) return null
  const ticket = lock.tickets.find((entry) => entry.ageMs >= 0 && entry.ageMs < 30_000 && sameIdentity(entry.holder, row))
  return ticket ? { pid: row.pid, startTime: row.startTime, number: ticket.number, root: lock.root } : null
}

function isBlockingParent(row) {
  return row.threads === 1 && row.state === 'S' && row.wchan === 'do_wait' && row.children.length === 1 && row.hasSockets === false
}

function blockingChain(pid, readProcess, readLock) {
  const chain = []
  const seen = new Set()
  for (let depth = 0; depth < 32; depth += 1) {
    if (seen.has(pid)) return null
    seen.add(pid)
    const row = readProcess(pid)
    if (chain.length && row.ppid !== chain.at(-1).pid) return null
    // Require a single thread in wait(2), one child and no socket that could carry an in-flight call.
    // epoll/futex/sleep, a queued detached child, and a multi-threaded lane prove nothing.
    if (isBlockingParent(row)) {
      chain.push(row)
      pid = row.children[0]
      continue
    }
    if (!chain.length) return null
    const waiter = queuedWaiter(row, readLock(pid), readProcess)
    return waiter ? { chain, waiter } : null
  }
  return null
}

/** Positive proof only. Re-read the chain and ticket to reject PID reuse, grants and ancestry races.
 * Event-loop-driven lanes and broker-only/foreign namespaces remain counted until a stronger signal exists. */
export function inspectLaneLockWait(pid, {
  platform = process.platform, readProcess = readLaneWaitProcess, readLock = readLaneWaitLock,
} = {}) {
  if (platform !== 'linux') return unknown(`lock-wait evidence unavailable on ${platform}`)
  try {
    const before = blockingChain(pid, readProcess, readLock)
    if (!before) return unknown('no synchronous lock-wait chain proved')
    const after = blockingChain(pid, readProcess, readLock)
    if (JSON.stringify(before) !== JSON.stringify(after)) return unknown('lock-wait evidence changed during inspection')
    return { state: 'waiting', reason: `synchronous child-wait chain to suite-lock pid ${after.waiter.pid}, ticket ${after.waiter.number}`, waiterPid: after.waiter.pid }
  } catch (error) {
    return unknown(`lock-wait evidence unreadable (${error.message})`)
  }
}
