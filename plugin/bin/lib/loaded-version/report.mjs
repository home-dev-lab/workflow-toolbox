// Text and JSON renderings of a loaded-version result. Neither carries a command line; text fields
// have control characters replaced so one value cannot forge another line.
const printable = value => [...String(value)].map(char => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? '?' : char)).join('')
const STATUSES = ['current', 'stale', 'absent', 'unknown']

export function summaryLine(result) {
  const statuses = result.expect === null ? ['loaded', ...STATUSES.slice(2)] : STATUSES
  const counts = statuses.map(status => `${status}=${result.sessions.filter(session => session.status === status).length}`)
  const head = `loaded-version: plugin=${result.plugin} expect=${result.expect ?? 'none'} sessions=${result.sessions.length}`
  const tail = result.reason ? ` reason=${result.reason}` : ''
  return printable(`${head} ${counts.join(' ')} EXIT=${result.exitCode}${tail}`)
}

export function sessionLine(session) {
  const version = session.versions.length ? session.versions.join(',') : 'none'
  const fields = [
    session.status, `session=${session.sessionId ?? 'unknown'}`, `profile=${session.profile ?? 'unknown'}`,
    `pid=${session.pid}`, `version=${version}`,
  ]
  if (session.reason) fields.push(`reason=${session.reason}`)
  return printable(fields.join(' '))
}

// A profile with no session gets its own line, so an empty census never reads as "all current".
function emptyLines(result) {
  if (!result.inspected) return []
  const requested = result.profiles ?? []
  if (!requested.length) return result.sessions.length ? [] : ['no live session']
  const seen = new Set(result.sessions.map(session => session.profile))
  return requested.filter(profile => !seen.has(profile)).map(profile => printable(`no live session profile=${profile}`))
}

export function renderText(result) {
  return [summaryLine(result), ...result.sessions.map(sessionLine), ...emptyLines(result)].join('\n')
}

export function renderJson(result) {
  return {
    plugin: result.plugin, expect: result.expect, exitCode: result.exitCode, reason: result.reason,
    profiles: result.profiles ?? [],
    sessions: result.sessions.map(session => ({
      pid: session.pid, sessionId: session.sessionId, profile: session.profile, status: session.status,
      versions: session.versions, modules: [...new Set(session.modules.map(module => module.module))], reason: session.reason,
    })),
  }
}
