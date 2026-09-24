const PROCESS_TABLE_SCRIPT = [
  '$now = Get-Date',
  'Get-CimInstance Win32_Process | ForEach-Object {',
  '  [ordered]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId;',
  "    processGroup = [ordered]@{ status = 'unsupported'; nearestConcept = 'process tree rooted at a PID' };",
  "    state = if ($null -eq $_.ExecutionState) { 'not_reported' } else { [string]$_.ExecutionState };",
  '    elapsedSeconds = if ($null -eq $_.CreationDate) { $null } else { [math]::Round(($now - $_.CreationDate).TotalSeconds, 3) };',
  '    executableName = $_.Name }',
  '} | ConvertTo-Json -Depth 4 -Compress',
].join(' ')
const PROCESS_SNAPSHOT_SCRIPT = "$now = Get-Date; Get-CimInstance Win32_Process | ForEach-Object { $elapsed = if ($null -eq $_.CreationDate) { -1 } else { [math]::Round(($now - $_.CreationDate).TotalMilliseconds) }; $start = if ($null -eq $_.CreationDate) { -1 } else { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() }; '{0} {1} {2} {3} {4}' -f $_.ProcessId,$_.ParentProcessId,$elapsed,$start,$_.CommandLine }"
export const processRelationshipOperation = { command: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command', PROCESS_TABLE_SCRIPT] }
export const processSnapshotOperation = { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', PROCESS_SNAPSHOT_SCRIPT] }

export function parseProcessRelationships(result) {
  if (result.status !== 0) return { status: 'unavailable', processes: [], reason: `process table command exited ${String(result.status)}` }
  try {
    const parsed = String(result.stdout ?? '').trim() ? JSON.parse(result.stdout) : []
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    const processes = rows.map((row) => ({
      pid: Number(row.pid), parentPid: Number(row.ppid), processGroupId: null,
      state: String(row.state), elapsedSeconds: row.elapsedSeconds === null ? null : Number(row.elapsedSeconds),
      executableName: String(row.executableName),
    })).filter((row) => Number.isSafeInteger(row.pid) && Number.isSafeInteger(row.parentPid))
    return { status: 'known', processes }
  } catch {
    return { status: 'unavailable', processes: [], reason: 'process table output was not valid JSON' }
  }
}

export function readProcessRelationships(invoke) {
  return parseProcessRelationships(invoke.run(processRelationshipOperation.command, processRelationshipOperation.args))
}

export function readProcessSnapshot(invoke) {
  const result = invoke.run(processSnapshotOperation.command, processSnapshotOperation.args)
  if (result.status !== 0) return { supported: false, processes: [], reason: 'process discovery unavailable on this platform' }
  const processes = String(result.stdout ?? '').split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(.+)$/.exec(line)
    return match && Number(match[3]) >= 0 && Number(match[4]) >= 0
      ? [{ pid: Number(match[1]), ppid: Number(match[2]), elapsedMs: Number(match[3]), startTime: Number(match[4]), startIdentity: Number(match[4]), command: match[5] }]
      : []
  })
  return { supported: true, processes }
}

export const resolveCanonicalPath = (invoke, input) => invoke.realpath(input)
export const endProcessFamily = (invoke, pid) => invoke.killTree(pid, false)
export const forceEndProcessFamily = (invoke, pid) => invoke.killTree(pid, true)
