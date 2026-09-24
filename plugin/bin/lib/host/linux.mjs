import * as posix from './posix.mjs'

export const { endProcessFamily, parseProcessRelationships, processRelationshipOperation, processSnapshotOperation, readProcessRelationships, resolveCanonicalPath } = posix

export function readProcessSnapshot(invoke) {
  const processes = invoke.listProcesses?.()
  return Array.isArray(processes) ? { supported: true, processes } : posix.readProcessSnapshot(invoke)
}
