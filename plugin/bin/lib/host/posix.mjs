const PROCESS_TABLE_ARGS = ['-axo', 'pid=,ppid=,pgid=,state=,etime=,comm=']

function elapsedSeconds(value) {
  const parts = value.split('-')
  const days = parts.length === 2 ? Number(parts[0]) : 0
  const clock = parts.at(-1).split(':').map(Number)
  if (clock.some((part) => !Number.isFinite(part))) return null
  const [hours, minutes, seconds] = clock.length === 3 ? clock : [0, ...clock]
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds
}

export function parseProcessRelationships(result) {
  if (result.status !== 0) return { status: 'unavailable', processes: [], reason: `process table command exited ${String(result.status)}` }
  const processes = String(result.stdout ?? '').split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
    if (!match) return []
    return [{ pid: Number(match[1]), parentPid: Number(match[2]), processGroupId: Number(match[3]), state: match[4], elapsedSeconds: elapsedSeconds(match[5]), executableName: match[6] }]
  })
  return { status: 'known', processes }
}

export function readProcessRelationships(invoke) {
  return parseProcessRelationships(invoke.run('ps', PROCESS_TABLE_ARGS, { env: { ...process.env, LC_ALL: 'C' } }))
}

export function readProcessSnapshot(invoke) {
  const result = invoke.run('ps', ['-eo', 'pid=,ppid=,etimes=,args='])
  if (result.status !== 0) return { supported: false, processes: [], reason: 'process discovery unavailable on this platform' }
  const processes = String(result.stdout ?? '').split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), elapsedMs: Number(match[3]) * 1000, command: match[4] }] : []
  })
  return { supported: true, processes }
}

export const resolveCanonicalPath = (invoke, input) => invoke.realpath(input)
export const endProcessFamily = (invoke, pid) => invoke.killGroup(pid)
