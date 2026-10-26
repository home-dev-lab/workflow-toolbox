// Native I/O boundary for the advisory narrative split. Enforcement stays in
// the caller, including when these host operations are unavailable.
// We launch the trusted claude CLI, not a hostile executable sandbox: POSIX
// cleanup covers its process group, not descendants that leave that group.
// Windows cleanup targets the direct child only. These limits do not change the
// precomputed decision or the hook-level watchdog's independent exit path.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'

export const spawnNarrativeChild = spawn
export const narrativeChildCwd = () => os.tmpdir()

export function killNarrativeProcess(child, platform) {
  if (platform === 'win32') child.kill('SIGKILL')
  else if (child.pid) process.kill(-child.pid, 'SIGKILL')
}

export function readCurrentRuleText(file, tool) {
  if (tool !== 'Write') return null
  try { return fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null } catch { return null }
}

export function writeRuleDecision(output) {
  fs.writeSync(1, JSON.stringify({ hookSpecificOutput: { ...output, hookEventName: 'PreToolUse' } }))
}
