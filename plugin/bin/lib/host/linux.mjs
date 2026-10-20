import * as posix from './posix.mjs'
import { join } from 'node:path'

export const { endProcessFamily, forceEndProcessFamily, parseProcessRelationships, processRelationshipOperation, processSnapshotOperation, readProcessRelationships, resolveCanonicalPath } = posix

export function readProcessSnapshot(invoke) {
  const snapshot = invoke.listProcesses?.()
  if (Array.isArray(snapshot)) return { supported: true, processes: snapshot }
  return snapshot && Array.isArray(snapshot.processes) ? { supported: true, ...snapshot } : posix.readProcessSnapshot(invoke)
}

// Keep native clock ticks: idle sampling compares counters without assuming a tick rate.
function processCpuTicks(fields, indexes = [11, 12, 13, 14]) {
  // Own CPU plus waited-for children: work can start and be reaped between polls.
  const counters = indexes.map((index) => fields[index])
  if (!counters.every((value) => /^\d+$/.test(value))) return null
  const ticks = counters.map(Number)
  const total = ticks.reduce((sum, value) => sum + value, 0)
  return ticks.every(Number.isSafeInteger) && Number.isSafeInteger(total) ? total : null
}

function readLinuxProcProcess(entry, pid, readFile, observedAt, uptime) {
  const firstStat = readFile(join('/proc', entry.name, 'stat'), 'utf8')
  const commandLine = readFile(join('/proc', entry.name, 'cmdline'), 'utf8').split('\0').filter(Boolean).join(' ')
  const secondStat = readFile(join('/proc', entry.name, 'stat'), 'utf8')
  const firstFields = firstStat.slice(firstStat.lastIndexOf(')') + 2).split(' ')
  const secondFields = secondStat.slice(secondStat.lastIndexOf(')') + 2).split(' ')
  const startTicks = Number(firstFields[19])
  if (!Number.isFinite(startTicks) || startTicks !== Number(secondFields[19])) return null
  const ppid = Number(secondFields[1])
  if (!/^\d+$/.test(secondFields[1]) || !Number.isSafeInteger(ppid)) return null
  const command = commandLine || firstStat.slice(firstStat.indexOf('(') + 1, firstStat.lastIndexOf(')'))
  const startedAt = observedAt - Math.max(0, uptime - startTicks / 100) * 1000
  return { pid, ppid, elapsedMs: Math.max(0, observedAt - startedAt), startTime: startedAt, startIdentity: startTicks, command, cpuTicks: processCpuTicks(secondFields), activityTicks: processCpuTicks(secondFields, [7, 8, 9, 10]) }
}

function unknownProcessRead(error) {
  return error?.code !== 'ENOENT' && error?.code !== 'ESRCH'
}

export function readLinuxIdleProcProcesses({ readFile, readDirectory, observedAt }) {
  let uptime
  try { uptime = Number(readFile('/proc/uptime', 'utf8').split(/\s+/)[0]) } catch { return null }
  const processes = []
  const unknownPids = []
  for (const entry of readDirectory('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    const pid = Number(entry.name)
    try {
      const row = readLinuxProcProcess(entry, pid, readFile, observedAt, uptime)
      if (row) processes.push(row)
      else unknownPids.push(pid)
    } catch (error) {
      if (unknownProcessRead(error)) unknownPids.push(pid)
    }
  }
  return { processes, unknownPids }
}

// Base timeout reader: idle-only validation and counters must never enter this channel.
export function readLinuxProcProcesses({ readFile, readDirectory, observedAt }) {
  let uptime
  try { uptime = Number(readFile('/proc/uptime', 'utf8').split(/\s+/)[0]) } catch { return null }
  const processes = []
  const unknownPids = []
  for (const entry of readDirectory('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    const pid = Number(entry.name)
    try {
      const row = readBaseLinuxProcProcess(entry, pid, readFile, observedAt, uptime)
      if (row) processes.push(row)
      else unknownPids.push(pid)
    } catch (error) {
      if (unknownProcessRead(error)) unknownPids.push(pid)
    }
  }
  return { processes, unknownPids }
}

function readBaseLinuxProcProcess(entry, pid, readFile, observedAt, uptime) {
  const firstStat = readFile(join('/proc', entry.name, 'stat'), 'utf8')
  const commandLine = readFile(join('/proc', entry.name, 'cmdline'), 'utf8').split('\0').filter(Boolean).join(' ')
  const secondStat = readFile(join('/proc', entry.name, 'stat'), 'utf8')
  const firstFields = firstStat.slice(firstStat.lastIndexOf(')') + 2).split(' ')
  const secondFields = secondStat.slice(secondStat.lastIndexOf(')') + 2).split(' ')
  const startTicks = Number(firstFields[19])
  if (!Number.isFinite(startTicks) || startTicks !== Number(secondFields[19])) return null
  const command = commandLine || firstStat.slice(firstStat.indexOf('(') + 1, firstStat.lastIndexOf(')'))
  const startedAt = observedAt - Math.max(0, uptime - startTicks / 100) * 1000
  return { pid, ppid: Number(firstFields[1]), elapsedMs: Math.max(0, observedAt - startedAt), startTime: startedAt, startIdentity: startTicks, command }
}
