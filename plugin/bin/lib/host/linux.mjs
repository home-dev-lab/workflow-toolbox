import * as posix from './posix.mjs'
import { join } from 'node:path'

export const { endProcessFamily, parseProcessRelationships, processRelationshipOperation, processSnapshotOperation, readProcessRelationships, resolveCanonicalPath } = posix

export function readProcessSnapshot(invoke) {
  const snapshot = invoke.listProcesses?.()
  if (Array.isArray(snapshot)) return { supported: true, processes: snapshot }
  return snapshot && Array.isArray(snapshot.processes) ? { supported: true, ...snapshot } : posix.readProcessSnapshot(invoke)
}

export function readLinuxProcProcesses({ readFile, readDirectory, observedAt }) {
  let uptime
  try { uptime = Number(readFile('/proc/uptime', 'utf8').split(/\s+/)[0]) } catch { return null }
  const processes = []
  const unknownPids = []
  for (const entry of readDirectory('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    const pid = Number(entry.name)
    try {
      const firstStat = readFile(join('/proc', entry.name, 'stat'), 'utf8')
      const commandLine = readFile(join('/proc', entry.name, 'cmdline'), 'utf8').split('\0').filter(Boolean).join(' ')
      const secondStat = readFile(join('/proc', entry.name, 'stat'), 'utf8')
      const firstFields = firstStat.slice(firstStat.lastIndexOf(')') + 2).split(' ')
      const secondFields = secondStat.slice(secondStat.lastIndexOf(')') + 2).split(' ')
      const startTicks = Number(firstFields[19])
      if (!Number.isFinite(startTicks) || startTicks !== Number(secondFields[19])) {
        unknownPids.push(pid)
        continue
      }
      const command = commandLine || firstStat.slice(firstStat.indexOf('(') + 1, firstStat.lastIndexOf(')'))
      const startedAt = observedAt - Math.max(0, uptime - startTicks / 100) * 1000
      processes.push({ pid, ppid: Number(firstFields[1]), elapsedMs: Math.max(0, observedAt - startedAt), command })
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ESRCH') unknownPids.push(pid)
    }
  }
  return { processes, unknownPids }
}
