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
  return parseProcessRelationships(invoke.run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', PROCESS_TABLE_SCRIPT]))
}

export function readProcessSnapshot(invoke) {
  const script = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId,$_.ParentProcessId,$_.CommandLine }"
  const result = invoke.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  if (result.status !== 0) return { supported: false, processes: [], reason: 'process discovery unavailable on this platform' }
  const processes = String(result.stdout ?? '').split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), elapsedMs: null, command: match[3] }] : []
  })
  return { supported: true, processes }
}

export const resolveCanonicalPath = (invoke, input) => invoke.realpath(input)
export const endProcessFamily = (invoke, pid) => invoke.killTree(pid)
