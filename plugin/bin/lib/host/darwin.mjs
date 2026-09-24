import { elapsedSeconds } from './posix.mjs'

export { endProcessFamily, forceEndProcessFamily, parseProcessRelationships, processRelationshipOperation, readProcessRelationships, resolveCanonicalPath } from './posix.mjs'

const PROCESS_SNAPSHOT_ARGS = ['-axo', 'pid=,ppid=,lstart=,etime=,command=']
export const processSnapshotOperation = { command: 'ps', args: PROCESS_SNAPSHOT_ARGS }

export function readProcessSnapshot(invoke) {
  const result = invoke.run(processSnapshotOperation.command, processSnapshotOperation.args)
  if (result.status !== 0) return { supported: false, processes: [], reason: 'process discovery unavailable on this platform' }
  const processes = String(result.stdout ?? '').split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(\S+)\s+([\s\S]+?)\s*$/.exec(line)
    const startTime = match ? Date.parse(match[3]) : Number.NaN
    const elapsed = match ? elapsedSeconds(match[4]) : null
    return match && Number.isFinite(startTime) && elapsed !== null
      ? [{ pid: Number(match[1]), ppid: Number(match[2]), elapsedMs: elapsed * 1000, startTime, startIdentity: startTime, command: match[5] }]
      : []
  })
  return { supported: true, processes }
}
