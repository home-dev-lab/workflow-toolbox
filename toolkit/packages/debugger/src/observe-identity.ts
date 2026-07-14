// observe-identity.ts — the per-OS PID-identity probes (boot identity + process start
// stamp), EXTRACTED from observe-cli.ts so every writer of the ONE server pidfile (the
// `wt-observe` CLI and the Electron desktop shell) records identity through the SAME
// code — the recycled-pid guard's semantics must never drift between the two front doors.
// Impure edge (execFileSync / /proc reads); the pure output parsers stay in
// observe-lifecycle.ts (unit-tested there).
//
// Cross-OS (card #1813359570421023938): each OS gets a (boot identity, process start)
// pair that is stable for the machine/process lifetime. Values are only ever compared
// against values recorded on the SAME machine, so units never cross platforms.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parsePowershellInt, parsePsLstartEpochSec, parseSysctlBoottimeSec, type ObservePidfile } from './observe-lifecycle.js'

/** Short-timeout exec for identity probes — a hung probe must degrade (null → treated
 *  as identity-unknown, the safe direction), never wedge start/stop/status. */
function probeExec(cmd: string, args: readonly string[]): string | null {
  try {
    return execFileSync(cmd, args as string[], { encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

export function readBootId(): string | null {
  if (process.platform === 'darwin') {
    const out = probeExec('sysctl', ['-n', 'kern.boottime'])
    const sec = out !== null ? parseSysctlBoottimeSec(out) : null
    return sec !== null ? `boottime-${String(sec)}` : null
  }
  if (process.platform === 'win32') {
    const out = probeExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[DateTimeOffset]::new((Get-CimInstance Win32_OperatingSystem).LastBootUpTime).ToUnixTimeSeconds()'])
    const sec = out !== null ? parsePowershellInt(out) : null
    return sec !== null ? `boottime-${String(sec)}` : null
  }
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  } catch {
    return null
  }
}

/** Linux: /proc/<pid>/stat field 22 (starttime in clock ticks — robust to spaces in the
 *  comm field: parse AFTER the closing paren). darwin: ps lstart as epoch seconds.
 *  win32: Get-Process StartTime as unix seconds. Null when unreadable. */
export function readProcStartStamp(pid: number): number | null {
  if (process.platform === 'darwin') {
    const out = probeExec('ps', ['-p', String(pid), '-o', 'lstart='])
    return out !== null ? parsePsLstartEpochSec(out) : null
  }
  if (process.platform === 'win32') {
    const out = probeExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `[DateTimeOffset]::new((Get-Process -Id ${String(pid)}).StartTime).ToUnixTimeSeconds()`])
    return out !== null ? parsePowershellInt(out) : null
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const ticks = Number(rest[19]) // field 22 overall; fields 3.. after comm
    return Number.isFinite(ticks) ? ticks : null
  } catch {
    return null
  }
}

/** Is `pid` a live process this uid can signal? (`kill(pid, 0)` — no signal
 *  sent, just an existence+permission probe.) EXTRACTED from observe-cli.ts so
 *  the desktop shell's EADDRINUSE adoption gate consumes the SAME check the CLI
 *  start path already does (card #1815076918890857882 — Rule of Three: desktop
 *  is the 2nd consumer). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The recycled-pid guard: identity matches when the recorded boot-id AND start
 *  ticks both still describe pid. Unknown identity (nulls recorded, e.g. a
 *  probe that returned null) degrades to NOT matching — the safe direction
 *  (never signal ownership on a guess). Shared by the CLI and the desktop shell. */
export function pidIdentityMatches(pf: ObservePidfile): boolean {
  if (pf.bootId === null || pf.procStartTicks === null) return false
  return readBootId() === pf.bootId && readProcStartStamp(pf.pid) === pf.procStartTicks
}

/** The (alive, identity-still-matches) pair every pidfile decision needs — one
 *  home, so the CLI's start/stop paths and the desktop's adoption gate can
 *  never drift on how they read a pidfile's liveness. */
export function pidState(pf: ObservePidfile | null): { alive: boolean; idMatch: boolean } {
  const alive = pf !== null && pidAlive(pf.pid)
  return { alive, idMatch: pf !== null && alive && pidIdentityMatches(pf) }
}
