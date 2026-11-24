import { appendLauncherEvent, launcherId, launcherRecoveryReason, takeLauncherEvent } from './host/launcher-events.mjs'
import { completeLauncherWrite } from './host/launcher-event-io.mjs'
import { eventReason } from './host/launcher-maildir.mjs'
export { launcherId } from './host/launcher-events.mjs'

export const LAUNCHER_MISSING_GRACE_MS = 120_000
export const LAUNCHER_UNCONSUMED_GRACE_MS = 3_420_000
const singleLine = (value) => String(value).replace(/[\r\n\u2028\u2029]/g, ' ')
export const launcherEnvIdentity = (env = process.env) => env.WT_LAUNCHER_AGENT ?? null
export const launcherRestartFlag = (record, quote) => record.launcherAgentId ? ` --launcher-agent ${quote(record.launcherAgentId)}` : ''

// Supervision remains on main's notice channel; only lane completions are routed.
export function sessionLauncherNotice(record, readSessionId, notice) {
  return record.owner === 'session' && Boolean(record.ownerSessionId) && record.ownerSessionId === readSessionId() ? notice : null
}

export function routeLauncherEvent(record, event, options = {}) {
  const id = record.launcherAgentId
  if (id === null || id === undefined) return { main: true, line: event.line }
  try {
    launcherId(id)
    const stored = appendLauncherEvent(id, { ...event, line: `${singleLine(event.line)} launcher-agent=${id}`, ownerSessionId: record.ownerSessionId }, options)
    if (stored.ok === false) return { main: false, reason: stored.reason }
    return storedLauncherRoute(stored, options)
  } catch (error) {
    const failure = eventReason(options, 'launcher-routing-failed', error)
    return { main: false, reason: failure.reason }
  }
}

export function storedLauncherRoute(event, options = {}) {
  const id = event.launcherAgentId
  let reason
  try { reason = launcherRecoveryReason(id, event, options, LAUNCHER_MISSING_GRACE_MS, LAUNCHER_UNCONSUMED_GRACE_MS) }
  catch (error) { reason = 'liveness-unknown'; eventReason(options, 'launcher-routing-failed', error) }
  const line = reason ? `${event.line} orphaned-launcher=${id}` : event.line
  return { main: Boolean(reason), line, deliver: (write) => {
    const delivered = takeLauncherEvent(id, { ...options, name: event.name, deliver: () => completeLauncherWrite(write, line) })
    return Boolean(delivered)
  } }
}

export function deliverLauncherRoute(routed, write) {
  if (!routed.main) return false
  if (routed.deliver) return routed.deliver(write)
  completeLauncherWrite(write, routed.line)
  return true
}
