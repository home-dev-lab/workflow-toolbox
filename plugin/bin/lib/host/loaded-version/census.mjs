// The process census the loaded-version check runs on: Linux /proc only, living rows only.
// A failure to read is never turned into an empty census: it raises a named reason instead.

const GONE_CODES = new Set(['ENOENT', 'ESRCH'])

export class UnjudgeableError extends Error {}

export const errorCode = error => error?.code ?? error?.message ?? 'read-failed'

function isGone(error) {
  return GONE_CODES.has(error?.code)
}

// Read a value; a process that exited mid-scan reads as `null`, any other failure throws `reason`.
export function readOrGone(read, reason) {
  try { return read() } catch (error) {
    if (isGone(error)) return null
    throw new UnjudgeableError(`${reason}: ${errorCode(error)}`)
  }
}

// Like readOrGone, but ENOENT counts as an exit only when the process directory is gone too:
// a live process can answer ENOENT for a path it holds that was deleted.
export function readLive(procfs, pid, read, reason) {
  try { return read() } catch (error) {
    if (!isGone(error)) throw new UnjudgeableError(`${reason}: ${errorCode(error)}`)
    if (readOrGone(() => procfs.processDirectoryStat(pid), reason) === null) return null
    throw new UnjudgeableError(`${reason}: ${errorCode(error)} while the process is still present`)
  }
}

export function parseStat(text) {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const fields = text.slice(close + 2).split(' ')
  return { comm: text.slice(open + 1, close), state: fields[0], ppid: fields[1] }
}

export function assertInspectable({ platform, procfs, selfPid }) {
  if (platform !== 'linux') throw new UnjudgeableError(`live-session inspection needs Linux /proc (platform ${platform})`)
  const self = readOrGone(() => procfs.readSelfLink(), '/proc/self unreadable')
  if (self !== String(selfPid)) {
    throw new UnjudgeableError(`foreign PID namespace: /proc/self names ${self ?? 'nothing'}, the reader is pid ${selfPid}`)
  }
}

function readRow(procfs, pid) {
  const owner = readOrGone(() => procfs.processDirectoryStat(pid).uid, `process ${pid} unreadable`)
  if (owner === null) return null
  const text = readLive(procfs, pid, () => procfs.readProcessStat(pid, 'utf8'), `stat of pid ${pid} unreadable`)
  if (text === null) return null
  const stat = parseStat(text)
  if (stat === null) throw new UnjudgeableError(`stat of pid ${pid} unparseable`)
  if (stat.state === 'Z' || stat.state === 'X') return null
  return { pid, comm: stat.comm, ppid: stat.ppid, uid: owner }
}

// The real uid from /proc/<pid>/status: a non-dumpable process's directory can read as root-owned.
export function realUid(procfs, pid) {
  const text = readLive(procfs, pid, () => procfs.readProcessStatus(pid, 'utf8'), `status of pid ${pid} unreadable`)
  if (text === null) return null
  const match = /^Uid:\s+(\d+)/m.exec(text)
  if (!match) throw new UnjudgeableError(`status of pid ${pid} has no Uid line`)
  return Number(match[1])
}

// rows: living processes (any owner: a non-dumpable child of a session can read as root-owned);
// children: ppid -> [pid]. Ownership is applied to sessions only, by the caller.
export function readCensus({ procfs }) {
  const names = readOrGone(() => procfs.listProcesses(), '/proc listing unreadable')
  if (names === null) throw new UnjudgeableError('/proc listing unreadable: ENOENT')
  const rows = new Map()
  const children = new Map()
  for (const pid of names.filter(name => /^\d+$/.test(name))) {
    const row = readRow(procfs, pid)
    if (row === null) continue
    rows.set(pid, row)
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), pid])
  }
  return { rows, children }
}
