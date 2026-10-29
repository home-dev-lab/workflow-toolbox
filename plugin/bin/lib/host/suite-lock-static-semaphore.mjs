import path from 'node:path'
import { readHolderIn, readQueueSnapshot } from './suite-lock-queue.mjs'
import { displayArgv } from '../suite-lock-display.mjs'

// A separate instance of the proven mkdir/identity/reclaim mutex. All its tickets are P1,
// non-light, so the existing ordered queue reduces to FIFO and concurrency is exactly one.
export const staticSemaphoreRoot = (root) => path.join(root, 'static-lane')

export function staticSemaphoreOptions(root, options) {
  return { ...options, root: staticSemaphoreRoot(root), static: false, light: false, priority: 'P1',
    journalRoot: root, journalKind: 'static', staticDomain: true,
    onWait(line) { options.onWait?.call(this, line.replace('suite lock', 'static lane')) } }
}

export function readStaticSemaphore(root, now, isStale = () => false) {
  const directory = staticSemaphoreRoot(root)
  const holder = readHolderIn(path.join(directory, 'lock.d'))
  const queue = readQueueSnapshot(path.join(directory, 'queue.d'), now)
  const started = typeof holder?.startedAt === 'string' ? Date.parse(holder.startedAt) : NaN
  return { holder: holder ? { pid: Number.isSafeInteger(holder.pid) && holder.pid > 0 ? holder.pid : 'unknown', leaseId: holder.leaseId,
    ageMs: Number.isFinite(started) ? Math.max(0, now - started) : null, argv: displayArgv(holder.argv) } : null,
  waiting: queue.filter((ticket) => !isStale(ticket)).length }
}

// These are the argv actually sent by package-script wrappers, including lane clients.
// Classification is a scheduling hint about client-supplied argv, not authentication.
export function staticWrapperCommand(args) {
  const script = String(args[0] ?? '').replaceAll('\\', '/')
  if (args.length === 1 && /(?:^|\/)scripts\/(?:lint-gate|quality-changed|host-primitive-census)\.mjs$/.test(script)) return true
  if (args.length !== 2) return false
  if (/(?:^|\/)scripts\/quality-root-gate\.mjs$/.test(script)) return args[1] === 'lint' || args[1] === 'dead'
  return /(?:^|\/)scripts\/script-gates\.mjs$/.test(script) && args[1] === 'quality'
}
