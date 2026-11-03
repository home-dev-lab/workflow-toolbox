import { readFileSync, readdirSync } from 'node:fs'

function processIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    if (!/^\d+$/.test(fields[19]) || !/^\d+$/.test(fields[2])) return undefined
    return { pid: Number(pid), start: fields[19], group: Number(fields[2]) }
  } catch { return undefined }
}

// Pin group members while the leader's birth identity still verifies. After the
// leader is reaped, a surviving pinned member keeps that PGID reserved by Linux.
export function captureTsGroup(backend) {
  if (process.platform !== 'linux' || !backend.child?.pid) return
  const leader = processIdentity(backend.child.pid)
  if (!leader || leader.group !== backend.child.pid) return
  backend.identity ??= leader
  if (leader.start !== backend.identity.start) return
  rememberGroupMembers(backend, leader)
}

function rememberGroupMembers(backend, leader) {
  let entries
  try { entries = readdirSync('/proc') } catch { return }
  const members = entries.filter(pid => /^\d+$/.test(pid)).map(processIdentity).filter(member => member?.group === leader.pid)
  if (processIdentity(leader.pid)?.start !== leader.start) return
  backend.members ??= new Map()
  for (const member of members) backend.members.set(member.pid, member.start)
}

export function readTsGroupOwnership(backend) {
  if (process.platform !== 'linux' || !backend.identity) return 'unknown'
  const pid = backend.child.pid, leader = processIdentity(pid)
  if (leader) return leader.start === backend.identity.start && leader.group === pid ? 'ours' : 'unknown'
  return orphanedGroupOwnership(backend, pid)
}

function orphanedGroupOwnership(backend, pid) {
  try { process.kill(-pid, 0) } catch (error) { return error.code === 'ESRCH' ? 'empty' : 'unknown' }
  for (const [memberPid, start] of backend.members ?? []) {
    const member = processIdentity(memberPid)
    if (member?.start === start && member.group === pid) return 'ours'
  }
  return 'unknown'
}

export function tsGroupOwnership(state, backend) {
  return (state.options.groupOwnership ?? readTsGroupOwnership)(backend)
}

// POSIX backends are session leaders; never signal an unverified reused group.
export function signalTsBackend(state, backend, signal) {
  try {
    if ((state.options.platform ?? process.platform) === 'win32') backend.child?.kill(signal)
    else signalOwnedGroup(state, backend, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') state.streams.stderr.write(`wt-tsls: backend group signal failed (${error.message}); descendant cleanup unknown\n`)
  }
}

function signalOwnedGroup(state, backend, signal) {
  if (!backend.child?.pid) return
  const ownership = tsGroupOwnership(state, backend)
  if (ownership === 'empty') return
  if (ownership !== 'ours') {
    // Our direct, unreaped ChildProcess cannot be a reused pid, so the leader is always safe to signal.
    state.streams.stderr.write('wt-tsls: backend group ownership unknown; signalling the leader only; descendant cleanup unknown\n')
    backend.child.kill(signal)
    return
  }
  ;(state.options.killGroup ?? process.kill)(-backend.child.pid, signal)
}

function forceTsStop(state, backend, closed) {
  if (state.backend !== backend || state.phase === 'closed' || backend.forced) return
  backend.forced = true
  backend.input.end()
  signalTsBackend(state, backend, 'SIGTERM')
  state.killTimer = setTimeout(() => {
    if (state.backend !== backend || state.phase === 'closed') return
    signalTsBackend(state, backend, 'SIGKILL')
    backend.killed = true
    backend.input.destroy(); backend.output.destroy()
    backend.child?.stdin.destroy(); backend.child?.stdout.destroy(); backend.child?.stderr.destroy()
    closed(state, backend, 0)
  }, 1000)
  // EOF and a normal leader close can leave no other referenced handles.
  // Keep this bounded cleanup alive until surviving group members get KILL.
}

export function cleanTsClosedGroup(state, backend, closed) {
  if (backend.killed) return false
  if (backend.forced) return true
  if ((state.options.platform ?? process.platform) === 'win32') return false
  if (tsGroupOwnership(state, backend) === 'empty') return false
  clearTimeout(state.stopTimer)
  forceTsStop(state, backend, closed)
  return true
}

export function superviseTsStop(state, closed) {
  const backend = state.backend
  captureTsGroup(backend)
  clearTimeout(state.idleTimer)
  state.stopTimer = setTimeout(() => forceTsStop(state, backend, closed), state.stopMs)
  state.stopTimer.unref()
}
