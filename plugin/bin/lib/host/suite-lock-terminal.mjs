import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { currentPidNamespace, processStartTime } from './pid-namespace.mjs'
import { foreignNamespaceStale, pidProvesGone } from './suite-lock-liveness.mjs'

export const TERMINAL_LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TERMINAL_EVENTS = new Set(['release', 'timeout', 'abort'])

export const terminalCreator = () => ({ pid: process.pid, platform: process.platform,
  startTime: processStartTime(process.pid), pidNamespace: currentPidNamespace() })

export function terminalOwnerGone(owner, options) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return false
  return foreignNamespaceStale({ holder: owner }, options) === null && pidProvesGone(owner, options)
}

export function claimTerminal(root, event, line, warn) {
  if (!TERMINAL_EVENTS.has(event.event) || typeof event.leaseId !== 'string' || !TERMINAL_LEASE_ID.test(event.leaseId)) return { append: true }
  const directory = path.join(root, 'terminal.d')
  const file = path.join(directory, event.leaseId)
  try { mkdirSync(directory, { recursive: true }) } catch (error) { warn(error); return { append: true } }
  try {
    // The immutable claim remains occupied until completion-based retention expires.
    writeFileSync(file, JSON.stringify({ creator: terminalCreator(), line: line.toString() }), { flag: 'wx', mode: 0o600 })
    return { append: true, file }
  } catch (error) {
    if (error?.code === 'EEXIST') return { append: false }
    warn(error)
    return { append: true }
  }
}

export function completeTerminal(file) {
  if (!file) return
  try { writeFileSync(`${file}.written`, '', { flag: 'wx', mode: 0o600 }) } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
}
