import { readlinkSync } from 'node:fs'
import { platform } from 'node:os'

import { outputPath, provenance, runToFile, writeEvidence } from './probe-lib.mjs'

const destination = outputPath('process-table')
const scratch = `${destination}.native`

const posixProcessTable = () => {
  const args = ['-axo', 'pid=,ppid=,pgid=,state=,etime=,comm=']
  return runToFile('ps', args, scratch)
}

const windowsProcessTable = () => {
  const script = [
    '$now = Get-Date',
    'Get-CimInstance Win32_Process | ForEach-Object {',
    '  [ordered]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId;',
    "    processGroup = [ordered]@{ status = 'unsupported'; nearestConcept = 'process tree rooted at a PID' };",
    "    state = if ($null -eq $_.ExecutionState) { 'not_reported' } else { [string]$_.ExecutionState };",
    '    elapsedSeconds = if ($null -eq $_.CreationDate) { $null } else { [math]::Round(($now - $_.CreationDate).TotalSeconds, 3) };',
    '    executableName = $_.Name }',
    '} | ConvertTo-Json -Depth 4 -Compress',
  ].join(' ')
  return runToFile('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], scratch)
}

const cwdQuestion = () => {
  if (platform() === 'linux') {
    try {
      return { question: 'Can PID map to current working directory?', status: 'answerable', mechanism: '/proc/<pid>/cwd', observation: readlinkSync(`/proc/${String(process.pid)}/cwd`) }
    } catch (error) {
      return { question: 'Can PID map to current working directory?', status: 'measurement_failed', mechanism: '/proc/<pid>/cwd', error: String(error.message) }
    }
  }
  if (platform() === 'darwin') {
    const result = runToFile('lsof', ['-a', '-p', String(process.pid), '-d', 'cwd', '-Fn'], `${scratch}.cwd`)
    return { question: 'Can PID map to current working directory?', status: result.exitCode === 0 && result.raw.includes('\nn') ? 'answerable' : 'measurement_failed', mechanism: 'lsof -d cwd', observation: result }
  }
  if (platform() === 'win32') {
    return { question: 'Can PID map to current working directory?', status: 'unsupported', mechanism: 'Win32_Process exposes ExecutablePath but not current working directory' }
  }
  return { question: 'Can PID map to current working directory?', status: 'unsupported', mechanism: `no probe defined for ${platform()}` }
}

const table = platform() === 'win32' ? windowsProcessTable() : posixProcessTable()
writeEvidence(destination, {
  provenance: provenance('process-table', table.command, `${scratch}.provenance`),
  disclosurePolicy: 'Executable names only. Command-line arguments are neither requested nor recorded.',
  columns: platform() === 'win32'
    ? ['pid', 'ppid', 'processGroup', 'state', 'elapsedSeconds', 'executableName']
    : ['pid', 'ppid', 'pgid', 'state', 'elapsed', 'executableName'],
  processTable: table,
  cwdQuestion: cwdQuestion(),
})
