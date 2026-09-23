import { elapsedSeconds } from './posix.mjs'

export { endProcessFamily, forceEndProcessFamily, parseProcessRelationships, processRelationshipOperation, readProcessRelationships, resolveCanonicalPath } from './posix.mjs'

const PROCESS_SNAPSHOT_ARGS = ['-axo', 'pid=,ppid=,etime=,command=']
export const processSnapshotOperation = { command: 'ps', args: PROCESS_SNAPSHOT_ARGS }

export function readProcessSnapshot(invoke) {
  const result = invoke.run(processSnapshotOperation.command, processSnapshotOperation.args)
  if (result.status !== 0) return { supported: false, processes: [], reason: 'process discovery unavailable on this platform' }
  const processes = String(result.stdout ?? '').split(/\r?\n/).flatMap((line) => {
    const columns = line.trim().split(/\s+/)
    const elapsed = columns.length > 3 ? elapsedSeconds(columns[2]) : null
    return elapsed !== null ? [{ pid: Number(columns[0]), ppid: Number(columns[1]), elapsedMs: elapsed * 1000, command: columns.slice(3).join(' ') }] : []
  })
  return { supported: true, processes }
}
