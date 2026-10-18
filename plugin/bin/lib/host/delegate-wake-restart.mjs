// Epoch evidence, following the observe-identity per-platform probes. Never use
// os.uptime(): containers expose their host's uptime, not a session lifetime.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

function probe(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 3000,
      env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { return '' }
}

export function bootTime({ platform = process.platform, read = readFileSync, exec = probe } = {}) {
  try {
    return platformBootTime(platform, read, exec)
  } catch { /* inaccessible kernel evidence is unknown */ }
  return null
}

function platformBootTime(platform, read, exec) {
  if (platform === 'linux') return epoch(/^btime\s+(\d+)$/m.exec(read('/proc/stat', 'utf8'))?.[1])
  if (platform === 'darwin') return epoch(/\bsec\s*=\s*(\d+)/.exec(exec('sysctl', ['-n', 'kern.boottime']))?.[1])
  if (platform === 'win32') return epoch(exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '[DateTimeOffset]::new((Get-CimInstance Win32_OperatingSystem).LastBootUpTime).ToUnixTimeSeconds()']))
  return null
}

function epoch(value) {
  if (!/^\d+$/.test(value ?? '')) return null
  const ms = Number(value) * 1000
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null
}

export function sessionProcessStart({ platform = process.platform, pid = process.ppid, exec = probe } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null
  if (platform === 'win32') return epoch(exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `[DateTimeOffset]::new((Get-Process -Id ${pid}).StartTime).ToUnixTimeSeconds()`]))
  if (!['linux', 'darwin'].includes(platform)) return null
  return posixProcessStart(pid, exec)
}

function posixProcessStart(pid, exec) {
  const value = exec('ps', ['-p', String(pid), '-o', 'lstart='])
  if (!/^[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(value)) return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

export function restartEvidence(bootOverride, sessionOverride) {
  return { bootAt: evidence(bootOverride, bootTime), sessionStartedAt: evidence(sessionOverride, sessionProcessStart),
    bootReason: bootOverride === 'unknown' ? 'explicit unknown' : 'platform probe unavailable' }
}

function evidence(value, read) {
  if (value === undefined) return read()
  if (value === 'unknown') return null
  const at = Date.parse(value)
  if (!Number.isFinite(at)) throw new Error('restart time must be an ISO timestamp or unknown')
  return at
}
