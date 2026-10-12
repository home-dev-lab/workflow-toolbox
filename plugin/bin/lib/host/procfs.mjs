import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { posix } from 'node:path'

export const DEFAULT_PROC_ROOT = '/proc'
export const PROCFS_LOAD_SOURCE = '/proc/loadavg'

function requireProcfs(platform) {
  if (platform !== 'linux') {
    throw Object.assign(new Error(`procfs unavailable on ${platform}`), { code: 'PROCFS_UNAVAILABLE' })
  }
}

// The seam is below path construction: injected readers see the same paths and arguments
// as the real filesystem. Errors stay intact so a caller can distinguish exit races from
// unreadable evidence. No operation substitutes an empty listing or zero for unavailable.
export function createProcfs({
  root = DEFAULT_PROC_ROOT, platform = process.platform,
  readFile = readFileSync, readdir = readdirSync, readlink = readlinkSync,
  realpath = realpathSync, stat = statSync,
} = {}) {
  const invoke = (reader, parts, args) => {
    requireProcfs(platform)
    return reader(parts.length ? posix.join(root, ...parts) : root, ...args)
  }
  return Object.freeze({
    available: platform === 'linux',
    rootExists: () => invoke(existsSync, [], []),
    listProcesses: (...args) => invoke(readdir, [], args),
    processDirectoryStat: (pid, ...args) => invoke(stat, [String(pid)], args),
    readCommandLine: (pid, ...args) => invoke(readFile, [String(pid), 'cmdline'], args),
    readProcessStat: (pid, ...args) => invoke(readFile, [String(pid), 'stat'], args),
    readProcessStatus: (pid, ...args) => invoke(readFile, [String(pid), 'status'], args),
    readEnvironment: (pid, ...args) => invoke(readFile, [String(pid), 'environ'], args),
    readWorkingDirectory: (pid, ...args) => invoke(readlink, [String(pid), 'cwd'], args),
    resolveWorkingDirectory: (pid, ...args) => invoke(realpath, [String(pid), 'cwd'], args),
    listDescriptors: (pid, ...args) => invoke(readdir, [String(pid), 'fd'], args),
    readDescriptorTarget: (pid, fd, ...args) => invoke(readlink, [String(pid), 'fd', String(fd)], args),
    readDescriptorInfo: (pid, fd, ...args) => invoke(readFile, [String(pid), 'fdinfo', String(fd)], args),
    readUptime: (...args) => invoke(readFile, ['uptime'], args),
    readLoadAverage: (...args) => invoke(readFile, ['loadavg'], args),
  })
}

export function procfsProcessPresence(pid, options = {}) {
  const procfs = createProcfs(options)
  if (!procfs.available) return { status: 'unavailable' }
  try {
    procfs.processDirectoryStat(pid)
    return { status: 'present' }
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ESRCH'].includes(error?.code)) return { status: 'absent' }
    return { status: 'unknown', code: error?.code ?? 'read-failed' }
  }
}

// Nullable boolean for identity classifiers: unreadable is not authority to call a pid gone.
export function procfsProcessExists(pid, options = {}) {
  const { status } = procfsProcessPresence(pid, options)
  if (status === 'present') return true
  if (status === 'absent') return false
  return null
}

export function readProcfsProcessTable(options = {}) {
  const procfs = createProcfs(options)
  return { entries: procfs.listProcesses(), readCommandLine: procfs.readCommandLine }
}

export const hostProcfs = createProcfs()
