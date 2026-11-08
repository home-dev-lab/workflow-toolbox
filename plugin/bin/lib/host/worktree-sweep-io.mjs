// Native report-sweep boundary, matching the other host filesystem facades.
// Re-exports preserve Node function identity, descriptor behavior and error shapes.
export { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync,
  readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
export { spawn, spawnSync } from 'node:child_process'
export { homedir } from 'node:os'

export function sweepPlatform() { return process.platform }
