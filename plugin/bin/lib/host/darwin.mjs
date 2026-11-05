import { processSnapshotFailure } from './process-snapshot-failure.mjs'
import { elapsedSeconds } from './posix.mjs'

export { endProcessFamily, forceEndProcessFamily, parseProcessRelationships, processRelationshipOperation, readProcessRelationships, resolveCanonicalPath } from './posix.mjs'

const PROCESS_SNAPSHOT_ARGS = ['-axo', 'pid=,ppid=,lstart=,etime=,command=']
export const processSnapshotOperation = { command: 'ps', args: PROCESS_SNAPSHOT_ARGS }

export function readProcessSnapshot(invoke) {
  const result = invoke.run(processSnapshotOperation.command, processSnapshotOperation.args, { env: { ...process.env, LC_ALL: 'C' } })
  const failure = processSnapshotFailure(result, processSnapshotOperation.command)
  if (failure) return failure
  const processes = String(result.stdout ?? '').split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(\S+)\s+([\s\S]+?)\s*$/.exec(line)
    const startTime = match ? Date.parse(match[3]) : Number.NaN
    const elapsed = match ? elapsedSeconds(match[4]) : null
    return match && Number.isFinite(startTime) && elapsed !== null
      ? [{ pid: Number(match[1]), ppid: Number(match[2]), elapsedMs: elapsed * 1000, startTime, startIdentity: startTime, command: match[5] }]
      : []
  })
  const lines = String(result.stdout ?? '').split(/\r?\n/).filter((line) => line.trim())
  if (lines.length !== processes.length) return { supported: false, reason: 'ps snapshot contains unparseable process birth dates or rows' }
  return { supported: true, processes }
}
