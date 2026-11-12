// The platform this process runs on, read once at the host boundary so callers can default to it without
// reaching `process.platform` themselves.
import { readFileSync } from 'node:fs'
import { uptime } from 'node:os'

export const hostPlatform = process.platform

export function readHostPlatform() { return process.platform }

export function suiteLockBootClock() {
  let bootId = null
  if (hostPlatform === 'linux') {
    try { bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null } catch { /* Wall-clock fallback when boot identity is unavailable. */ }
  }
  return { uptimeMs: uptime() * 1000, bootId }
}
